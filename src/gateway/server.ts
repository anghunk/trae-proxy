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
import { copyFile, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
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

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(dirname(HERE))
export const DEFAULT_WEB_DIST = join(ROOT, 'web', 'dist')

const BODY_LIMIT = 64 * 1024 * 1024
const SESSION_COOKIE = 'trae_proxy_session'
const CC_SWITCH_DIR = join(homedir(), '.cc-switch')
const CC_SWITCH_DB_PATH = join(CC_SWITCH_DIR, 'cc-switch.db')
const CC_SWITCH_PROVIDER_ID = 'trae-proxy-gateway'
const CC_SWITCH_PROVIDER_NAME = 'Trae Proxy 统一网关'
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
  writeJson(res, status, { error: { message, type, code: type } })
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

interface CcSwitchImportResult {
  providerId: string
  models: string[]
  backupPath?: string
}

/**
 * 将网关渠道写入 cc-switch 的 Codex provider。
 *
 * cc-switch 的深链协议只能解析一个默认 model，无法携带模型目录；这里按
 * cc-switch 3.20.x 的 provider 表结构直接写入完整 modelCatalog。写入前
 * 备份数据库，并在同一事务中新增或更新渠道，避免半写入状态；不会改变
 * 用户当前选择的渠道，切换仍由 cc-switch 自己完成。
 *
 * @param options 网关地址、API key、完整网关模型 id 列表及展示名称。
 * @returns 写入的 provider id、模型列表和备份文件路径。
 * @throws 当 cc-switch 数据库不存在、被锁定或表结构不兼容时抛出错误。
 */
export async function importCcSwitchProvider(options: {
  baseUrl: string
  apiKey: string
  models: string[]
}): Promise<CcSwitchImportResult> {
  const models = [...new Set(options.models.filter(model => model.trim() !== ''))]
  const defaultModel = models[0] ?? 'gpt-4o-mini'
  const now = Date.now()
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const backupPath = join(CC_SWITCH_DIR, 'backups', `db_backup_trae_proxy_${stamp}.db`)
  try {
    await stat(CC_SWITCH_DB_PATH)
  } catch {
    throw new Error(`未找到 cc-switch 数据库：${CC_SWITCH_DB_PATH}`)
  }
  await copyFile(CC_SWITCH_DB_PATH, backupPath)

  const config = [
    'model_provider = "custom"',
    `model = ${JSON.stringify(defaultModel)}`,
    'model_catalog_json = "cc-switch-model-catalog.json"',
    '',
    '[model_providers.custom]',
    `name = ${JSON.stringify(CC_SWITCH_PROVIDER_NAME)}`,
    `base_url = ${JSON.stringify(`${options.baseUrl}/v1`)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n')
  const settingsConfig = JSON.stringify({
    auth: { OPENAI_API_KEY: options.apiKey },
    config,
    modelCatalog: {
      models: models.map(model => ({ model, displayName: model })),
    },
  })

  const db = new DatabaseSync(CC_SWITCH_DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const columns = db.prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>
    const names = new Set(columns.map(column => column.name))
    const required = [
      'id',
      'app_type',
      'name',
      'settings_config',
      'website_url',
      'category',
      'created_at',
      'sort_index',
      'meta',
      'is_current',
      'in_failover_queue',
    ]
    const missing = required.filter(name => !names.has(name))
    if (missing.length > 0) {
      throw new Error(`cc-switch 数据库版本不兼容，缺少字段：${missing.join(', ')}`)
    }
    const existing = db
      .prepare('SELECT created_at, sort_index FROM providers WHERE id = ? AND app_type = ?')
      .get(CC_SWITCH_PROVIDER_ID, 'codex') as { created_at: number | null; sort_index: number | null } | undefined
    const nextSort = db
      .prepare('SELECT COALESCE(MAX(sort_index), -1) + 1 AS value FROM providers WHERE app_type = ?')
      .get('codex') as { value: number }

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`
        INSERT INTO providers (
          id, app_type, name, settings_config, website_url, category,
          created_at, sort_index, meta, is_current, in_failover_queue
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, app_type) DO UPDATE SET
          name = excluded.name,
          settings_config = excluded.settings_config,
          website_url = excluded.website_url,
          category = excluded.category,
          meta = excluded.meta,
          in_failover_queue = excluded.in_failover_queue
      `).run(
        CC_SWITCH_PROVIDER_ID,
        'codex',
        CC_SWITCH_PROVIDER_NAME,
        settingsConfig,
        'http://127.0.0.1:39310',
        'custom',
        existing?.created_at ?? now,
        existing?.sort_index ?? nextSort.value,
        '{}',
        0,
        0,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
  return { providerId: CC_SWITCH_PROVIDER_ID, models, backupPath }
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
    const results: Array<{ providerId: string; count: number; error?: string }> = []
    for (const record of records.values()) {
      if (!record.enabled) continue
      const provider = registry.get(record.id)
      if (provider === undefined) continue
      try {
        const models = await registry.refreshModels(record.id)
        results.push({ providerId: record.id, count: models.length })
      } catch (error: unknown) {
        results.push({
          providerId: record.id,
          count: registry.cachedModels(record.id).length,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return results
  }

  function requireSession(req: IncomingMessage): boolean {
    return authenticateSession(store, sessionToken(req)) !== undefined
  }

  interface ChatInput {
    model: string
    stream: boolean
    body: Record<string, unknown>
    usage?: { requestTokens?: number; responseTokens?: number; totalTokens?: number }
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
    req.once('aborted', abort)
    req.socket.once('close', abort)

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

    const result = await registry.chat(providerId, JSON.stringify(input.body), controller.signal)
    if (!result.ok) {
      const status = result.status > 0 ? result.status : STATUS_BY_KIND[result.kind] ?? 502
      recordUsage(status)
      onError(status, result.message, result.kind)
      return
    }

    if (!input.stream) {
      const text = await result.response.text()
      let usage: { requestTokens?: number; responseTokens?: number; totalTokens?: number } | undefined
      try {
        usage = normalizeUsage((JSON.parse(text) as Record<string, unknown>)['usage'])
      } catch {
        usage = undefined
      }
      recordUsage(200, usage)
      let json: Record<string, unknown>
      try {
        json = JSON.parse(text) as Record<string, unknown>
      } catch {
        onError(502, 'upstream returned an invalid JSON response', 'server')
        return
      }
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
    let lineBuffer = ''
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
    const textLines = new TransformStream<Uint8Array, string>({
      transform(chunk, controllerInner) {
        observeUsage(chunk)
        const text = decoder.decode(chunk, { stream: true })
        const split = (lineBuffer + text).split('\n')
        lineBuffer = split.pop() ?? ''
        for (const line of split) controllerInner.enqueue(line)
      },
      flush(controllerInner) {
        if (lineBuffer !== '') controllerInner.enqueue(lineBuffer)
      },
    })
    const readable = Readable.fromWeb(source.pipeThrough(textLines) as Parameters<typeof Readable.fromWeb>[0])
    let finished = false
    const done = (status: number): void => {
      if (finished) return
      finished = true
      recordUsage(status, capturedUsage)
      onDone()
    }
    const lineFeed = async (): Promise<void> => {
      const lines = Readable.from(readable, { objectMode: true })
      for await (const chunk of lines) {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: false })
        for (const line of text.split('\n')) {
          if (line !== '') onStreamLine(line)
        }
      }
    }
    lineFeed().catch((error: unknown) => {
      if (finished) return
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
          const text = content
            .map(part => {
              if (typeof part === 'string') return part
              if (typeof part === 'object' && part !== null) {
                const record = part as Record<string, unknown>
                if (record['type'] === 'input_text' || record['type'] === 'output_text') {
                  return typeof record['text'] === 'string' ? record['text'] : ''
                }
                if (record['type'] === 'input_image' && typeof record['image_url'] === 'string') {
                  return record['image_url']
                }
              }
              return ''
            })
            .filter(text => text !== '')
          if (text.length > 0) messages.push({ role: item['role'] === 'user' ? 'user' : 'assistant', content: text.join('\n') })
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
          const fn = record['function']
          if (typeof fn !== 'object' || fn === null) continue
          const fnRecord = fn as Record<string, unknown>
          tools.push({
            type: 'function',
            function: {
              name: typeof fnRecord['name'] === 'string' ? fnRecord['name'] : '',
              description: typeof fnRecord['description'] === 'string' ? fnRecord['description'] : '',
              parameters: fnRecord['parameters'] ?? { type: 'object', properties: {} },
            },
          })
      }
      if (tools.length > 0) converted['tools'] = tools
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
    const finish = choice?.['finish_reason'] === 'tool_calls' ? 'function_call' : choice?.['finish_reason'] ?? 'stop'
    const output: Array<Record<string, unknown>> = []
    const text = typeof message?.['content'] === 'string' ? message['content'] : ''
    if (text !== '') output.push({ type: 'output_text', text, annotations: [] })
    const toolCalls = Array.isArray(message?.['tool_calls']) ? message['tool_calls'] : []
    for (const call of toolCalls) {
      if (typeof call !== 'object' || call === null) continue
      const callRecord = call as Record<string, unknown>
      const fn = callRecord['function'] as Record<string, unknown> | undefined
      let argumentsValue: unknown = ''
      if (fn !== undefined && typeof fn['arguments'] === 'string') {
        try { argumentsValue = JSON.parse(fn['arguments']) } catch { argumentsValue = fn['arguments'] }
      }
      output.push({
        type: 'function_call',
        id: callRecord['id'] ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        call_id: callRecord['id'] ?? '',
        name: fn?.['name'] ?? '',
        arguments: argumentsValue,
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
      ...(finish === undefined ? {} : { error: undefined }),
    }
  }

  function responsesSseEvent(id: string, type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data, id, sequence_number: 0 })}\n\n`
  }

  function responsesStreamLine(
    json: Record<string, unknown>,
    requestModel: string,
    id: string,
  ): Array<{ type: string; data: Record<string, unknown> }> {
    const model = typeof json['model'] === 'string' ? json['model'] : requestModel
    const choices = Array.isArray(json['choices']) ? json['choices'] : []
    const choice = choices[0] as Record<string, unknown> | undefined
    const delta = choice?.['delta'] as Record<string, unknown> | undefined
    const finish = choice?.['finish_reason']
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    if (typeof delta?.['content'] === 'string' && delta['content'] !== '') {
      events.push({ type: 'response.output_text.delta', data: { delta: delta['content'], item_id: id, output_index: 0, content_index: 0 } })
    }
    const toolCalls = Array.isArray(delta?.['tool_calls']) ? delta['tool_calls'] : []
    for (const call of toolCalls) {
      if (typeof call !== 'object' || call === null) continue
      const callRecord = call as Record<string, unknown>
      const fn = callRecord['function'] as Record<string, unknown> | undefined
      const index = typeof callRecord['index'] === 'number' ? callRecord['index'] : 0
      if (callRecord['id'] !== undefined) {
        events.push({
          type: 'response.function_call_arguments.done',
          data: {
            item_id: id,
            output_index: index,
            call_id: callRecord['id'],
            name: fn?.['name'] ?? '',
            arguments: typeof fn?.['arguments'] === 'string' ? fn['arguments'] : '',
          },
        })
      } else if (typeof fn?.['arguments'] === 'string' && fn['arguments'] !== '') {
        events.push({
          type: 'response.function_call_arguments.delta',
          data: { item_id: id, output_index: index, delta: fn['arguments'] },
        })
      }
    }
    if (finish !== undefined && finish !== null) {
      events.push({ type: 'response.completed', data: { status: 'completed' } })
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
        () => {
          // 非流式已在回调里结束响应
        },
        (status, message, kind) => {
          writeError(res, status, message, kind)
        },
      )
      return
    }

    let responseId = `resp_${Math.random().toString(36).slice(2, 14)}`
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      })
      res.write(responsesSseEvent(responseId, 'response.created', {
        response: { id: responseId, object: 'response', status: 'in_progress', model: rawInput['model'] ?? '' },
      }))
    }
    const finish = (): void => {
      if (!started) return
      res.write(responsesSseEvent(responseId, 'response.completed', {
        response: { id: responseId, object: 'response', status: 'completed', model: rawInput['model'] ?? '' },
      }))
      res.end()
    }
    await runChatInternal(
      key,
      parsed,
      req,
      json => {
        const convertedResponse = chatToResponses(json, rawInput['model'] as string)
        start()
        res.write(responsesSseEvent(responseId, 'response.output_text.delta', {
          delta: String(
            Array.isArray(convertedResponse['output'])
              ? (convertedResponse['output'] as Array<Record<string, unknown>>)[0]?.['text'] ?? ''
              : '',
          ),
          item_id: responseId,
          output_index: 0,
          content_index: 0,
        }))
        finish()
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
        for (const item of responsesStreamLine(event, String(rawInput['model'] ?? ''), responseId)) {
          res.write(responsesSseEvent(responseId, item.type, item.data))
        }
      },
      () => finish(),
      (status, message, kind) => {
        if (!started) writeError(res, status, message, kind)
        else {
          res.write(responsesSseEvent(responseId, 'error', { message, type: kind }))
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
    const model = typeof input['model'] === 'string' ? input['model'] : ''
    const slash = model.indexOf('/')
    if (model === '' || slash <= 0 || slash === model.length - 1) {
      writeError(res, 404, `Unknown model: ${model || '(empty)'}（模型 id 应为 <providerId>/<modelId>）`, 'model_not_found')
      return
    }
    const providerId = model.slice(0, slash)
    const upstreamModel = model.slice(slash + 1)
    if (key.modelPrefixes.length > 0 && !key.modelPrefixes.includes(providerId)) {
      writeError(res, 403, `API key 无权访问 provider: ${providerId}`, 'forbidden')
      return
    }
    if (key.modelIds.length > 0 && !key.modelIds.includes(`${providerId}/${upstreamModel}`)) {
      writeError(res, 403, `API key 无权访问模型: ${providerId}/${upstreamModel}`, 'forbidden')
      return
    }
    const record = records.get(providerId)
    const provider = registry.get(providerId)
    if (record === undefined || record.enabled !== 1 || provider === undefined) {
      writeError(res, 404, `Unknown provider: ${providerId}`, 'provider_not_found')
      return
    }
    const upstreamBody = { ...input, model: upstreamModel }
    const started = Date.now()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    req.once('aborted', abort)
    req.socket.once('close', abort)

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
        streamed: input['stream'] === true ? 1 : 0,
      })
    }

    const result = await registry.chat(providerId, JSON.stringify(upstreamBody), controller.signal)
    if (!result.ok) {
      const status = result.status > 0 ? result.status : STATUS_BY_KIND[result.kind] ?? 502
      recordUsage(status)
      writeError(res, status, result.message, result.kind)
      return
    }

    if (input['stream'] === true) {
      const source = result.response.body
      if (source === null) {
        recordUsage(502)
        writeError(res, 502, 'upstream returned an empty stream', 'server')
        return
      }
      let capturedUsage: { requestTokens?: number; responseTokens?: number; totalTokens?: number } | undefined
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buffer = ''
      const observe = (chunk: Uint8Array): Uint8Array => {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '' || data === '[DONE]') continue
          try {
            const event = JSON.parse(data) as Record<string, unknown>
            const usage = normalizeUsage(event['usage'])
            if (usage !== undefined) capturedUsage = usage
          } catch {
            // 非 JSON 数据行忽略
          }
        }
        return chunk
      }
      const transformed = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controllerInner) {
          controllerInner.enqueue(observe(chunk))
        },
      })
      const body = source.pipeThrough(transformed)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      })
      const readable = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
      let finished = false
      const done = (status: number): void => {
        if (finished) return
        finished = true
        recordUsage(status, capturedUsage)
      }
      readable.on('end', () => done(200))
      readable.on('close', () => done(200))
      readable.on('error', () => done(502))
      readable.pipe(res)
      return
    }

    const text = await result.response.text()
    let usage: { requestTokens?: number; responseTokens?: number; totalTokens?: number } | undefined
    try {
      usage = normalizeUsage((JSON.parse(text) as Record<string, unknown>)['usage'])
    } catch {
      usage = undefined
    }
    recordUsage(200, usage)
    res.writeHead(result.response.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    })
    res.end(text)
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    if (req.method === 'POST' && path === '/api/bootstrap') {
      if (store.hasAdmin()) {
        writeError(res, 409, '管理员已存在', 'admin_exists')
        return
      }
      const body = await readJsonBody(req)
      const username = typeof body['username'] === 'string' ? body['username'].trim() : ''
      const password = typeof body['password'] === 'string' ? body['password'] : ''
      if (username === '' || username.length > 64 || password.length < 8 || password.length > 256) {
        writeError(res, 400, '用户名不能为空（≤64 字符），密码需 8-256 字符', 'invalid_input')
        return
      }
      const admin = store.createAdmin(username, hashPassword(password))
      const session = createSession(store, admin.id)
      setSessionCookie(res, session.token, session.expiresAt)
      writeJson(res, 200, { ok: true, admin: { username: admin.username } })
      return
    }
    if (req.method === 'POST' && path === '/api/login') {
      const body = await readJsonBody(req)
      const username = typeof body['username'] === 'string' ? body['username'].trim() : ''
      const password = typeof body['password'] === 'string' ? body['password'] : ''
      const admin = store.getAdminByUsername(username)
      if (admin === undefined || !verifyPassword(password, admin.passwordHash)) {
        writeError(res, 401, '用户名或密码错误', 'invalid_credentials')
        return
      }
      const session = createSession(store, admin.id)
      setSessionCookie(res, session.token, session.expiresAt)
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
      const session = authenticateSession(store, sessionToken(req))
      if (session === undefined) {
        writeJson(res, 200, { authed: false, needsSetup: !store.hasAdmin() })
        return
      }
      writeJson(res, 200, { authed: true, needsSetup: false })
      return
    }
    if (!requireSession(req)) {
      writeError(res, 401, '请先登录', 'unauthorized')
      return
    }

    if (req.method === 'GET' && path === '/api/settings') {
      const session = authenticateSession(store, sessionToken(req))
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

    if (req.method === 'POST' && path === '/api/settings/admin') {
      const body = await readJsonBody(req)
      const session = authenticateSession(store, sessionToken(req))
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
      const session = authenticateSession(store, sessionToken(req))
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
      const result = await importCcSwitchProvider({
        baseUrl,
        apiKey: key.key,
        models: visibleModelIds,
      })
      writeJson(res, 200, {
        ok: true,
        providerId: result.providerId,
        modelCount: result.models.length,
        models: result.models,
        ...(result.backupPath === undefined ? {} : { backupPath: result.backupPath }),
        instruction: `已写入 CC Switch，共 ${result.models.length} 个模型；请回到 CC Switch 切换该渠道，列表未刷新时请重开 CC Switch`,
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
      writeJson(res, 200, {
        summary: store.usageSummary({ ...range, ...(apiKeyId === undefined ? {} : { apiKeyId }), ...(providerId === undefined ? {} : { providerId }), ...(model === undefined ? {} : { model }) }),
        recent: store.recentUsage(Number(url.searchParams.get('limit') ?? 50)),
        byDay: store.usageByDay(range),
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
