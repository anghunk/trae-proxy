/**
 * WorkBuddy 上游：复用登录态直连 WorkBuddy 官方对话接口。
 *
 * 早先的实现走桌面端 daemon 的 wbipc `http.fetch`。那条通道是 call 型 RPC，
 * 宿主硬编码 50s 超时且 v1 协议没有 stream 方法，长回答必然被掐断。现在改为
 * 持有 WorkBuddy 登录态直连 `copilot.tencent.com/v2`，做真正的 SSE 流式转发。
 *
 * 登录态来源按优先级：
 *   1. 管理台里完成过一次浏览器 OAuth（推荐，可自动刷新）；
 *   2. 本机其它客户端（magpie / OpenCode）保存的 WorkBuddy 登录态
 *      （仅取 access token，不碰一次性 refresh token）。
 *
 * @module trae-proxy/gateway/providers/workbuddy
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR, type ProviderRecord } from '../store.ts'
import type {
  ChatRequestContext,
  GatewayChatFailure,
  GatewayChatResult,
  GatewayModel,
  UpstreamProvider,
} from '../providers.ts'
import {
  WORKBUDDY_API,
  WorkbuddyApiError,
  WorkbuddyCredentialStore,
  buildWorkbuddyHeaders,
  describeCredential,
  fetchWorkbuddyConfig,
  pollWorkbuddyLogin,
  startWorkbuddyLogin,
  type WorkbuddyCredential,
} from './workbuddy-auth.ts'
import {
  normalizeWorkbuddyRequest,
  restoreToolNames,
  type NormalizedRequest,
} from './workbuddy-request.ts'

/** 对话补全路径（`WORKBUDDY_API` 已含 `/v2` 前缀）。 */
const CHAT_PATH = '/chat/completions'
/** 本机目录兜底缓存时长。 */
const LOCAL_CACHE_TTL_MS = 60_000
/** 上游目录缓存时长。 */
const MODEL_CACHE_TTL_MS = 5 * 60_000
/** 默认请求超时：流式长回答需要给足时间。 */
const DEFAULT_TIMEOUT_MS = 10 * 60_000
/** 部分模型的兜底推理档位（上游要求必须显式指定）。 */
const FALLBACK_REASONING_MODELS: Readonly<Record<string, string>> = {
  'glm-5.1': 'medium',
  'glm-5v-turbo': 'medium',
  'minimax-m3': 'medium',
  'kimi-k2.7': 'medium',
  'kimi-k2.6': 'medium',
  mimo: 'high',
}

export interface WorkbuddyProviderOptions {
  record: ProviderRecord
  logger?: (message: string, detail?: unknown) => void
  /** 登录态文件路径；默认放在 `config/workbuddy-<id>.json`。 */
  credentialPath?: string
}

/** 从上游 / 本地配置解析出的模型条目。 */
interface ModelEntry {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  /** 未显式指定时使用的推理档位。 */
  defaultEffort?: string
}

/** 产品配置里 `agents[name=cli].models` 的可用模型子集。 */
interface DesktopCatalog {
  ids: string[]
  meta: Map<string, ModelEntry>
}

/** 浏览器登录的中间状态（按 provider 保存，跨实例存活）。 */
const pendingLogins = new Map<string, string>()

/** 管理台可用的登录态操作。 */
export interface WorkbuddySessionApi {
  /** 当前登录态摘要。 */
  sessionStatus(): Promise<ReturnType<typeof describeCredential>>
  /** 发起浏览器登录，返回需要用户打开的地址。 */
  startLogin(): Promise<{ url: string }>
  /** 轮询登录结果；成功后写入凭据文件。 */
  pollLogin(): Promise<{ status: 'pending' | 'done' | 'failed'; accountId?: string; error?: string }>
  /** 清除登录态。 */
  signOut(): Promise<void>
}

export class WorkbuddyProvider implements UpstreamProvider {
  readonly id: string
  private readonly record: ProviderRecord
  private readonly logger?: (message: string, detail?: unknown) => void
  private readonly credentials: WorkbuddyCredentialStore
  private modelCache: { at: number; models: GatewayModel[] } | undefined
  private localCache: { at: number; catalog: DesktopCatalog } | undefined
  /** 模型 id → 元数据；上游目录与本地配置都会写入，用于补齐推理档位。 */
  private readonly modelMeta = new Map<string, ModelEntry>()

  constructor(options: WorkbuddyProviderOptions) {
    this.id = options.record.id
    this.record = options.record
    this.logger = options.logger
    const settings = parseSettings(options.record.settings)
    const configured = typeof settings['credentialPath'] === 'string' && settings['credentialPath'] !== ''
      ? settings['credentialPath']
      : undefined
    this.credentials = new WorkbuddyCredentialStore(
      options.credentialPath ?? configured ?? defaultCredentialPath(this.id),
      options.logger,
    )
  }

  /**
   * 返回 WorkBuddy 的可用模型目录。
   *
   * 优先问上游 `/v3/config`（需要登录态）；未登录时退回桌面端本地配置，
   * 保证渠道在没有登录前也能显示模型。
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
    const live = await this.fetchLiveModels()
    const models = live.length > 0 ? live : this.localModels()
    if (models.length === 0) {
      throw new Error('未能获取 WorkBuddy 模型目录，请先在管理台完成一次 WorkBuddy 登录')
    }
    this.modelCache = { at: Date.now(), models }
    return models
  }

  /**
   * 执行一次对话。
   *
   * 上游只支持流式，因此始终以流式请求；入站为 `stream:false` 时由网关
   * 侧统一聚合（见 server.ts 的 aggregateChatSse）。
   */
  async chat(
    bodyJson: string,
    signal?: AbortSignal,
    context?: ChatRequestContext,
  ): Promise<GatewayChatResult | GatewayChatFailure> {
    let input: Record<string, unknown>
    try {
      const parsed = JSON.parse(bodyJson) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
      }
      input = parsed as Record<string, unknown>
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
    }
    const model = typeof input['model'] === 'string' ? input['model'] : ''
    if (model === '') return { ok: false, status: 400, kind: 'client', message: '缺少 model' }
    const messages = Array.isArray(input['messages']) ? input['messages'] : []
    if (messages.length === 0) return { ok: false, status: 400, kind: 'client', message: 'messages 不能为空' }

    // 冷启动时上游目录还没拉过，先用本地配置补齐推理档位
    this.localCatalog()
    const entry = this.modelMeta.get(model)
    const normalized = normalizeWorkbuddyRequest(
      bodyJson,
      entry?.defaultEffort ?? fallbackEffort(model),
      context?.sessionId,
    )
    let credential: WorkbuddyCredential
    try {
      credential = await this.credentials.ensure(signal)
    } catch (error: unknown) {
      return {
        ok: false,
        status: error instanceof WorkbuddyApiError && error.status === 401 ? 401 : 503,
        kind: 'authentication',
        message: error instanceof Error ? error.message : String(error),
      }
    }

    let response = await this.send(credential, normalized, signal)
    if (response instanceof Error) {
      return { ok: false, status: 0, kind: 'server', message: response.message }
    }
    // access token 可能已被服务端提前作废：强制刷新一次再试
    if (response.status === 401) {
      const refreshed = await this.forceRefresh(credential, signal)
      if (refreshed !== undefined) {
        await response.body?.cancel().catch(() => undefined)
        response = await this.send(refreshed, normalized, signal)
        if (response instanceof Error) {
          return { ok: false, status: 0, kind: 'server', message: response.message }
        }
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      this.logger?.('workbuddy upstream rejected', {
        providerId: this.id,
        status: response.status,
        body: text.slice(0, 2048),
      })
      return {
        ok: false,
        status: response.status,
        kind: classifyStatus(response.status, text),
        message: readUpstreamError(text) ?? `WorkBuddy 上游返回 HTTP ${response.status}`,
      }
    }
    return {
      ok: true,
      response: restoreToolNames(response, normalized.toolNames),
    }
  }

  /** 面向管理台的运行状态。 */
  status(): Promise<unknown> {
    const session = describeCredential(this.credentials.load())
    return Promise.resolve({
      mode: 'direct',
      endpoint: WORKBUDDY_API,
      models: this.modelCache?.models.length ?? 0,
      ...session,
    })
  }

  /** 管理台：当前登录态摘要。 */
  async sessionStatus(): Promise<ReturnType<typeof describeCredential>> {
    return describeCredential(this.credentials.load())
  }

  /** 管理台：发起浏览器登录。 */
  async startLogin(): Promise<{ url: string }> {
    const started = await startWorkbuddyLogin()
    pendingLogins.set(this.id, started.state)
    return { url: started.url }
  }

  /** 管理台：轮询一次登录结果。 */
  async pollLogin(): Promise<{ status: 'pending' | 'done' | 'failed'; accountId?: string; error?: string }> {
    const state = pendingLogins.get(this.id)
    if (state === undefined) return { status: 'failed', error: '登录会话已失效，请重新发起登录' }
    const result = await pollWorkbuddyLogin(state)
    if (result.status === 'pending') return { status: 'pending' }
    if (result.status === 'failed') {
      pendingLogins.delete(this.id)
      return result
    }
    pendingLogins.delete(this.id)
    this.credentials.save(result.credential)
    this.modelCache = undefined
    this.logger?.('workbuddy 登录成功', { providerId: this.id, accountId: result.credential.accountId })
    return { status: 'done', accountId: result.credential.accountId }
  }

  /** 管理台：清除登录态。 */
  async signOut(): Promise<void> {
    pendingLogins.delete(this.id)
    this.credentials.clear()
    this.modelCache = undefined
  }

  /**
   * 释放资源。
   *
   * 本 provider 没有长连接；`pendingLogins` 是模块级共享的登录会话，
   * 实例被热替换时不能清掉，否则进行中的登录轮询会失效。
   */
  close(): void {}

  /** 强制刷新一次登录态，失败时返回 undefined。 */
  private async forceRefresh(
    credential: WorkbuddyCredential,
    signal?: AbortSignal,
  ): Promise<WorkbuddyCredential | undefined> {
    if (credential.refresh === undefined || credential.refresh === '') return undefined
    try {
      const next = await this.credentials.saveRefreshed(credential, signal)
      this.logger?.('workbuddy 收到 401，已强制刷新登录态', { providerId: this.id })
      return next
    } catch (error: unknown) {
      this.logger?.('workbuddy 强制刷新登录态失败', String(error))
      return undefined
    }
  }

  /** 发起一次上游请求；网络错误以 Error 形式返回。 */
  private async send(
    credential: WorkbuddyCredential,
    normalized: NormalizedRequest,
    signal: AbortSignal | undefined,
  ): Promise<Response | Error> {
    const messageId = randomUUID().replaceAll('-', '')
    const headers = buildWorkbuddyHeaders(credential, {
      ...normalized.turn.conversationId === undefined ? {} : { conversationId: normalized.turn.conversationId },
      messageId,
      requestId: normalized.turn.requestId,
    })
    const timeout = this.record.timeoutMs !== undefined && this.record.timeoutMs > 0
      ? this.record.timeoutMs
      : DEFAULT_TIMEOUT_MS
    try {
      return await fetch(`${WORKBUDDY_API}${CHAT_PATH}`, {
        method: 'POST',
        headers,
        body: normalized.body,
        signal: signal ?? AbortSignal.timeout(timeout),
      })
    } catch (error: unknown) {
      return new Error(`WorkBuddy 请求失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 从上游 /v3/config 读取模型目录。 */
  private async fetchLiveModels(): Promise<GatewayModel[]> {
    const credential = this.credentials.load()
    if (credential === undefined) return []
    try {
      const config = await fetchWorkbuddyConfig(credential)
      const { models, meta } = parseLiveConfig(config)
      for (const [id, entry] of meta) this.modelMeta.set(id, entry)
      return models
    } catch (error: unknown) {
      this.logger?.('workbuddy 读取上游模型目录失败', String(error))
      return []
    }
  }

  /** 读取桌面端本地配置（带短缓存）。 */
  private localCatalog(): DesktopCatalog {
    const cached = this.localCache
    if (cached !== undefined && Date.now() - cached.at < LOCAL_CACHE_TTL_MS) return cached.catalog
    const catalog = readDesktopCatalog(this.configDir())
    for (const entry of catalog.meta.values()) {
      if (!this.modelMeta.has(entry.id)) this.modelMeta.set(entry.id, entry)
    }
    this.localCache = { at: Date.now(), catalog }
    return catalog
  }

  /** 本地配置里的模型目录（兜底）。 */
  private localModels(): GatewayModel[] {
    const catalog = this.localCatalog()
    return catalog.ids
      .map(id => catalog.meta.get(id))
      .filter((entry): entry is ModelEntry => entry !== undefined)
      .map(toGatewayModel)
  }

  /** provider 的配置目录（兼容旧的 settings.configDir）。 */
  private configDir(): string {
    const settings = parseSettings(this.record.settings)
    return typeof settings['configDir'] === 'string' && settings['configDir'] !== ''
      ? settings['configDir']
      : join(homedir(), '.workbuddy')
  }
}

/** 登录态默认存放路径。 */
function defaultCredentialPath(id: string): string {
  return join(CONFIG_DIR, `workbuddy-${id}.json`)
}

/** 把上游 /v3/config 转成模型目录与元数据。 */
function parseLiveConfig(config: Record<string, unknown>): { models: GatewayModel[]; meta: Map<string, ModelEntry> } {
  const agents = Array.isArray(config['agents']) ? config['agents'] : []
  const rawModels = Array.isArray(config['models']) ? config['models'] : []
  const meta = new Map<string, ModelEntry>()
  for (const raw of rawModels) {
    const entry = liveModelEntry(raw)
    if (entry !== undefined) meta.set(entry.id, entry)
  }
  const cli = agents.find(agent => typeof agent === 'object' && agent !== null && (agent as Record<string, unknown>)['name'] === 'cli')
  if (cli === undefined) return { models: [], meta }
  const ids = Array.isArray((cli as Record<string, unknown>)['models'])
    ? ((cli as Record<string, unknown>)['models'] as unknown[]).filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  return { models: ids.map(id => meta.get(id) ?? { id, name: id }).map(toGatewayModel), meta }
}

/** 把上游模型定义转成 ModelEntry。 */
function liveModelEntry(raw: unknown): ModelEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return undefined
  const reasoning = typeof record['reasoning'] === 'object' && record['reasoning'] !== null
    ? record['reasoning'] as Record<string, unknown>
    : {}
  const defaultEffort = typeof reasoning['effort'] === 'string' && reasoning['effort'] !== ''
    ? reasoning['effort']
    : undefined
  const contextWindow = typeof record['maxInputTokens'] === 'number' ? record['maxInputTokens'] : undefined
  const maxTokens = typeof record['maxOutputTokens'] === 'number' ? record['maxOutputTokens'] : undefined
  return {
    id,
    name: typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : id,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

function toGatewayModel(entry: ModelEntry): GatewayModel {
  return {
    id: entry.id,
    name: entry.name,
    ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
    ...entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens },
  }
}

/** 未知模型时按名字猜一个推理档位（上游对部分模型要求显式指定）。 */
function fallbackEffort(model: string): string | undefined {
  for (const [prefix, effort] of Object.entries(FALLBACK_REASONING_MODELS)) {
    if (model.startsWith(prefix)) return effort
  }
  return undefined
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

/** 依据 HTTP 状态与错误正文归类失败原因。 */
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
 * 桌面端会把服务端下发的运行时配置写进 `local_storage/*.info`，其中
 * `agents[name=cli].models` 就是客户端模型下拉框的数据源；`models[]` 带有
 * 上下文窗口与推理档位。这条路径不需要登录态，作为上游目录的兜底。
 *
 * @param configDir WorkBuddy 配置目录（如 `~/.workbuddy`）。
 */
function readDesktopCatalog(configDir: string): DesktopCatalog {
  const meta = new Map<string, ModelEntry>()
  for (const data of collectConfigData(join(configDir, 'local_storage'))) {
    const models = Array.isArray(data['models']) ? data['models'] : []
    for (const raw of models) {
      const entry = desktopModelEntry(raw)
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

/** 把桌面配置里的一条模型定义转为 ModelEntry。 */
function desktopModelEntry(raw: unknown): ModelEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return undefined
  const reasoning = typeof record['reasoning'] === 'object' && record['reasoning'] !== null
    ? record['reasoning'] as Record<string, unknown>
    : {}
  const defaultEffort = typeof reasoning['effort'] === 'string' && reasoning['effort'] !== ''
    ? reasoning['effort']
    : undefined
  const contextWindow = typeof record['maxInputTokens'] === 'number' ? record['maxInputTokens'] : undefined
  const maxTokens = typeof record['maxOutputTokens'] === 'number' ? record['maxOutputTokens'] : undefined
  return {
    id,
    name: typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : id,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
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
