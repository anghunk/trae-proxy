/**
 * WorkBuddy 本地上游：通过桌面端 daemon 的 wbipc 通道反向代理出模型能力。
 *
 * WorkBuddy 不提供 API Key，登录凭据只存在桌面端进程内（凭据用 at-rest 密钥加密，
 * 密钥在系统钥匙串里，外部进程取不到）。但它留了一条合法的本地转发通道：
 * daemon 在 `~/.workbuddy/wbipc/` 暴露 Unix socket，其中 `wb.request` 的
 * `http.fetch` 方法在转发时会**自动注入 `Authorization` / `X-User-Id` 等凭据**。
 *
 * 因此本 provider 不再启动 CLI、也不需要登录：
 *   OpenAI /v1/chat/completions
 *     → wbipc `http.fetch`（daemon 注入登录态）
 *       → WorkBuddy 后端 `/v2/chat/completions`
 *
 * 上游返回的就是标准 OpenAI 兼容 SSE，因此流式可直接透传；非流式在本地聚合。
 *
 * @module trae-proxy/gateway/providers/workbuddy
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderRecord } from '../store.ts'
import type {
  ChatRequestContext,
  GatewayChatFailure,
  GatewayChatResult,
  GatewayModel,
  UpstreamProvider,
} from '../providers.ts'
import {
  WbipcConnection,
  defaultWorkbuddyConfigDir,
  readWbipcEndpoint,
} from './wbipc.ts'

/** WorkBuddy 后端的对话补全路径（相对 daemon 解析出的 baseUrl）。 */
const CHAT_PATH = '/v2/chat/completions'
/** 模型目录缓存时长。 */
const MODEL_CACHE_TTL_MS = 5 * 60_000
/** 上游要求必须流式；这里统一以流式请求，再按需在本地聚合。 */
const UPSTREAM_STREAM = true

export interface WorkbuddyProviderOptions {
  record: ProviderRecord
  logger?: (message: string, detail?: unknown) => void
}

/** 从桌面端产品配置里解析出的模型条目。 */
interface ModelEntry {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  /** 该模型支持的推理档位；用于修正 glm-5.1 这类必须显式指定的模型。 */
  supportedEfforts?: string[]
  /**
   * 未显式指定时使用的推理档位。
   *
   * 部分模型（如 glm-5.1）不列出 `supportedEfforts`，只给一个固定档位，
   * 但上游要求请求必须带 `reasoning_effort`，缺省会报 11150。
   */
  defaultEffort?: string
}

/** 产品配置里 `agents[].name === 'cli'` 的可用模型子集。 */
interface DesktopCatalog {
  /** 软件里实际可选的模型 id（与界面一致）。 */
  ids: string[]
  /** id → 元数据。 */
  meta: Map<string, ModelEntry>
}

export class WorkbuddyProvider implements UpstreamProvider {
  readonly id: string
  private readonly record: ProviderRecord
  private readonly logger?: (message: string, detail?: unknown) => void
  private readonly configDir: string
  private connection: WbipcConnection | undefined
  private connectionPromise: Promise<WbipcConnection> | undefined
  private modelCache: { at: number; models: GatewayModel[] } | undefined

  constructor(options: WorkbuddyProviderOptions) {
    this.id = options.record.id
    this.record = options.record
    this.logger = options.logger
    const settings = parseSettings(options.record.settings)
    this.configDir = typeof settings['configDir'] === 'string' && settings['configDir'] !== ''
      ? settings['configDir']
      : defaultWorkbuddyConfigDir()
  }

  /**
   * 返回软件里可选的模型目录。
   *
   * @returns 与 WorkBuddy 客户端「模型选择」一致的模型列表。
   */
  async listModels(): Promise<GatewayModel[]> {
    const cached = this.modelCache
    if (cached !== undefined && Date.now() - cached.at < MODEL_CACHE_TTL_MS && cached.models.length > 0) {
      return cached.models
    }
    return this.refreshModels()
  }

  /** 绕过缓存重新读取模型目录。 */
  async refreshModels(): Promise<GatewayModel[]> {
    const catalog = readDesktopCatalog(this.configDir)
    const models = catalog.ids
      .map(id => catalog.meta.get(id))
      .filter((entry): entry is ModelEntry => entry !== undefined)
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
        ...entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens },
      }))
    if (models.length === 0) {
      throw new Error('未能从 WorkBuddy 配置中读取模型目录，请确认桌面端已登录并至少启动过一次')
    }
    this.modelCache = { at: Date.now(), models }
    return models
  }

  /**
   * 执行一次对话。
   *
   * @param bodyJson OpenAI chat/completions 请求体（model 已去掉 provider 前缀）。
   * @param signal 调用方中断信号。
   * @returns 流式时透传上游 SSE；非流式时返回聚合后的 JSON。
   */
  async chat(
    bodyJson: string,
    signal?: AbortSignal,
    context?: ChatRequestContext,
  ): Promise<GatewayChatResult | GatewayChatFailure> {
    let input: Record<string, unknown>
    try {
      input = JSON.parse(bodyJson) as Record<string, unknown>
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
    }
    const model = typeof input['model'] === 'string' ? input['model'] : ''
    if (model === '') return { ok: false, status: 400, kind: 'client', message: '缺少 model' }
    const messages = Array.isArray(input['messages']) ? input['messages'] : []
    if (messages.length === 0) return { ok: false, status: 400, kind: 'client', message: 'messages 不能为空' }

    const wantsStream = input['stream'] === true
    const catalog = readDesktopCatalog(this.configDir)
    const upstreamBody = buildUpstreamBody(input, catalog.meta.get(model))

    let upstream: Awaited<ReturnType<WbipcConnection['fetch']>>
    try {
      upstream = await this.requestWithReconnect(upstreamBody, signal)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const kind = classifyFailureText(message)
      return { ok: false, status: kind === 'authentication' ? 401 : 503, kind, message }
    }

    if (upstream.status !== 200) {
      const text = upstream.body.toString('utf8')
      this.logger?.('workbuddy upstream rejected', { providerId: this.id, status: upstream.status, body: text.slice(0, 2048) })
      const kind = classifyStatus(upstream.status, text)
      return {
        ok: false,
        status: upstream.status,
        kind,
        message: readUpstreamError(text) ?? `WorkBuddy 上游返回 HTTP ${upstream.status}`,
      }
    }

    const sse = upstream.body.toString('utf8')
    if (wantsStream) {
      return {
        ok: true,
        response: new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        ...usageFromSse(sse) === undefined ? {} : { usage: usageFromSse(sse) },
      }
    }
    const aggregated = aggregateSse(sse, model, context?.sessionId)
    if (aggregated === undefined) {
      return { ok: false, status: 502, kind: 'server', message: 'WorkBuddy 上游返回了无法解析的响应' }
    }
    return {
      ok: true,
      response: new Response(JSON.stringify(aggregated.json), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      ...aggregated.usage === undefined ? {} : { usage: aggregated.usage },
    }
  }

  /** 面向管理台的运行状态。 */
  status(): Promise<unknown> {
    const endpoint = readWbipcEndpoint(this.configDir)
    return Promise.resolve({
      mode: 'wbipc',
      configDir: this.configDir,
      channel: endpoint === undefined ? 'unavailable' : 'ready',
      connected: this.connection !== undefined,
      models: this.modelCache?.models.length ?? 0,
    })
  }

  /** 断开与 daemon 的 wbipc 连接。 */
  close(): void {
    this.connection?.destroy()
    this.connection = undefined
    this.connectionPromise = undefined
  }

  /**
   * 发起一次上游请求；连接失效（daemon 重启会换 socket 与 ticket）时重建后重试一次。
   *
   * @param body 已构造好的上游请求体。
   * @param signal 中断信号。
   */
  private async requestWithReconnect(body: string, signal?: AbortSignal) {
    const first = await this.resolveConnection(signal)
    try {
      return await first.fetch({
        method: 'POST',
        path: CHAT_PATH,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      this.logger?.('workbuddy wbipc call failed, reconnecting', { providerId: this.id, error: String(error) })
      this.close()
      const retry = await this.resolveConnection(signal)
      return retry.fetch({
        method: 'POST',
        path: CHAT_PATH,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body,
        ...signal === undefined ? {} : { signal },
      })
    }
  }

  /** 复用一条已握手的连接；端点失效时重建。 */
  private resolveConnection(signal?: AbortSignal): Promise<WbipcConnection> {
    if (this.connection !== undefined) return Promise.resolve(this.connection)
    if (this.connectionPromise !== undefined) return this.connectionPromise
    const endpoint = readWbipcEndpoint(this.configDir)
    if (endpoint === undefined) {
      return Promise.reject(new Error(
        `未找到 WorkBuddy 的本地转发通道（${join(this.configDir, 'wbipc', 'endpoint.json')}），请确认 WorkBuddy 桌面端正在运行`,
      ))
    }
    this.connectionPromise = WbipcConnection.open(endpoint, signal)
      .then(connection => {
        this.connection = connection
        return connection
      })
      .finally(() => {
        this.connectionPromise = undefined
      })
    return this.connectionPromise
  }
}

/**
 * 构造上游请求体。
 *
 * 上游只支持流式，因此强制 `stream: true` 并要求在末帧返回 usage。
 *
 * 另外部分模型（如 `glm-5.1`）要求请求必须携带 `reasoning_effort`，缺省会被
 * 上游以 11150 拒绝。这里按目录元数据补齐：优先保留调用方的合法取值，其次用
 * 模型声明的默认档位，最后在 `supportedEfforts` 里挑一个。
 */
function buildUpstreamBody(input: Record<string, unknown>, meta: ModelEntry | undefined): string {
  const body: Record<string, unknown> = { ...input, stream: UPSTREAM_STREAM }
  delete body['stream_options']
  body['stream_options'] = { include_usage: true }
  const requested = body['reasoning_effort']
  const efforts = meta?.supportedEfforts ?? []
  const allowed = typeof requested === 'string' && efforts.includes(requested)
  if (!allowed) {
    const fallback = resolveEffort(meta)
    if (fallback === undefined) delete body['reasoning_effort']
    else body['reasoning_effort'] = fallback
  }
  return JSON.stringify(body)
}

/** 依据模型元数据挑一个可用的推理档位。 */
function resolveEffort(meta: ModelEntry | undefined): string | undefined {
  if (meta === undefined) return undefined
  const efforts = meta.supportedEfforts ?? []
  if (meta.defaultEffort !== undefined && (efforts.length === 0 || efforts.includes(meta.defaultEffort))) {
    return meta.defaultEffort
  }
  if (efforts.includes('medium')) return 'medium'
  return efforts[0]
}

/** wbipc `http.fetch` 返回体的解析结果。 */
interface AggregatedSse {
  json: Record<string, unknown>
  usage?: { requestTokens?: number; responseTokens?: number; totalTokens?: number }
}

/**
 * 把上游 OpenAI 兼容 SSE 聚合为一份 chat.completion。
 *
 * 上游拒绝非流式请求（code 11101），所以非流式客户端由网关在本地聚合。
 * 思考内容归入 `reasoning_content`，与上游 delta 的字段保持一致。
 */
function aggregateSse(sse: string, model: string, sessionId?: string): AggregatedSse | undefined {
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let id = ''
  let created = 0
  let sawChunk = false
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let totalTokens: number | undefined
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>()

  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    sawChunk = true
    if (typeof event['id'] === 'string') id = event['id']
    if (typeof event['created'] === 'number') created = event['created']
    const usage = event['usage']
    if (typeof usage === 'object' && usage !== null) {
      const record = usage as Record<string, unknown>
      if (typeof record['prompt_tokens'] === 'number') promptTokens = record['prompt_tokens']
      if (typeof record['completion_tokens'] === 'number') completionTokens = record['completion_tokens']
      if (typeof record['total_tokens'] === 'number') totalTokens = record['total_tokens']
    }
    const choices = Array.isArray(event['choices']) ? event['choices'] : []
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue
      const record = choice as Record<string, unknown>
      if (typeof record['finish_reason'] === 'string' && record['finish_reason'] !== '') {
        finishReason = mapFinishReason(record['finish_reason'])
      }
      const delta = record['delta']
      if (typeof delta !== 'object' || delta === null) continue
      const deltaRecord = delta as Record<string, unknown>
      if (typeof deltaRecord['content'] === 'string') content += deltaRecord['content']
      if (typeof deltaRecord['reasoning_content'] === 'string') reasoning += deltaRecord['reasoning_content']
      const calls = Array.isArray(deltaRecord['tool_calls']) ? deltaRecord['tool_calls'] : []
      for (const call of calls) {
        if (typeof call !== 'object' || call === null) continue
        const callRecord = call as Record<string, unknown>
        const index = typeof callRecord['index'] === 'number' ? callRecord['index'] : toolCalls.size
        const current = toolCalls.get(index) ?? { arguments: '' }
        if (typeof callRecord['id'] === 'string') current.id = callRecord['id']
        const fn = callRecord['function']
        if (typeof fn === 'object' && fn !== null) {
          const fnRecord = fn as Record<string, unknown>
          if (typeof fnRecord['name'] === 'string' && fnRecord['name'] !== '') current.name = fnRecord['name']
          if (typeof fnRecord['arguments'] === 'string') current.arguments += fnRecord['arguments']
        }
        toolCalls.set(index, current)
      }
    }
  }
  if (!sawChunk) return undefined

  const message: Record<string, unknown> = { role: 'assistant', content }
  if (reasoning !== '') message['reasoning_content'] = reasoning
  if (toolCalls.size > 0) {
    message['tool_calls'] = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        index,
        ...call.id === undefined ? {} : { id: call.id },
        type: 'function',
        function: { name: call.name ?? '', arguments: call.arguments },
      }))
    if (finishReason === 'stop') finishReason = 'tool_calls'
  }
  const json: Record<string, unknown> = {
    id: id === '' ? `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}` : id,
    object: 'chat.completion',
    created: created === 0 ? Math.floor(Date.now() / 1000) : created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...promptTokens === undefined && completionTokens === undefined && totalTokens === undefined
      ? {}
      : {
          usage: {
            ...promptTokens === undefined ? {} : { prompt_tokens: promptTokens },
            ...completionTokens === undefined ? {} : { completion_tokens: completionTokens },
            ...totalTokens === undefined ? {} : { total_tokens: totalTokens },
          },
        },
  }
  return {
    json,
    ...promptTokens === undefined && completionTokens === undefined && totalTokens === undefined
      ? {}
      : {
          usage: {
            ...promptTokens === undefined ? {} : { requestTokens: promptTokens },
            ...completionTokens === undefined ? {} : { responseTokens: completionTokens },
            ...totalTokens === undefined ? {} : { totalTokens },
          },
        },
  }
}

/** 从 SSE 末帧解析网关用量字段。 */
function usageFromSse(sse: string): { requestTokens?: number; responseTokens?: number; totalTokens?: number } | undefined {
  let latest: { requestTokens?: number; responseTokens?: number; totalTokens?: number } | undefined
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    try {
      const event = JSON.parse(data) as Record<string, unknown>
      const usage = event['usage']
      if (typeof usage !== 'object' || usage === null) continue
      const record = usage as Record<string, unknown>
      latest = {
        ...typeof record['prompt_tokens'] === 'number' ? { requestTokens: record['prompt_tokens'] } : {},
        ...typeof record['completion_tokens'] === 'number' ? { responseTokens: record['completion_tokens'] } : {},
        ...typeof record['total_tokens'] === 'number' ? { totalTokens: record['total_tokens'] } : {},
      }
    } catch {
      // 忽略无法解析的行
    }
  }
  return latest
}

/** 上游 finish_reason → OpenAI finish_reason。 */
function mapFinishReason(value: string): string {
  if (value === 'tool_calls' || value === 'tool_use') return 'tool_calls'
  if (value === 'length' || value === 'max_tokens') return 'length'
  if (value === 'content_filter') return 'content_filter'
  return 'stop'
}

/** 从上游错误正文里取出可读信息。 */
function readUpstreamError(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const message = typeof parsed['msg'] === 'string' ? parsed['msg'] : undefined
    const code = typeof parsed['code'] === 'number' ? parsed['code'] : undefined
    if (message !== undefined) return code === undefined ? message : `${message}（code ${code}）`
  } catch {
    // 非 JSON 错误正文按原文处理
  }
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, 300)
}

function classifyStatus(status: number, text: string): GatewayChatFailure['kind'] {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  if (status === 404) return 'not_found'
  if (status === 429) return 'soft_rate'
  const lower = text.toLowerCase()
  if (lower.includes('quota') || lower.includes('credit')) return 'hard_credit'
  if (status >= 500) return 'server'
  return 'client'
}

/** 依据错误文本推断失败类别（用于连接层失败）。 */
function classifyFailureText(text: string): GatewayChatFailure['kind'] {
  // 桌面端没运行 → 本地通道不存在，属于「渠道不可用」而非凭据问题。
  if (/未找到 WorkBuddy 的本地转发通道|endpoint\.json/.test(text)) return 'unconfigured'
  if (/authentication|not logged in|unauthori[sz]ed|登录/i.test(text)) return 'authentication'
  return 'server'
}

/** 解析 provider 的 settings。 */
function parseSettings(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 非法 settings 视为空配置
  }
  return {}
}

/**
 * 读取桌面端的产品配置，得到「软件里可选的模型」。
 *
 * CLI/桌面端会把服务端下发的运行时配置写进 `local_storage/*.info`，其中
 * `agents[name=cli].models` 就是客户端模型下拉框的数据源；`models[]` 则带有
 * 上下文窗口与受支持的推理档位。两者合并后即为本渠道暴露的目录。
 *
 * @param configDir WorkBuddy 配置目录（如 `~/.workbuddy`）。
 */
function readDesktopCatalog(configDir: string): DesktopCatalog {
  const meta = new Map<string, ModelEntry>()
  const dirs = [join(configDir, 'local_storage')]
  for (const dir of dirs) {
    for (const data of collectConfigData(dir)) {
      const models = Array.isArray(data['models']) ? data['models'] : []
      for (const raw of models) {
        const entry = modelEntry(raw)
        if (entry !== undefined) meta.set(entry.id, entry)
      }
      const agents = Array.isArray(data['agents']) ? data['agents'] : []
      for (const raw of agents) {
        if (typeof raw !== 'object' || raw === null) continue
        const agent = raw as Record<string, unknown>
        if (agent['name'] !== 'cli') continue
        const ids = Array.isArray(agent['models'])
          ? agent['models'].filter((id): id is string => typeof id === 'string' && id !== '')
          : []
        if (ids.length > 0) return { ids, meta }
      }
    }
  }
  return { ids: [], meta }
}

/** 收集 `local_storage` 下所有有效配置的 `data` 段（按修改时间新到旧）。 */
function collectConfigData(dir: string): Array<Record<string, unknown>> {
  let files: string[]
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.info'))
  } catch {
    return []
  }
  const ordered = files
    .map(name => ({ name, mtime: safeMtime(join(dir, name)) }))
    .sort((left, right) => right.mtime - left.mtime)
  const result: Array<Record<string, unknown>> = []
  for (const file of ordered) {
    let raw: string
    try {
      raw = readFileSync(join(dir, file.name), 'utf8').trim()
    } catch {
      continue
    }
    if (!raw.startsWith('[')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const data = (item as Record<string, unknown>)['data']
      if (typeof data !== 'object' || data === null) continue
      result.push(data as Record<string, unknown>)
    }
  }
  return result
}

/** 把产品配置里的一条模型定义转为 ModelEntry。 */
function modelEntry(raw: unknown): ModelEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return undefined
  const reasoning = typeof record['reasoning'] === 'object' && record['reasoning'] !== null
    ? record['reasoning'] as Record<string, unknown>
    : {}
  const efforts = Array.isArray(reasoning['supportedEfforts'])
    ? reasoning['supportedEfforts'].filter((value): value is string => typeof value === 'string' && value !== '')
    : undefined
  // 有些模型只声明固定档位（如 glm-5.1 的 effort: "medium"），没有 supportedEfforts。
  const defaultEffort = typeof reasoning['defaultEffort'] === 'string' && reasoning['defaultEffort'] !== ''
    ? reasoning['defaultEffort']
    : typeof reasoning['effort'] === 'string' && reasoning['effort'] !== '' ? reasoning['effort'] : undefined
  const contextWindow = typeof record['maxInputTokens'] === 'number' ? record['maxInputTokens'] : undefined
  const maxTokens = typeof record['maxOutputTokens'] === 'number' ? record['maxOutputTokens'] : undefined
  return {
    id,
    name: typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : id,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...efforts === undefined || efforts.length === 0 ? {} : { supportedEfforts: efforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}
