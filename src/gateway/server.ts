/**
 * 统一 HTTP 网关。
 *
 * - `/v1/models`、`/v1/chat/completions`：OpenAI 兼容入口，模型 id 形如
 *   `<providerId>/<modelId>`，用网关 API key 鉴权并记录用量。
 * - `/api/*`：管理台 API（管理员会话 + provider / API key / 用量管理）。
 * - `/healthz`、`/status`：健康检查。
 * - `/`：托管 React 管理台静态文件（web/dist，未构建时只提供 API）。
 *
 * Provider 配置保存在 SQLite，保存后调用 reloadProviders 立即热替换。
 */

import { createServer, ServerResponse, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  authenticateApiKey,
  authenticateSession,
  createSession,
  generateApiKey,
  hashPassword,
  revokeSession,
  verifyPassword,
} from './auth.ts'
import { isValidProviderId, upsertProviderInstance } from './factory.ts'
import { ProviderRegistry, type GatewayModel } from './providers.ts'
import { DEFAULT_DB_PATH, type ProviderRecord, type ProviderType } from './store.ts'
import { SseDecoder } from '../sse.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(dirname(HERE))
export const DEFAULT_WEB_DIST = join(ROOT, 'web', 'dist')

const BODY_LIMIT = 64 * 1024 * 1024
const SESSION_COOKIE = 'trae_proxy_session'
const CC_SWITCH_PROVIDER_NAME = 'Trae Proxy 统一网关'
const LOGIN_MAX_FAILURES = 5
const LOGIN_LOCK_MS = 30_000
const STATUS_BY_KIND: Record<string, number> = {
  authentication: 401,
  hard_credit: 402,
  soft_rate: 429,
  not_found: 404,
  server: 502,
  client: 400,
  unconfigured: 503,
}

export interface GatewayLogger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export interface GatewayServerOptions {
  store: import('./store.ts').GatewayStore
  port: number
  host?: string
  webDist?: string
  logger?: GatewayLogger
}

export interface GatewayServer {
  readonly ready: Promise<void>
  baseUrl(): string
  close(): Promise<void>
  reloadProviders(): Promise<{ total: number; enabled: number }>
  refreshAllModels(): Promise<Array<{ providerId: string; count: number; error?: string }>>
  registry(): ProviderRegistry
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function writeError(res: ServerResponse, status: number, message: string, type = 'api_error'): void {
  writeJson(res, status, { error: { message: safeErrorMessage(message, '请求失败'), type, code: type } })
}

/** 统一清洗对外错误信息：折叠空白、截断、剔除 HTML，防止上游原文直接透传。 */
function safeErrorMessage(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 300)
  if (raw === '' || /<[a-z][\s\S]*>/i.test(raw)) return fallback
  return raw
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req)).toString('utf8')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    if (key === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}

function setSessionCookie(res: ServerResponse, token: string, expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`)
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

function sessionToken(req: IncomingMessage): string | undefined {
  return cookieValue(req, SESSION_COOKIE)
}

function parseJsonObject(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || value.trim() === '') return fallback
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : fallback
  } catch {
    return fallback
  }
}

function parseStringArray(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
      }
    } catch {
      // 逗号分隔的宽松输入也接受
      return value.split(',').map(item => item.trim()).filter(item => item !== '')
    }
  }
  return fallback
}

function normalizeUsage(usage: unknown): { requestTokens?: number; responseTokens?: number; totalTokens?: number } | undefined {
  const record = parseJsonObject(usage)
  const prompt = typeof record['prompt_tokens'] === 'number' ? record['prompt_tokens'] : undefined
  const completion = typeof record['completion_tokens'] === 'number' ? record['completion_tokens'] : undefined
  const total = typeof record['total_tokens'] === 'number' ? record['total_tokens'] : undefined
  if (prompt === undefined && completion === undefined && total === undefined) return undefined
  return {
    ...(prompt === undefined ? {} : { requestTokens: prompt }),
    ...(completion === undefined ? {} : { responseTokens: completion }),
    ...(total === undefined ? {} : { totalTokens: total }),
  }
}

interface AggregatedToolCall {
  id?: string
  type?: string
  name: string
  arguments: string
}

/**
 * 把 OpenAI Chat Completions SSE 聚合成非流式响应。
 *
 * 部分上游（例如 Trae）只能输出 SSE，即使入站请求是 `stream:false`。
 * 这里统一聚合文本、推理内容、工具调用和 usage，避免非流式请求被误判为
 * 非法 JSON。
 */
function aggregateChatSse(text: string, fallbackModel: string): Record<string, unknown> | undefined {
  const decoder = new SseDecoder()
  const events = decoder.push(text)
  events.push(...decoder.finish())

  let sawChunk = false
  let id: string | undefined
  let model: string | undefined
  let created: number | undefined
  let finishReason: string | undefined
  let content = ''
  let reasoning = ''
  let usage: Record<string, unknown> | undefined
  const toolCalls = new Map<number, AggregatedToolCall>()

  for (const event of events) {
    const data = event.data.trim()
    if (data === '' || data === '[DONE]') continue
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const chunk = raw as Record<string, unknown>
    if (id === undefined && typeof chunk['id'] === 'string' && chunk['id'] !== '') id = chunk['id']
    if (model === undefined && typeof chunk['model'] === 'string' && chunk['model'] !== '') model = chunk['model']
    if (created === undefined && typeof chunk['created'] === 'number') created = chunk['created']
    const chunkUsage = parseJsonObject(chunk['usage'])
    if (Object.keys(chunkUsage).length > 0) usage = chunkUsage

    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : []
    for (const rawChoice of choices) {
      if (typeof rawChoice !== 'object' || rawChoice === null) continue
      const choice = rawChoice as Record<string, unknown>
      const delta = parseJsonObject(choice['delta'])
      const message = parseJsonObject(choice['message'])
      const payload = Object.keys(delta).length > 0 ? delta : message
      if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason']
      if (typeof payload['content'] === 'string') content += payload['content']
      if (typeof payload['reasoning_content'] === 'string') reasoning += payload['reasoning_content']
      const rawToolCalls = Array.isArray(payload['tool_calls']) ? payload['tool_calls'] : []
      for (const [position, rawCall] of rawToolCalls.entries()) {
        if (typeof rawCall !== 'object' || rawCall === null) continue
        const call = rawCall as Record<string, unknown>
        const rawIndex = call['index']
        const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : position
        let target = toolCalls.get(index)
        if (target === undefined) {
          target = { name: '', arguments: '' }
          toolCalls.set(index, target)
        }
        if (typeof call['id'] === 'string' && call['id'] !== '') target.id = call['id']
        if (typeof call['type'] === 'string' && call['type'] !== '') target.type = call['type']
        const fn = parseJsonObject(call['function'])
        if (typeof fn['name'] === 'string' && fn['name'] !== '') target.name = fn['name']
        if (typeof fn['arguments'] === 'string') target.arguments += fn['arguments']
        else if (fn['arguments'] !== undefined && target.arguments === '') target.arguments = JSON.stringify(fn['arguments'])
      }
      sawChunk = true
    }
  }

  if (!sawChunk) return undefined
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: content === '' ? null : content,
  }
  if (reasoning !== '') message['reasoning_content'] = reasoning
  if (toolCalls.size > 0) {
    message['tool_calls'] = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        ...(call.id === undefined ? {} : { id: call.id }),
        type: call.type ?? 'function',
        function: { name: call.name, arguments: call.arguments },
      }))
  }
  return {
    id: id ?? `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? fallbackModel,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason ?? (toolCalls.size > 0 ? 'tool_calls' : 'stop'),
      logprobs: null,
    }],
    ...(usage === undefined ? {} : { usage }),
  }
}

function providerRecordFromBody(body: Record<string, unknown>, existing: ProviderRecord | undefined): ProviderRecord {
  const id = typeof body['id'] === 'string' ? body['id'].trim().toLowerCase() : ''
  if (!isValidProviderId(id)) throw new Error('provider id 仅允许小写字母、数字和连字符（1-32 位）')
  const type = String(body['type'] ?? '')
  const types: ProviderType[] = ['trae-cn', 'trae-ai', 'openai', 'anthropic', 'gemini', 'ollama']
  if (!types.includes(type as ProviderType)) throw new Error(`不支持的 provider 类型: ${type}`)
  const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
  if (name === '') throw new Error('provider 名称不能为空')
  const now = Date.now()
  const apiKey = typeof body['apiKey'] === 'string' && body['apiKey'].trim() !== ''
    ? body['apiKey'].trim()
    : existing?.apiKey
  const baseUrl = typeof body['baseUrl'] === 'string' && body['baseUrl'].trim() !== ''
    ? body['baseUrl'].trim().replace(/\/$/, '')
    : undefined
  const timeoutMs = typeof body['timeoutMs'] === 'number' && Number.isFinite(body['timeoutMs']) && body['timeoutMs'] > 0
    ? Math.floor(body['timeoutMs'])
    : undefined
  const extraHeaders = JSON.stringify(parseJsonObject(body['extraHeaders'] ?? {}))
  const models = JSON.stringify(parseStringArray(body['models'] ?? []))
  const settings = JSON.stringify(parseJsonObject(body['settings'] ?? {}))
  return {
    id,
    type: type as ProviderType,
    name,
    enabled: body['enabled'] === false ? 0 : 1,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    extraHeaders,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    models,
    settings,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

function sanitizeProvider(record: ProviderRecord): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    enabled: record.enabled === 1,
    ...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl }),
    apiKeySet: record.apiKey !== undefined && record.apiKey !== '',
    extraHeaders: parseJsonObject(record.extraHeaders),
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
    models: parseStringArray(record.models),
    settings: parseJsonObject(record.settings),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function sanitizeApiKey(record: {
  id: string
  name: string
  key: string
  keyPrefix: string
  modelPrefixes: string
  modelIds: string
  app: string
  createdAt: number
  revokedAt?: number
}): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    key: record.key,
    plaintextStored: record.key !== '',
    modelPrefixes: parseStringArray(record.modelPrefixes),
    modelIds: parseStringArray(record.modelIds),
    app: record.app,
    createdAt: record.createdAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  }
}

interface CcSwitchPreview {
  providerName: string
  baseUrl: string
  models: string[]
  deeplink: string
}

/**
 * 构造导入 cc-switch 的官方深链及展示信息。
 *
 * 深链使用 CC Switch 官方 `ccswitch://v1/import` 协议，由 CC Switch 自己弹出
 * 导入确认对话框；网关只负责唤起，不直接修改 cc-switch 数据库。官方深链目前
 * 只能携带一个默认 model，完整模型目录通过 Base64 config 传给 CC Switch 合并，
 * 导入后仍以网关目录为准。Codex 深链导入时 CC Switch 官方会固定生成
 * `wire_api = "responses"`，这里仍按网关实际能力写入 `chat` 供确认框预览。
 *
 * @param options 网关地址、API key 及完整网关模型 id 列表。
 */
function buildCcSwitchPreview(options: {
  baseUrl: string
  apiKey: string
  models: string[]
}): CcSwitchPreview {
  const models = [...new Set(options.models.filter(model => model.trim() !== ''))]
  const defaultModel = models[0] ?? 'gpt-4o-mini'
  const endpoint = `${options.baseUrl}/v1`
  const config = JSON.stringify({
    auth: { OPENAI_API_KEY: options.apiKey },
    config: [
      'model_provider = "custom"',
      `model = ${JSON.stringify(defaultModel)}`,
      'model_catalog_json = "cc-switch-model-catalog.json"',
      '',
      '[model_providers.custom]',
      `name = ${JSON.stringify(CC_SWITCH_PROVIDER_NAME)}`,
      `base_url = ${JSON.stringify(endpoint)}`,
      'wire_api = "chat"',
      'requires_openai_auth = true',
      '',
    ].join('\n'),
    modelCatalog: {
      models: models.map(model => ({ model, displayName: model })),
    },
  })
  const params = new URLSearchParams({
    resource: 'provider',
    app: 'codex',
    name: CC_SWITCH_PROVIDER_NAME,
    homepage: options.baseUrl,
    endpoint,
    apiKey: options.apiKey,
    model: defaultModel,
    config: Buffer.from(config, 'utf8').toString('base64'),
    configFormat: 'json',
  })
  return {
    providerName: CC_SWITCH_PROVIDER_NAME,
    baseUrl: endpoint,
    models,
    deeplink: `ccswitch://v1/import?${params.toString()}`,
  }
}

/**
 * 用系统默认方式打开 cc-switch 官方导入深链，让 CC Switch 自行弹出确认弹窗。
 *
 * @param url `ccswitch://v1/import?...` 深链。
 * @returns 启动命令的退出码；非 0 表示打开失败。
 */
export async function openCcSwitchImport(url: string): Promise<number> {
  const { execFile } = await import('node:child_process')
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  return new Promise<number>((resolve, reject) => {
    execFile(command, args, error => {
      if (error === null) {
        resolve(0)
      } else {
        reject(error)
      }
    })
  })
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

export function createGatewayServer(options: GatewayServerOptions): GatewayServer {
  const store = options.store
  const host = options.host ?? '127.0.0.1'
  const port = options.port
  const webDist = options.webDist ?? DEFAULT_WEB_DIST
  const logger: GatewayLogger = options.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  const registry = new ProviderRegistry({ logger: (message, detail) => logger.warn(message, detail) })
  const records = new Map<string, ProviderRecord>()
  const sockets = new Set<Socket>()
  const loginFailures = new Map<string, { count: number; lockedUntil: number }>()
  const server: Server = createServer((req, res) => { void handle(req, res) })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    server.once('listening', resolveReady)
    server.once('error', rejectReady)
  })
  server.listen(port, host)

  function loginLocked(client: string): boolean {
    const entry = loginFailures.get(client)
    if (entry === undefined) return false
    if (entry.lockedUntil <= Date.now()) {
      loginFailures.delete(client)
      return false
    }
    return true
  }

  function recordLoginFailure(client: string): void {
    const now = Date.now()
    const entry = loginFailures.get(client)
    const count = (entry === undefined || entry.lockedUntil <= now ? 0 : entry.count) + 1
    if (count >= LOGIN_MAX_FAILURES) {
      loginFailures.set(client, { count: 0, lockedUntil: now + LOGIN_LOCK_MS })
    } else {
      loginFailures.set(client, { count, lockedUntil: now })
    }
  }

  function clearLoginFailures(client: string): void {
    loginFailures.delete(client)
  }

  function clientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown'
  }

  async function reloadProviders(): Promise<{ total: number; enabled: number }> {
    const next = new Set<string>()
    let enabled = 0
    const all = store.listProviders()
    for (const record of all) {
      next.add(record.id)
      records.set(record.id, record)
      if (!record.enabled) continue
      enabled += 1
      try {
        upsertProviderInstance(registry, record, { logger: (message, detail) => logger.warn(message, detail) })
      } catch (error: unknown) {
        logger.warn(`provider ${record.id} 实例化失败`, String(error))
      }
    }
    for (const id of [...registry.list().map(item => item.id)]) {
      if (!next.has(id)) registry.unregister(id)
    }
    for (const id of [...records.keys()]) {
      if (!next.has(id)) records.delete(id)
    }
    return { total: all.length, enabled }
  }

  function visibleModels(providerId: string, models: GatewayModel[]): GatewayModel[] {
    const record = records.get(providerId)
    const pinned = parseStringArray(record?.models ?? '[]')
    if (pinned.length === 0) return models
    const allowed = new Set(pinned)
    const kept = models.filter(model => allowed.has(model.id))
    return kept.length > 0 ? kept : models
  }

  async function collectAllModelIds(): Promise<Array<{ id: string; model: GatewayModel }>> {
    const jobs: Promise<Array<{ id: string; model: GatewayModel }>>[] = []
    for (const record of records.values()) {
      if (!record.enabled) continue
      const provider = registry.get(record.id)
      if (provider === undefined) continue
      jobs.push(
        registry.ensureModels(record.id)
          .then(models => visibleModels(record.id, models).map(model => ({ id: `${record.id}/${model.id}`, model })))
          .catch(() => visibleModels(record.id, registry.cachedModels(record.id)).map(model => ({ id: `${record.id}/${model.id}`, model }))),
      )
    }
    const lists = await Promise.all(jobs)
    return lists.flat()
  }

  /**
   * 收集当前 API key 实际可见的完整网关模型 id 列表。
   *
   * 优先使用密钥已保存的 modelIds；留空（全部渠道/全部模型）时按网关
   * 渠道目录展开，用于给 cc-switch 选一个真实存在的默认模型。
   */
  async function collectVisibleModelIds(key: {
    modelPrefixes: string[]
    modelIds: string[]
  }): Promise<string[]> {
    const pinned = key.modelIds.length > 0
    if (pinned) return key.modelIds
    const all = await collectAllModelIds()
    const visible = all
      .filter(({ id }) => key.modelPrefixes.length === 0 || key.modelPrefixes.some(prefix => id.startsWith(`${prefix}/`)))
      .map(({ id }) => id)
    return visible.length > 0 ? visible : ['gpt-4o-mini']
  }

  async function refreshAllModels(): Promise<Array<{ providerId: string; count: number; error?: string }>> {
    const jobs: Array<Promise<{ providerId: string; count: number; error?: string }>> = []
    for (const record of records.values()) {
      if (!record.enabled) continue
      const provider = registry.get(record.id)
      if (provider === undefined) continue
      jobs.push(
        registry.refreshModels(record.id)
          .then(models => ({ providerId: record.id, count: models.length }))
          .catch((error: unknown) => ({
            providerId: record.id,
            count: registry.cachedModels(record.id).length,
            error: error instanceof Error ? error.message : String(error),
          })),
      )
    }
    return Promise.all(jobs)
  }

  /**
   * 校验管理会话；剩余有效期不足一半时顺带续期并刷新 Cookie。
   */
  function authenticatedRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): import('./auth.ts').SessionContext | undefined {
    const token = sessionToken(req)
    const session = authenticateSession(store, token)
    if (session !== undefined && session.renewedExpiresAt !== undefined && token !== undefined) {
      setSessionCookie(res, token, session.renewedExpiresAt)
    }
    return session
  }

  function requireSession(req: IncomingMessage, res: ServerResponse): boolean {
    return authenticatedRequest(req, res) !== undefined
  }

  interface ChatInput {
    model: string
    stream: boolean
    body: Record<string, unknown>
    /** 透传给需要会话粘性的上游（如 opencode.ai 的 x-opencode-session）。 */
    sessionId?: string
    usage?: { requestTokens?: number; responseTokens?: number; totalTokens?: number }
  }

  /** 入站请求中可作为会话标识的请求头，按优先级排列。 */
  const SESSION_HEADERS = [
    'x-opencode-session',
    'x-session-id',
    'session_id',
    'session-id',
    'conversation_id',
    'x-conversation-id',
  ] as const

  /**
   * 从入站请求推导稳定的会话标识。
   *
   * 顺序为：显式会话请求头（Codex 会发 `x-session-id`）→ 请求体
   * `prompt_cache_key` / `metadata` → 由指令与首条消息派生的稳定摘要。
   * 兜底摘要保证同一会话重放同一 id，避免上游因缺少会话头直接 400。
   */
  function resolveSessionId(req: IncomingMessage, body: Record<string, unknown>): string {
    for (const name of SESSION_HEADERS) {
      const header = req.headers[name]
      const value = Array.isArray(header) ? header[0] : header
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    const cacheKey = body['prompt_cache_key']
    if (typeof cacheKey === 'string' && cacheKey.trim() !== '') return cacheKey.trim()
    const metadata = body['metadata']
    if (typeof metadata === 'object' && metadata !== null) {
      const record = metadata as Record<string, unknown>
      for (const key of ['session_id', 'sessionId', 'thread_id', 'threadId']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
    }
    return `trae-proxy-${createHash('sha256').update(sessionSeed(body)).digest('hex').slice(0, 32)}`
  }

  /** 用指令 + 首条消息构造会话摘要的原始文本（截断，避免长上下文参与哈希）。 */
  function sessionSeed(body: Record<string, unknown>): string {
    const parts: string[] = []
    const instructions = body['instructions']
    if (typeof instructions === 'string') parts.push(instructions)
    const messages = Array.isArray(body['messages']) ? body['messages'] : []
    for (const message of messages.slice(0, 2)) {
      if (typeof message === 'object' && message !== null) parts.push(JSON.stringify(message))
    }
    const input = Array.isArray(body['input']) ? body['input'] : []
    for (const item of input.slice(0, 2)) {
      if (typeof item === 'object' && item !== null) parts.push(JSON.stringify(item))
    }
    return parts.join('\n').slice(0, 4000)
  }

  /** 校验一次对话请求并解析 `<providerId>/<upstreamModelId>`。 */
  function parseChatRequest(input: Record<string, unknown>): ChatInput {
    const model = typeof input['model'] === 'string' ? input['model'] : ''
    const slash = model.indexOf('/')
    if (model === '' || slash <= 0 || slash === model.length - 1) {
      throw { status: 404, kind: 'model_not_found', message: `Unknown model: ${model || '(empty)'}（模型 id 应为 <providerId>/<modelId>）` }
    }
    const providerId = model.slice(0, slash)
    const upstreamModel = model.slice(slash + 1)
    return {
      model,
      stream: input['stream'] === true,
      body: { ...input, model: upstreamModel },
    }
  }

  /**
   * 执行一次已校验的对话请求，以回调形式返回上游 JSON 或 SSE 文本行。
   *
   * 统一做鉴权、用量记录与 abort 清理；Chat 和 Responses 入口共享这一层，
   * 避免两端各自维护转发逻辑。
   */
  async function runChatInternal(
    key: import('./auth.ts').ApiKeyContext,
    input: ChatInput,
    req: IncomingMessage,
    onJson: (json: Record<string, unknown>, status: number) => void,
    onStreamLine: (line: string) => void,
    onDone: () => void,
    onError: (status: number, message: string, kind: string) => void,
  ): Promise<void> {
    const model = input.model
    const slash = model.indexOf('/')
    const providerId = model.slice(0, slash)
    const upstreamModel = String(input.body['model'] ?? '')
    if (key.modelPrefixes.length > 0 && !key.modelPrefixes.includes(providerId)) {
      onError(403, `API key 无权访问 provider: ${providerId}`, 'forbidden')
      return
    }
    if (key.modelIds.length > 0 && !key.modelIds.includes(`${providerId}/${upstreamModel}`)) {
      onError(403, `API key 无权访问模型: ${providerId}/${upstreamModel}`, 'forbidden')
      return
    }
    const record = records.get(providerId)
    const provider = registry.get(providerId)
    if (record === undefined || record.enabled !== 1 || provider === undefined) {
      onError(404, `Unknown provider: ${providerId}`, 'provider_not_found')
      return
    }
    const started = Date.now()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const onAborted = (): void => abort()
    const onSocketClose = (): void => abort()
    req.once('aborted', onAborted)
    req.socket.once('close', onSocketClose)

    const recordUsage = (status: number, usage?: { requestTokens?: number; responseTokens?: number; totalTokens?: number }): void => {
      store.insertUsage({
        ts: Date.now(),
        apiKeyId: key.id,
        providerId,
        model,
        requestTokens: usage?.requestTokens ?? 0,
        responseTokens: usage?.responseTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        status,
        durationMs: Date.now() - started,
        streamed: input.stream ? 1 : 0,
      })
    }

    const result = await registry.chat(providerId, JSON.stringify(input.body), controller.signal, {
      sessionId: input.sessionId,
    })
    if (!result.ok) {
      const status = result.status > 0 ? result.status : STATUS_BY_KIND[result.kind] ?? 502
      recordUsage(status)
      onError(status, result.message, result.kind)
      return
    }

    if (!input.stream) {
      let text: string
      try {
        text = await result.response.text()
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('upstream response read error', message)
        recordUsage(502)
        onError(502, 'upstream response read failed', 'server')
        return
      }
      let json: Record<string, unknown>
      try {
        json = JSON.parse(text) as Record<string, unknown>
      } catch {
        const aggregated = aggregateChatSse(text, input.model)
        if (aggregated === undefined) {
          recordUsage(502)
          onError(502, 'upstream returned an invalid JSON response', 'server')
          return
        }
        json = aggregated
      }
      const usage = normalizeUsage(json['usage'])
      recordUsage(200, usage)
      onJson(json, result.response.status)
      onDone()
      return
    }

    const source = result.response.body
    if (source === null) {
      recordUsage(502)
      onError(502, 'upstream returned an empty stream', 'server')
      return
    }
    let capturedUsage: { requestTokens?: number; responseTokens?: number; totalTokens?: number } | undefined
    const decoder = new TextDecoder()
    const usageDecoder = new TextDecoder()
    let usageBuffer = ''
    const observeUsage = (chunk: Uint8Array): void => {
      usageBuffer += usageDecoder.decode(chunk, { stream: true })
      const lines = usageBuffer.split('\n')
      usageBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '' || data === '[DONE]') continue
        try {
          const event = JSON.parse(data) as Record<string, unknown>
          const usage = normalizeUsage(event['usage'])
          if (usage !== undefined) capturedUsage = usage
        } catch {
          // 非 JSON 数据行不参与用量扫描
        }
      }
    }
    // 只做用量扫描，保持字节流原样：改写成字符串流会让零长度分片
    // 在 Web Stream → Node Readable 转换时被丢弃，SSE 的空行分隔符随之消失。
    const usageTap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controllerInner) {
        observeUsage(chunk)
        controllerInner.enqueue(chunk)
      },
    })
    const readable = Readable.fromWeb(source.pipeThrough(usageTap) as Parameters<typeof Readable.fromWeb>[0])
    let finished = false
    let streamFailed = false
    const done = (status: number): void => {
      if (finished) return
      finished = true
      req.removeListener('aborted', onAborted)
      req.socket.removeListener('close', onSocketClose)
      recordUsage(status, capturedUsage)
      if (!streamFailed) onDone()
    }

    /**
     * 逐行回放上游 SSE，空行必须原样透传。
     *
     * 空行（`\n\n`）是 SSE 的事件终止符：丢掉它会让整条流转变成一个事件，
     * 严格的解析方（cc-switch 的 chat→responses 转换、Codex）读不到任何 chunk，
     * 最终报 stream_truncated / ended before sending finish_reason。
     * 下游消费者各自按需忽略空行即可（Responses 转换已做空行判断）。
     */
    const lineFeed = async (): Promise<void> => {
      let lineBuffer = ''
      for await (const chunk of readable) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true })
        const split = (lineBuffer + text).split('\n')
        lineBuffer = split.pop() ?? ''
        for (const line of split) onStreamLine(line)
      }
      lineBuffer += decoder.decode()
      if (lineBuffer !== '') onStreamLine(lineBuffer)
    }
    lineFeed().catch((error: unknown) => {
      if (finished) return
      streamFailed = true
      logger.error('upstream stream error', error instanceof Error ? error.message : String(error))
      done(502)
      onError(502, 'upstream stream failed', 'server')
    })
    readable.on('end', () => done(200))
    readable.on('close', () => done(200))
  }

  /**
   * Chat Completions 入口：把内部转发结果原样写回响应。
   */
  async function runChat(
    key: import('./auth.ts').ApiKeyContext,
    input: ChatInput,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let statusCode = 200
    let headersWritten = false
    const writeSse = (): void => {
      if (headersWritten) return
      headersWritten = true
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      })
    }
    await runChatInternal(
      key,
      input,
      req,
      (json, status) => {
        statusCode = status
        const payload = JSON.stringify(json)
        res.writeHead(statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          'Cache-Control': 'no-store',
        })
        res.end(payload)
      },
      line => {
        writeSse()
        res.write(`${line}\n`)
      },
      () => {
        if (headersWritten) res.end()
      },
      (status, message, kind) => {
        if (!headersWritten) writeError(res, status, message, kind)
      },
    )
  }

  /** 把 OpenAI Responses 请求转成 Chat Completions 请求体（Codex 渠道）。 */
  function responsesToChat(input: Record<string, unknown>): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = []
    const instructions = input['instructions']
    if (typeof instructions === 'string' && instructions.trim() !== '') {
      messages.push({ role: 'system', content: instructions })
    }
    const items = Array.isArray(input['input']) ? input['input'] : []
    for (const raw of items) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      if (item['type'] === 'message') {
        const content = item['content']
        if (typeof content === 'string' && content.trim() !== '') {
          messages.push({ role: item['role'] === 'user' ? 'user' : 'assistant', content })
        } else if (Array.isArray(content)) {
          const convertedContent: Array<Record<string, unknown>> = []
          for (const part of content) {
            if (typeof part === 'string' && part !== '') {
              convertedContent.push({ type: 'text', text: part })
              continue
            }
            if (typeof part !== 'object' || part === null) continue
            const record = part as Record<string, unknown>
            if ((record['type'] === 'input_text' || record['type'] === 'output_text') && typeof record['text'] === 'string' && record['text'] !== '') {
              convertedContent.push({ type: 'text', text: record['text'] })
              continue
            }
            if (record['type'] === 'input_image' && typeof record['image_url'] === 'string' && record['image_url'] !== '') {
              convertedContent.push({ type: 'image_url', image_url: { url: record['image_url'] } })
            }
          }
          if (convertedContent.length > 0) messages.push({ role: item['role'] === 'user' ? 'user' : 'assistant', content: convertedContent })
        }
      } else if (item['type'] === 'function_call') {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: item['call_id'] ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: {
              name: item['name'] ?? '',
              arguments: typeof item['arguments'] === 'string' ? item['arguments'] : JSON.stringify(item['arguments'] ?? ''),
            },
          }],
        })
      } else if (item['type'] === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item['call_id'] ?? '',
          content: typeof item['output'] === 'string' ? item['output'] : JSON.stringify(item['output'] ?? ''),
        })
      } else if (item['type'] === 'reasoning') {
        // 推理摘要不回灌给上游
      }
    }
    if (messages.length === 0) messages.push({ role: 'user', content: 'Hello' })
    const converted: Record<string, unknown> = {
      model: input['model'] ?? '',
      messages,
      stream: input['stream'] === true,
    }
    if (typeof input['temperature'] === 'number') converted['temperature'] = input['temperature']
    if (typeof input['top_p'] === 'number') converted['top_p'] = input['top_p']
    if (typeof input['max_output_tokens'] === 'number') converted['max_tokens'] = input['max_output_tokens']
    if (typeof input['max_tokens'] === 'number') converted['max_tokens'] = input['max_tokens']
    if (Array.isArray(input['tools'])) {
      const tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> = []
      for (const tool of input['tools']) {
        if (typeof tool !== 'object' || tool === null) continue
        const record = tool as Record<string, unknown>
        if (record['type'] !== 'function') continue
        const nested = record['function']
        const fn = typeof nested === 'object' && nested !== null
          ? nested as Record<string, unknown>
          : record
        const name = typeof fn['name'] === 'string' ? fn['name'] : ''
        if (name === '') continue
        tools.push({
          type: 'function',
          function: {
            name,
            description: typeof fn['description'] === 'string' ? fn['description'] : '',
            parameters: fn['parameters'] ?? { type: 'object', properties: {} },
          },
        })
      }
      if (tools.length > 0) converted['tools'] = tools
    }
    if (typeof input['tool_choice'] === 'string') {
      converted['tool_choice'] = input['tool_choice']
    } else if (typeof input['tool_choice'] === 'object' && input['tool_choice'] !== null) {
      const choice = input['tool_choice'] as Record<string, unknown>
      if (typeof choice['name'] === 'string' && choice['name'] !== '') {
        converted['tool_choice'] = { type: 'function', function: { name: choice['name'] } }
      }
    }
    if (typeof input['parallel_tool_calls'] === 'boolean') {
      converted['parallel_tool_calls'] = input['parallel_tool_calls']
    }
    return converted
  }

  /**
   * 把 OpenAI Chat Completions 响应转成 Responses API 响应。
   *
   * 模型 id 保持网关前缀格式，输出按 Responses 语义字段（output / usage）
   * 组装；流式每段 SSE 都转成 response.output_text.delta 事件。
   */
  function chatToResponses(json: Record<string, unknown>, requestModel: string): Record<string, unknown> {
    const id = typeof json['id'] === 'string' ? json['id'] : `resp_${Math.random().toString(36).slice(2, 14)}`
    const created = typeof json['created'] === 'number' ? json['created'] : Math.floor(Date.now() / 1000)
    const model = typeof json['model'] === 'string' ? json['model'] : requestModel
    const choices = Array.isArray(json['choices']) ? json['choices'] : []
    const choice = choices[0] as Record<string, unknown> | undefined
    const message = choice?.['message'] as Record<string, unknown> | undefined
    const output: Array<Record<string, unknown>> = []
    const text = typeof message?.['content'] === 'string' ? message['content'] : ''
    if (text !== '') {
      output.push({
        id: `msg_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      })
    }
    const toolCalls = Array.isArray(message?.['tool_calls']) ? message['tool_calls'] : []
    for (const call of toolCalls) {
      if (typeof call !== 'object' || call === null) continue
      const callRecord = call as Record<string, unknown>
      const fn = callRecord['function'] as Record<string, unknown> | undefined
      const callId = typeof callRecord['id'] === 'string' && callRecord['id'] !== ''
        ? callRecord['id']
        : `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      output.push({
        id: `fc_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name: fn?.['name'] ?? '',
        arguments: typeof fn?.['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn?.['arguments'] ?? ''),
      })
    }
    const usage = json['usage'] as Record<string, unknown> | undefined
    const promptTokens = typeof usage?.['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : undefined
    const completionTokens = typeof usage?.['completion_tokens'] === 'number' ? usage['completion_tokens'] : undefined
    const totalTokens = typeof usage?.['total_tokens'] === 'number' ? usage['total_tokens'] : undefined
    return {
      id,
      object: 'response',
      created_at: created,
      status: 'completed',
      model,
      output,
      ...(promptTokens === undefined && completionTokens === undefined
        ? {}
        : {
            usage: {
              input_tokens: promptTokens ?? 0,
              output_tokens: completionTokens ?? 0,
              total_tokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
            },
          }),
    }
  }

  function responsesSseEvent(
    id: string,
    type: string,
    data: Record<string, unknown>,
    sequenceNumber: number,
  ): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data, id, sequence_number: sequenceNumber })}\n\n`
  }

  interface ResponseTextState {
    itemId: string
    outputIndex: number
    text: string
    started: boolean
  }

  interface ResponseToolArguments {
    itemId: string
    outputIndex: number
    callId: string
    name: string
    arguments: string
    started: boolean
  }

  interface ResponsesStreamState {
    model: string
    nextOutputIndex: number
    text?: ResponseTextState
    tools: Map<number, ResponseToolArguments>
  }

  /** 组装 Responses API 的助手消息输出项。 */
  function responseMessageItem(state: ResponseTextState): Record<string, unknown> {
    return {
      id: state.itemId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: state.text, annotations: [] }],
    }
  }

  /** 组装 Responses API 的函数调用输出项。 */
  function responseFunctionCallItem(state: ResponseToolArguments): Record<string, unknown> {
    return {
      id: state.itemId,
      type: 'function_call',
      status: 'completed',
      call_id: state.callId,
      name: state.name,
      arguments: state.arguments,
    }
  }

  /** 汇总当前流中的输出项，用于 response.completed。 */
  function responsesOutput(state: ResponsesStreamState): Array<Record<string, unknown>> {
    const output: Array<{ outputIndex: number; item: Record<string, unknown> }> = []
    if (state.text?.started === true) {
      output.push({ outputIndex: state.text.outputIndex, item: responseMessageItem(state.text) })
    }
    for (const tool of state.tools.values()) {
      if (tool.started) output.push({ outputIndex: tool.outputIndex, item: responseFunctionCallItem(tool) })
    }
    return output
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .map(({ item }) => item)
  }

  /**
   * 把 Chat SSE chunk 转成 Responses 事件，并在流内聚合工具参数分片。
   *
   * `function_call_arguments.done` 必须等参数分片收齐（finish_reason）后
   * 再发；状态保存在调用方传入的 Map 中，避免流式回调之间丢状态。
   */
  function responsesStreamLine(
    json: Record<string, unknown>,
    state: ResponsesStreamState,
  ): Array<{ type: string; data: Record<string, unknown> }> {
    const choices = Array.isArray(json['choices']) ? json['choices'] : []
    const choice = choices[0] as Record<string, unknown> | undefined
    const delta = choice?.['delta'] as Record<string, unknown> | undefined
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    if (typeof delta?.['content'] === 'string' && delta['content'] !== '') {
      if (state.text === undefined) {
        state.text = {
          itemId: `msg_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
          outputIndex: state.nextOutputIndex++,
          text: '',
          started: false,
        }
      }
      const text = state.text
      if (!text.started) {
        text.started = true
        events.push({
          type: 'response.output_item.added',
          data: {
            output_index: text.outputIndex,
            item: {
              id: text.itemId,
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            },
          },
        })
        events.push({
          type: 'response.content_part.added',
          data: {
            item_id: text.itemId,
            output_index: text.outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
        })
      }
      text.text += delta['content']
      events.push({
        type: 'response.output_text.delta',
        data: {
          delta: delta['content'],
          item_id: text.itemId,
          output_index: text.outputIndex,
          content_index: 0,
        },
      })
    }
    const toolCalls = Array.isArray(delta?.['tool_calls']) ? delta['tool_calls'] : []
    for (const call of toolCalls) {
      if (typeof call !== 'object' || call === null) continue
      const callRecord = call as Record<string, unknown>
      const fn = callRecord['function'] as Record<string, unknown> | undefined
      const index = typeof callRecord['index'] === 'number' ? callRecord['index'] : 0
      let tool = state.tools.get(index)
      if (tool === undefined) {
        tool = {
          itemId: `fc_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
          outputIndex: state.nextOutputIndex++,
          callId: `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
          name: '',
          arguments: '',
          started: false,
        }
        state.tools.set(index, tool)
      }
      if (typeof callRecord['id'] === 'string' && callRecord['id'] !== '') {
        tool.callId = callRecord['id']
      }
      const name = fn?.['name']
      if (typeof name === 'string' && name !== '') tool.name = name
      if (!tool.started) {
        tool.started = true
        events.push({
          type: 'response.output_item.added',
          data: {
            output_index: tool.outputIndex,
            item: {
              id: tool.itemId,
              type: 'function_call',
              status: 'in_progress',
              call_id: tool.callId,
              name: tool.name,
              arguments: '',
            },
          },
        })
      }
      if (typeof fn?.['arguments'] === 'string' && fn['arguments'] !== '') {
        tool.arguments += fn['arguments']
        events.push({
          type: 'response.function_call_arguments.delta',
          data: {
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            delta: fn['arguments'],
          },
        })
      }
    }
    return events
  }

  /** 按标准顺序结束当前流中的文本项和函数调用项。 */
  function flushResponsesStream(
    state: ResponsesStreamState,
  ): Array<{ type: string; data: Record<string, unknown> }> {
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    if (state.text?.started === true) {
      const text = state.text
      events.push({
        type: 'response.output_text.done',
        data: {
          item_id: text.itemId,
          output_index: text.outputIndex,
          content_index: 0,
          text: text.text,
        },
      })
      events.push({
        type: 'response.content_part.done',
        data: {
          item_id: text.itemId,
          output_index: text.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: text.text, annotations: [] },
        },
      })
      events.push({
        type: 'response.output_item.done',
        data: { output_index: text.outputIndex, item: responseMessageItem(text) },
      })
    }
    const tools = [...state.tools.values()].sort((left, right) => left.outputIndex - right.outputIndex)
    for (const tool of tools) {
      if (!tool.started) continue
      events.push({
        type: 'response.function_call_arguments.done',
        data: {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          arguments: tool.arguments,
        },
      })
      events.push({
        type: 'response.output_item.done',
        data: { output_index: tool.outputIndex, item: responseFunctionCallItem(tool) },
      })
    }
    return events
  }

  /** Responses API 网关：请求转 Chat、响应转 Responses，支持流式 SSE 与用量记录。 */
  async function handleV1Responses(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = authenticateApiKey(store, req.headers.authorization)
    if (key === undefined) {
      writeError(res, 401, 'Missing or invalid API key', 'unauthorized')
      return
    }
    if (typeof req.headers['content-type'] !== 'string'
      || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
      writeError(res, 415, 'Content-Type must be application/json', 'unsupported_media_type')
      return
    }
    let rawInput: Record<string, unknown>
    try {
      rawInput = await readJsonBody(req)
    } catch {
      writeError(res, 400, 'Request body must be valid JSON', 'invalid_json')
      return
    }
    let parsed: ChatInput
    try {
      parsed = parseChatRequest(rawInput)
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const failure = error as { status: number; kind: string; message: string }
        writeError(res, failure.status, failure.message, failure.kind)
      } else {
        throw error
      }
      return
    }
    const converted = responsesToChat(rawInput)
    converted['model'] = String(parsed.body['model'] ?? '')
    parsed.body = converted
    parsed.sessionId = resolveSessionId(req, rawInput)

    if (!parsed.stream) {
      await runChatInternal(
        key,
        parsed,
        req,
        json => {
          const convertedResponse = chatToResponses(json, rawInput['model'] as string)
          const payload = JSON.stringify(convertedResponse)
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload),
            'Cache-Control': 'no-store',
          })
          res.end(payload)
        },
        () => {
          // 非流式不会走到这里
        },
        () => {},
        (status, message, kind) => {
          writeError(res, status, message, kind)
        },
      )
      return
    }

    const responseId = `resp_${randomUUID().replaceAll('-', '').slice(0, 24)}`
    const streamState: ResponsesStreamState = {
      model: String(rawInput['model'] ?? ''),
      nextOutputIndex: 0,
      tools: new Map<number, ResponseToolArguments>(),
    }
    let sequenceNumber = 0
    let started = false
    let finished = false
    const send = (type: string, data: Record<string, unknown>): void => {
      res.write(responsesSseEvent(responseId, type, data, sequenceNumber++))
    }
    const start = (): void => {
      if (started) return
      started = true
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      })
      send('response.created', {
        response: {
          id: responseId,
          object: 'response',
          status: 'in_progress',
          model: streamState.model,
          output: [],
        },
      })
    }
    const finish = (output?: Array<Record<string, unknown>>): void => {
      if (!started || finished) return
      finished = true
      send('response.completed', {
        response: {
          id: responseId,
          object: 'response',
          status: 'completed',
          model: streamState.model,
          output: output ?? responsesOutput(streamState),
        },
      })
      res.end()
    }
    const completeStream = (): void => {
      start()
      for (const item of flushResponsesStream(streamState)) {
        send(item.type, item.data)
      }
      finish()
    }
    await runChatInternal(
      key,
      parsed,
      req,
      json => {
        const convertedResponse = chatToResponses(json, rawInput['model'] as string)
        start()
        const output = Array.isArray(convertedResponse['output'])
          ? convertedResponse['output'] as Array<Record<string, unknown>>
          : []
        for (const [outputIndex, item] of output.entries()) {
          if (item['type'] === 'message') {
            const content = Array.isArray(item['content']) ? item['content'] : []
            const part = content[0] as Record<string, unknown> | undefined
            const itemId = String(item['id'] ?? `msg_${randomUUID().replaceAll('-', '').slice(0, 24)}`)
            const text = typeof part?.['text'] === 'string' ? part['text'] : ''
            send('response.output_item.added', {
              output_index: outputIndex,
              item: { ...item, status: 'in_progress', content: [] },
            })
            send('response.content_part.added', {
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            })
            send('response.output_text.delta', {
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              delta: text,
            })
            send('response.output_text.done', {
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              text,
            })
            send('response.content_part.done', {
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: 'output_text', text, annotations: [] },
            })
            send('response.output_item.done', { output_index: outputIndex, item })
          } else if (item['type'] === 'function_call') {
            const itemId = String(item['id'] ?? `fc_${randomUUID().replaceAll('-', '').slice(0, 24)}`)
            const argumentsText = typeof item['arguments'] === 'string' ? item['arguments'] : ''
            send('response.output_item.added', {
              output_index: outputIndex,
              item: { ...item, status: 'in_progress', arguments: '' },
            })
            send('response.function_call_arguments.delta', {
              item_id: itemId,
              output_index: outputIndex,
              delta: argumentsText,
            })
            send('response.function_call_arguments.done', {
              item_id: itemId,
              output_index: outputIndex,
              arguments: argumentsText,
            })
            send('response.output_item.done', { output_index: outputIndex, item })
          }
        }
        finish(output)
      },
      line => {
        const data = line.startsWith('data:') ? line.slice(5).trim() : ''
        if (data === '' || data === '[DONE]') return
        let event: Record<string, unknown>
        try {
          event = JSON.parse(data) as Record<string, unknown>
        } catch {
          return
        }
        start()
        for (const item of responsesStreamLine(event, streamState)) {
          send(item.type, item.data)
        }
      },
      () => completeStream(),
      (status, message, kind) => {
        if (!started) writeError(res, status, message, kind)
        else {
          send('error', { message, type: kind })
          res.end()
        }
      },
    )
  }

  async function handleV1Models(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = authenticateApiKey(store, req.headers.authorization)
    if (key === undefined) {
      writeError(res, 401, 'Missing or invalid API key', 'unauthorized')
      return
    }
    const all = await collectAllModelIds()
    const visible = key.modelIds.length > 0 ? all.filter(({ id }) => key.modelIds.includes(id)) : all
    const data = visible.map(({ id, model }) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: model.id.split('/')[0] ?? 'trae-proxy',
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }))
    writeJson(res, 200, { object: 'list', data })
  }

  async function handleV1Chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = authenticateApiKey(store, req.headers.authorization)
    if (key === undefined) {
      writeError(res, 401, 'Missing or invalid API key', 'unauthorized')
      return
    }
    if (typeof req.headers['content-type'] !== 'string'
      || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
      writeError(res, 415, 'Content-Type must be application/json', 'unsupported_media_type')
      return
    }
    let input: Record<string, unknown>
    try {
      input = await readJsonBody(req)
    } catch {
      writeError(res, 400, 'Request body must be valid JSON', 'invalid_json')
      return
    }
    let parsed: ChatInput
    try {
      parsed = parseChatRequest(input)
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const failure = error as { status: number; kind: string; message: string }
        writeError(res, failure.status, failure.message, failure.kind)
      } else {
        throw error
      }
      return
    }
    parsed.sessionId = resolveSessionId(req, input)
    await runChat(
      key,
      parsed,
      req,
      res,
    )
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    if (req.method === 'POST' && path === '/api/bootstrap') {
      if (store.hasAdmin()) {
        writeError(res, 409, '管理员已存在', 'admin_exists')
        return
      }
      const client = clientIp(req)
      if (loginLocked(client)) {
        writeError(res, 429, '尝试过于频繁，请稍后再试', 'rate_limited')
        return
      }
      const body = await readJsonBody(req)
      const username = typeof body['username'] === 'string' ? body['username'].trim() : ''
      const password = typeof body['password'] === 'string' ? body['password'] : ''
      if (username === '' || username.length > 64 || password.length < 8 || password.length > 256) {
        recordLoginFailure(client)
        writeError(res, 400, '用户名不能为空（≤64 字符），密码需 8-256 字符', 'invalid_input')
        return
      }
      const admin = store.createAdmin(username, hashPassword(password))
      const session = createSession(store, admin.id)
      setSessionCookie(res, session.token, session.expiresAt)
      clearLoginFailures(client)
      writeJson(res, 200, { ok: true, admin: { username: admin.username } })
      return
    }
    if (req.method === 'POST' && path === '/api/login') {
      const client = clientIp(req)
      if (loginLocked(client)) {
        writeError(res, 429, '尝试过于频繁，请稍后再试', 'rate_limited')
        return
      }
      const body = await readJsonBody(req)
      const username = typeof body['username'] === 'string' ? body['username'].trim() : ''
      const password = typeof body['password'] === 'string' ? body['password'] : ''
      const admin = store.getAdminByUsername(username)
      if (admin === undefined || !verifyPassword(password, admin.passwordHash)) {
        recordLoginFailure(client)
        writeError(res, 401, '用户名或密码错误', 'invalid_credentials')
        return
      }
      const session = createSession(store, admin.id)
      setSessionCookie(res, session.token, session.expiresAt)
      clearLoginFailures(client)
      writeJson(res, 200, { ok: true, admin: { username: admin.username } })
      return
    }
    if (req.method === 'POST' && path === '/api/logout') {
      revokeSession(store, sessionToken(req))
      clearSessionCookie(res)
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && path === '/api/session') {
      const session = authenticatedRequest(req, res)
      if (session === undefined) {
        writeJson(res, 200, { authed: false, needsSetup: !store.hasAdmin() })
        return
      }
      writeJson(res, 200, { authed: true, needsSetup: false })
      return
    }
    if (!requireSession(req, res)) {
      writeError(res, 401, '请先登录', 'unauthorized')
      return
    }

    if (req.method === 'GET' && path === '/api/settings') {
      const session = authenticatedRequest(req, res)
      const admin = session === undefined ? undefined : store.getAdmin(session.adminId)
      writeJson(res, 200, {
        username: admin?.username ?? '',
        port,
        host,
        databasePath: DEFAULT_DB_PATH,
        apiBaseUrl: `${host === '0.0.0.0' ? 'http://127.0.0.1' : `http://${host}`}:${port}/v1`,
      })
      return
    }

    if (req.method === 'GET' && path === '/api/dashboard') {
      const providers = store.listProviders()
      const enabled = providers.filter(record => record.enabled === 1)
      const totalModels = enabled.reduce((sum, record) => sum + registry.cachedModels(record.id).length, 0)
      const now = Date.now()
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const today = store.usageSummary({ from: todayStart.getTime() })
      const total = store.usageSummary({ to: now })
      const byModel = store.usageBreakdown('model', { from: todayStart.getTime(), to: now })
      const byProvider = store.usageBreakdown('provider_id', { from: todayStart.getTime(), to: now })
      writeJson(res, 200, {
        providers: {
          total: providers.length,
          enabled: enabled.length,
        },
        models: totalModels,
        usage: {
          today: {
            requests: today.requests,
            totalTokens: today.totalTokens,
            byModel: byModel.map(item => ({ model: item.key ?? '-', requests: item.requests, totalTokens: item.totalTokens })),
            byProvider: byProvider.map(item => ({ providerId: item.key ?? '-', requests: item.requests, totalTokens: item.totalTokens })),
          },
          total: {
            requests: total.requests,
            totalTokens: total.totalTokens,
          },
        },
      })
      return
    }

    if (req.method === 'POST' && path === '/api/settings/admin') {
      const body = await readJsonBody(req)
      const session = authenticatedRequest(req, res)
      if (session === undefined) {
        writeError(res, 401, '请先登录', 'unauthorized')
        return
      }
      const admin = store.getAdmin(session.adminId)
      if (admin === undefined) {
        writeError(res, 401, '管理员不存在', 'unauthorized')
        return
      }
      const currentPassword = String(body['currentPassword'] ?? '')
      if (!verifyPassword(currentPassword, admin.passwordHash)) {
        writeError(res, 400, '当前密码错误', 'invalid_credentials')
        return
      }
      const username = typeof body['username'] === 'string' ? body['username'].trim() : ''
      if (username === '' || username.length > 64) {
        writeError(res, 400, '用户名不能为空且不超过 64 字符', 'invalid_input')
        return
      }
      const next = String(body['newPassword'] ?? '')
      if (next !== '' && (next.length < 8 || next.length > 256)) {
        writeError(res, 400, '新密码需 8-256 字符', 'invalid_input')
        return
      }
      try {
        store.updateAdminUsername(session.adminId, username)
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('UNIQUE')) {
          writeError(res, 400, '用户名已存在', 'invalid_input')
          return
        }
        throw error
      }
      if (next !== '') store.updateAdminPassword(session.adminId, hashPassword(next))
      writeJson(res, 200, { ok: true, username })
      return
    }

    if (req.method === 'POST' && path === '/api/change-password') {
      const body = await readJsonBody(req)
      const session = authenticatedRequest(req, res)
      if (session === undefined) {
        writeError(res, 401, '请先登录', 'unauthorized')
        return
      }
      const admin = store.getAdmin(session.adminId)
      if (admin === undefined || !verifyPassword(String(body['currentPassword'] ?? ''), admin.passwordHash)) {
        writeError(res, 400, '当前密码错误', 'invalid_credentials')
        return
      }
      const next = String(body['newPassword'] ?? '')
      if (next.length < 8 || next.length > 256) {
        writeError(res, 400, '新密码需 8-256 字符', 'invalid_input')
        return
      }
      store.updateAdminPassword(session.adminId, hashPassword(next))
      writeJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && path === '/api/providers') {
      writeJson(res, 200, {
        data: store.listProviders().map(record => ({
          ...sanitizeProvider(record),
          modelCount: registry.cachedModels(record.id).length,
        })),
      })
      return
    }
    if ((req.method === 'POST' || req.method === 'PUT') && path === '/api/providers') {
      const body = await readJsonBody(req)
      const id = typeof body['id'] === 'string' ? body['id'].trim().toLowerCase() : ''
      const existing = id === '' ? undefined : store.getProvider(id)
      const record = providerRecordFromBody(body, existing)
      store.upsertProvider(record)
      await reloadProviders()
      writeJson(res, 200, { ok: true, provider: sanitizeProvider(store.getProvider(record.id) ?? record) })
      return
    }
    if (req.method === 'POST' && path === '/api/providers/test') {
      const body = await readJsonBody(req)
      const id = typeof body['id'] === 'string' ? body['id'].trim().toLowerCase() : ''
      if (!isValidProviderId(id)) {
        writeError(res, 400, '渠道 ID 仅允许小写字母、数字和连字符（1-32 位）', 'invalid_input')
        return
      }
      const record = providerRecordFromBody(body, store.getProvider(id))
      let models: import('./providers.ts').GatewayModel[]
      try {
        models = await upsertProviderInstance(registry, record, { logger: (message, detail) => logger.warn(message, detail) }).listModels()
      } catch (error: unknown) {
        writeError(res, 502, error instanceof Error ? error.message : String(error), 'connection_failed')
        return
      }
      writeJson(res, 200, { ok: true, count: models.length, models: models.map(model => model.id) })
      return
    }
    if (req.method === 'DELETE' && /^\/api\/providers\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.slice('/api/providers/'.length))
      store.deleteProvider(id)
      await reloadProviders()
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && /^\/api\/providers\/[^/]+\/refresh$/.test(path)) {
      const id = decodeURIComponent(path.slice('/api/providers/'.length, -'/refresh'.length))
      const record = store.getProvider(id)
      const provider = registry.get(id)
      if (provider === undefined && record === undefined) {
        writeError(res, 404, `渠道不存在: ${id}`, 'provider_not_found')
        return
      }
      try {
        const models = provider === undefined
          ? await upsertProviderInstance(registry, record!, { logger: (message, detail) => logger.warn(message, detail) }).listModels()
          : await registry.refreshModels(id)
        writeJson(res, 200, { ok: true, count: models.length, models: models.map(model => model.id) })
      } catch (error: unknown) {
        writeError(res, 502, error instanceof Error ? error.message : String(error), 'refresh_failed')
      }
      return
    }

    if (req.method === 'GET' && path === '/api/api-keys') {
      writeJson(res, 200, { data: store.listApiKeys().map(sanitizeApiKey) })
      return
    }
    if (req.method === 'POST' && path === '/api/api-keys') {
      const body = await readJsonBody(req)
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      if (name === '') {
        writeError(res, 400, 'key 名称不能为空', 'invalid_input')
        return
      }
      const prefixes = parseStringArray(body['modelPrefixes'] ?? [])
      const modelIds = parseStringArray(body['modelIds'] ?? [])
      const app = typeof body['app'] === 'string' && body['app'].trim() !== '' ? body['app'].trim() : 'codex'
      const generated = generateApiKey()
      store.createApiKey({
        id: generated.id,
        name,
        keyHash: generated.hash,
        key: generated.key,
        keyPrefix: generated.prefix,
        modelPrefixes: JSON.stringify(prefixes),
        modelIds: JSON.stringify(modelIds),
        app,
        createdAt: Date.now(),
      })
      writeJson(res, 200, {
        ok: true,
        key: {
          id: generated.id,
          name,
          key: generated.key,
          keyPrefix: generated.prefix,
          plaintextStored: true,
          modelPrefixes: prefixes,
          modelIds,
          app,
          createdAt: Date.now(),
        },
      })
      return
    }
    if (req.method === 'PUT' && path === '/api/api-keys') {
      const body = await readJsonBody(req)
      const id = typeof body['id'] === 'string' ? body['id'].trim() : ''
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      if (id === '' || name === '') {
        writeError(res, 400, 'key id 与名称不能为空', 'invalid_input')
        return
      }
      const existing = store.getApiKey(id)
      if (existing === undefined) {
        writeError(res, 404, 'API key 不存在', 'not_found')
        return
      }
      const prefixes = parseStringArray(body['modelPrefixes'] ?? [])
      const modelIds = parseStringArray(body['modelIds'] ?? [])
      const app = typeof body['app'] === 'string' && body['app'].trim() !== '' ? body['app'].trim() : existing.app
      store.updateApiKey(id, {
        name,
        modelPrefixes: JSON.stringify(prefixes),
        modelIds: JSON.stringify(modelIds),
        app,
      })
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && /^\/api\/api-keys\/[^/]+\/revoke$/.test(path)) {
      const id = decodeURIComponent(path.slice('/api/api-keys/'.length, -'/revoke'.length))
      store.revokeApiKey(id, Date.now())
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'DELETE' && /^\/api\/api-keys\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.slice('/api/api-keys/'.length))
      store.deleteApiKey(id)
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && /^\/api\/api-keys\/[^/]+\/cc-switch$/.test(path)) {
      const id = decodeURIComponent(path.slice('/api/api-keys/'.length, -'/cc-switch'.length))
      const key = store.getApiKey(id)
      if (key === undefined) {
        writeError(res, 404, 'API key 不存在', 'not_found')
        return
      }
      if (key.key === '') {
        writeError(res, 409, '该密钥由旧版本创建，明文未保留，无法填充', 'plaintext_missing')
        return
      }
      const storedModelIds = parseStringArray(key.modelIds)
      const baseUrl = `${host === '0.0.0.0' ? 'http://127.0.0.1' : `http://${host}`}:${port}`
      const visibleModelIds = await collectVisibleModelIds({
        modelPrefixes: parseStringArray(key.modelPrefixes),
        modelIds: storedModelIds,
      })
      const preview = buildCcSwitchPreview({ baseUrl, apiKey: key.key, models: visibleModelIds })
      await openCcSwitchImport(preview.deeplink)
      writeJson(res, 200, {
        ok: true,
        modelCount: preview.models.length,
        models: preview.models,
        instruction: `已唤起 CC Switch，请在 CC Switch 弹出的确认对话框中确认导入，共 ${preview.models.length} 个模型`,
      })
      return
    }

    if (req.method === 'GET' && path === '/api/usage') {
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      const apiKeyId = url.searchParams.get('apiKeyId') ?? undefined
      const providerId = url.searchParams.get('providerId') ?? undefined
      const model = url.searchParams.get('model') ?? undefined
      const fromNum = from === null ? undefined : Number(from)
      const toNum = to === null ? undefined : Number(to)
      const range = {
        ...(fromNum === undefined || !Number.isFinite(fromNum) ? {} : { from: fromNum }),
        ...(toNum === undefined || !Number.isFinite(toNum) ? {} : { to: toNum }),
      }
      const recentParams = url.searchParams.get('recent') === '1'
      const recentLimit = Math.min(Math.max(Number(url.searchParams.get('recentLimit') ?? 20), 1), 200)
      const recentOffset = Math.max(Number(url.searchParams.get('recentOffset') ?? 0), 0)
      const hourlyTo = Date.now()
      const hourlyFrom = new Date(hourlyTo)
      hourlyFrom.setMinutes(0, 0, 0)
      hourlyFrom.setHours(hourlyFrom.getHours() - 23)
      writeJson(res, 200, {
        summary: store.usageSummary({ ...range, ...(apiKeyId === undefined ? {} : { apiKeyId }), ...(providerId === undefined ? {} : { providerId }), ...(model === undefined ? {} : { model }) }),
        recent: store.recentUsage({ limit: recentLimit, offset: recentOffset, total: recentParams }),
        byDay: store.usageByDay(range),
        byHour: store.usageByHourContinuous({ from: hourlyFrom.getTime(), to: hourlyTo }),
        byProvider: store.usageBreakdown('provider_id', range),
        byKey: store.usageBreakdown('api_key_id', range),
        byModel: store.usageBreakdown('model', range),
      })
      return
    }

    writeError(res, 404, `No such admin route: ${req.method} ${path}`, 'not_found')
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let indexStat
    try {
      indexStat = await stat(join(webDist, 'index.html'))
    } catch {
      return false
    }
    if (!indexStat.isFile()) return false
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      pathname = '/'
    }
    if (pathname === '/') pathname = '/index.html'
    const filePath = resolve(webDist, `.${pathname}`)
    if (!filePath.startsWith(resolve(webDist) + sep)) return false
    let fileStat
    try {
      fileStat = await stat(filePath)
    } catch {
      fileStat = undefined
    }
    if (fileStat === undefined || !fileStat.isFile()) {
      if (!pathname.includes('.')) {
        const fallback = await readFile(join(webDist, 'index.html')).catch(() => undefined)
        if (fallback === undefined) return false
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': fallback.length,
          'Cache-Control': 'no-cache',
        })
        res.end(fallback)
        return true
      }
      return false
    }
    const extension = filePath.slice(filePath.lastIndexOf('.'))
    const type = MIME[extension] ?? 'application/octet-stream'
    const data = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    res.end(data)
    return true
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    try {
      if (req.method === 'GET' && (path === '/healthz' || path === '/healthz/')) {
        writeJson(res, 200, { ok: true, service: 'trae-proxy-gateway' })
        return
      }
      if (req.method === 'GET' && (path === '/status' || path === '/status/')) {
        const key = authenticateApiKey(store, req.headers.authorization)
        if (key === undefined) {
          writeError(res, 401, 'Missing or invalid API key', 'unauthorized')
          return
        }
        const providers = store.listProviders().map(record => ({
          id: record.id,
          type: record.type,
          name: record.name,
          enabled: record.enabled === 1,
          models: registry.cachedModels(record.id).length,
        }))
        writeJson(res, 200, { ok: true, providers })
        return
      }
      if (path.startsWith('/api/')) {
        await handleAdmin(req, res)
        return
      }
      if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/model')) {
        await handleV1Models(req, res)
        return
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        await handleV1Chat(req, res)
        return
      }
      if (req.method === 'POST' && path === '/v1/responses') {
        await handleV1Responses(req, res)
        return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(req, res)
        if (served) return
      }
      writeError(res, 404, `No such route: ${req.method} ${path}`, 'not_found')
    } catch (error: unknown) {
      logger.error(`gateway request failed: ${req.method} ${path}`, String(error))
      if (!res.headersSent) writeError(res, 500, 'Internal gateway error', 'internal')
      else if (!res.writableEnded) res.end()
    }
  }

  return {
    ready,
    baseUrl: () => `http://${host}:${port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      for (const socket of sockets) socket.destroy()
      server.close(error => error === undefined ? resolveClose() : rejectClose(error))
    }),
    reloadProviders,
    refreshAllModels,
    registry: () => registry,
  }
}
