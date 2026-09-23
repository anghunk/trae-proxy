/**
 * SQLite 存储层。
 *
 * 统一模型网关的唯一事实来源是 config/trae-proxy.db（node:sqlite）。
 * 所有业务模块只通过本模块访问数据库，不直接写 SQL。
 * 数据库文件权限 0600，目录 0700，且已被 .gitignore 排除。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(dirname(HERE))
export const CONFIG_DIR = join(ROOT, 'config')
export const DEFAULT_DB_PATH = join(CONFIG_DIR, 'trae-proxy.db')

export type ProviderType =
  | 'trae-cn'
  | 'trae-ai'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama'

export interface ProviderRecord {
  id: string
  type: ProviderType
  name: string
  enabled: number
  baseUrl?: string
  apiKey?: string
  extraHeaders: string
  timeoutMs?: number
  models: string
  settings: string
  createdAt: number
  updatedAt: number
}

export interface AdminRecord {
  id: number
  username: string
  passwordHash: string
  createdAt: number
}

export interface ApiKeyRecord {
  id: string
  name: string
  keyHash: string
  key: string
  keyPrefix: string
  modelPrefixes: string
  modelIds: string
  app: string
  createdAt: number
  revokedAt?: number
}

export interface SessionRecord {
  id: string
  adminId: number
  tokenHash: string
  createdAt: number
  expiresAt: number
}

export interface UsageEventRecord {
  id: number
  ts: number
  apiKeyId?: string
  providerId?: string
  model?: string
  requestTokens: number
  responseTokens: number
  totalTokens: number
  status: number
  durationMs: number
  streamed: number
}

export interface UsageSummary {
  requests: number
  success: number
  requestTokens: number
  responseTokens: number
  totalTokens: number
  durationMs: number
}

const USAGE_FLUSH_MS = 250
const USAGE_BATCH_MAX = 200

export class GatewayStore {
  private readonly db: DatabaseSync
  private readonly usageQueue: Array<Omit<UsageEventRecord, 'id'>> = []
  private usageTimer: ReturnType<typeof setTimeout> | undefined
  private usageFlushing = false

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  static open(path: string = DEFAULT_DB_PATH): GatewayStore {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    const store = new GatewayStore(db)
    store.migrate()
    return store
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key TEXT NOT NULL DEFAULT '',
        key_prefix TEXT NOT NULL,
        model_prefixes TEXT NOT NULL DEFAULT '',
        app TEXT NOT NULL DEFAULT 'codex',
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        base_url TEXT,
        api_key TEXT,
        extra_headers TEXT NOT NULL DEFAULT '{}',
        timeout_ms INTEGER,
        models TEXT NOT NULL DEFAULT '[]',
        settings TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        admin_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        api_key_id TEXT,
        provider_id TEXT,
        model TEXT,
        request_tokens INTEGER NOT NULL DEFAULT 0,
        response_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        streamed INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_events(api_key_id);
      CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_events(provider_id);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model);
      CREATE INDEX IF NOT EXISTS idx_usage_recent ON usage_events(ts DESC, id DESC);
    `)
    const apiKeyColumns = this.db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>
    if (!apiKeyColumns.some(column => column.name === 'app')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN app TEXT NOT NULL DEFAULT 'codex'`)
    }
    if (!apiKeyColumns.some(column => column.name === 'model_ids')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN model_ids TEXT NOT NULL DEFAULT '[]'`)
    }
    if (!apiKeyColumns.some(column => column.name === 'key')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN key TEXT NOT NULL DEFAULT ''`)
    }
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO server_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  /** 首次启动判断：是否已经创建管理员。 */
  hasAdmin(): boolean {
    const row = this.db.prepare('SELECT 1 FROM admins LIMIT 1').get() as { 1?: number } | undefined
    return row !== undefined
  }

  createAdmin(username: string, passwordHash: string): AdminRecord {
    const now = Date.now()
    const result = this.db
      .prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, passwordHash, now)
    return {
      id: Number(result.lastInsertRowid),
      username,
      passwordHash,
      createdAt: now,
    }
  }

  getAdminByUsername(username: string): AdminRecord | undefined {
    const row = this.db
      .prepare('SELECT id, username, password_hash, created_at FROM admins WHERE username = ?')
      .get(username) as
      | { id: number; username: string; password_hash: string; created_at: number }
      | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    }
  }

  getAdmin(id: number): AdminRecord | undefined {
    const row = this.db
      .prepare('SELECT id, username, password_hash, created_at FROM admins WHERE id = ?')
      .get(id) as
      | { id: number; username: string; password_hash: string; created_at: number }
      | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    }
  }

  updateAdminPassword(id: number, passwordHash: string): void {
    this.db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(passwordHash, id)
  }

  updateAdminUsername(id: number, username: string): void {
    this.db.prepare('UPDATE admins SET username = ? WHERE id = ?').run(username, id)
  }

  listApiKeys(): ApiKeyRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, key_hash, key, key_prefix, model_prefixes, model_ids, app, created_at, revoked_at
         FROM api_keys ORDER BY created_at DESC`,
      )
      .all() as {
      id: string
      name: string
      key_hash: string
      key: string
      key_prefix: string
      model_prefixes: string
      model_ids: string
      app: string
      created_at: number
      revoked_at: number | null
    }[]
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      key: row.key,
      keyPrefix: row.key_prefix,
      modelPrefixes: row.model_prefixes,
      modelIds: row.model_ids,
      app: row.app,
      createdAt: row.created_at,
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    }))
  }

  getApiKey(id: string): ApiKeyRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, key_hash, key, key_prefix, model_prefixes, model_ids, app, created_at, revoked_at
         FROM api_keys WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string
          name: string
          key_hash: string
          key: string
          key_prefix: string
          model_prefixes: string
          model_ids: string
          app: string
          created_at: number
          revoked_at: number | null
        }
      | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      key: row.key,
      keyPrefix: row.key_prefix,
      modelPrefixes: row.model_prefixes,
      modelIds: row.model_ids,
      app: row.app,
      createdAt: row.created_at,
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    }
  }

  findApiKeyByHash(hash: string): ApiKeyRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, key_hash, key, key_prefix, model_prefixes, model_ids, app, created_at, revoked_at
         FROM api_keys WHERE key_hash = ?`,
      )
      .get(hash) as
      | {
          id: string
          name: string
          key_hash: string
          key: string
          key_prefix: string
          model_prefixes: string
          model_ids: string
          app: string
          created_at: number
          revoked_at: number | null
        }
      | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      key: row.key,
      keyPrefix: row.key_prefix,
      modelPrefixes: row.model_prefixes,
      modelIds: row.model_ids,
      app: row.app,
      createdAt: row.created_at,
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    }
  }

  createApiKey(record: ApiKeyRecord): void {
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key, key_prefix, model_prefixes, model_ids, app, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.keyHash,
        record.key,
        record.keyPrefix,
        record.modelPrefixes,
        record.modelIds,
        record.app,
        record.createdAt,
        record.revokedAt ?? null,
      )
  }

  updateApiKey(
    id: string,
    fields: {
      name: string
      modelPrefixes: string
      modelIds: string
      app: string
    },
  ): void {
    this.db
      .prepare(
        `UPDATE api_keys
         SET name = ?, model_prefixes = ?, model_ids = ?, app = ?
         WHERE id = ?`,
      )
      .run(fields.name, fields.modelPrefixes, fields.modelIds, fields.app, id)
  }

  revokeApiKey(id: string, at: number): void {
    this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id)
  }

  deleteApiKey(id: string): void {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  }

  listProviders(): ProviderRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, name, enabled, base_url, api_key, extra_headers, timeout_ms, models, settings, created_at, updated_at
         FROM providers ORDER BY id`,
      )
      .all() as {
      id: string
      type: string
      name: string
      enabled: number
      base_url: string | null
      api_key: string | null
      extra_headers: string
      timeout_ms: number | null
      models: string
      settings: string
      created_at: number
      updated_at: number
    }[]
    return rows.map(rowToProvider)
  }

  getProvider(id: string): ProviderRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, type, name, enabled, base_url, api_key, extra_headers, timeout_ms, models, settings, created_at, updated_at
         FROM providers WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string
          type: string
          name: string
          enabled: number
          base_url: string | null
          api_key: string | null
          extra_headers: string
          timeout_ms: number | null
          models: string
          settings: string
          created_at: number
          updated_at: number
        }
      | undefined
    return row === undefined ? undefined : rowToProvider(row)
  }

  upsertProvider(record: ProviderRecord): void {
    this.db
      .prepare(
        `INSERT INTO providers (
           id, type, name, enabled, base_url, api_key, extra_headers, timeout_ms,
           models, settings, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           name = excluded.name,
           enabled = excluded.enabled,
           base_url = excluded.base_url,
           api_key = excluded.api_key,
           extra_headers = excluded.extra_headers,
           timeout_ms = excluded.timeout_ms,
           models = excluded.models,
           settings = excluded.settings,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.type,
        record.name,
        record.enabled,
        record.baseUrl ?? null,
        record.apiKey ?? null,
        record.extraHeaders,
        record.timeoutMs ?? null,
        record.models,
        record.settings,
        record.createdAt,
        record.updatedAt,
      )
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id)
  }

  createSession(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, admin_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.adminId, record.tokenHash, record.createdAt, record.expiresAt)
  }

  findSessionByHash(hash: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, admin_id, token_hash, created_at, expires_at
         FROM sessions WHERE token_hash = ?`,
      )
      .get(hash) as
      | {
          id: string
          admin_id: number
          token_hash: string
          created_at: number
          expires_at: number
        }
      | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      adminId: row.admin_id,
      tokenHash: row.token_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  /** 续期一个有效会话，返回新的过期时间；不存在或已过期时返回 undefined。 */
  touchSession(id: string, expiresAt: number): number | undefined {
    const result = this.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ? AND expires_at > ?')
      .run(expiresAt, id, Date.now())
    if (result.changes !== 1) return undefined
    return expiresAt
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  deleteExpiredSessions(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
  }

  /**
   * 记录一次 /v1 请求用量。
   *
   * 写入先进入内存队列，由定时 flush 批量落库，避免每次对话请求都同步
   * 写 SQLite 阻塞事件循环。用量查询入口会先 flush，保证管理台看到的数据
   * 与已完成的请求一致。
   */
  insertUsage(event: Omit<UsageEventRecord, 'id'>): void {
    this.usageQueue.push(event)
    if (this.usageQueue.length >= USAGE_BATCH_MAX) {
      this.flushUsage()
      return
    }
    if (this.usageTimer !== undefined) return
    this.usageTimer = setTimeout(() => {
      this.usageTimer = undefined
      this.flushUsage()
    }, USAGE_FLUSH_MS)
    this.usageTimer.unref?.()
  }

  /** 把队列中的用量事件批量写入 SQLite（同步、幂等）。 */
  flushUsage(): void {
    if (this.usageFlushing || this.usageQueue.length === 0) return
    this.usageFlushing = true
    const insert = this.db.prepare(
      `INSERT INTO usage_events (
         ts, api_key_id, provider_id, model, request_tokens, response_tokens,
         total_tokens, status, duration_ms, streamed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    try {
      while (this.usageQueue.length > 0) {
        const event = this.usageQueue.shift() as Omit<UsageEventRecord, 'id'>
        insert.run(
          event.ts,
          event.apiKeyId ?? null,
          event.providerId ?? null,
          event.model ?? null,
          event.requestTokens,
          event.responseTokens,
          event.totalTokens,
          event.status,
          event.durationMs,
          event.streamed,
        )
      }
    } finally {
      this.usageFlushing = false
    }
  }

  /** 汇总查询：时间、key、provider、模型均为可选过滤。 */
  usageSummary(options: {
    from?: number
    to?: number
    apiKeyId?: string
    providerId?: string
    model?: string
  }): UsageSummary {
    this.flushUsage()
    const conditions: string[] = []
    const params: (number | string)[] = []
    if (options.from !== undefined) {
      conditions.push('ts >= ?')
      params.push(options.from)
    }
    if (options.to !== undefined) {
      conditions.push('ts <= ?')
      params.push(options.to)
    }
    if (options.apiKeyId !== undefined) {
      conditions.push('api_key_id = ?')
      params.push(options.apiKeyId)
    }
    if (options.providerId !== undefined) {
      conditions.push('provider_id = ?')
      params.push(options.providerId)
    }
    if (options.model !== undefined) {
      conditions.push('model = ?')
      params.push(options.model)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS requests,
           SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success,
           COALESCE(SUM(request_tokens), 0) AS request_tokens,
           COALESCE(SUM(response_tokens), 0) AS response_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(duration_ms), 0) AS duration_ms
         FROM usage_events ${where}`,
      )
      .get(...params) as {
      requests: number
      success: number | null
      request_tokens: number
      response_tokens: number
      total_tokens: number
      duration_ms: number
    }
    return {
      requests: row.requests,
      success: row.success ?? 0,
      requestTokens: row.request_tokens,
      responseTokens: row.response_tokens,
      totalTokens: row.total_tokens,
      durationMs: row.duration_ms,
    }
  }

  /** 最近用量事件（管理台最近请求表，分页；options.total 传 true 时同时返回总条数）。 */
  recentUsage(options: { limit?: number; offset?: number; total?: boolean } = {}): { rows: UsageEventRecord[]; total: number } {
    this.flushUsage()
    const limit = options.limit ?? 20
    const offset = options.offset ?? 0
    const rows = this.db
      .prepare(
        `SELECT id, ts, api_key_id, provider_id, model, request_tokens, response_tokens,
                total_tokens, status, duration_ms, streamed
         FROM usage_events ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as {
      id: number
      ts: number
      api_key_id: string | null
      provider_id: string | null
      model: string | null
      request_tokens: number
      response_tokens: number
      total_tokens: number
      status: number
      duration_ms: number
      streamed: number
    }[]
    const mapped: UsageEventRecord[] = rows.map(row => ({
      id: row.id,
      ts: row.ts,
      ...(row.api_key_id === null ? {} : { apiKeyId: row.api_key_id }),
      ...(row.provider_id === null ? {} : { providerId: row.provider_id }),
      ...(row.model === null ? {} : { model: row.model }),
      requestTokens: row.request_tokens,
      responseTokens: row.response_tokens,
      totalTokens: row.total_tokens,
      status: row.status,
      durationMs: row.duration_ms,
      streamed: row.streamed,
    }))
    if (!options.total) return { rows: mapped, total: 0 }
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }
    return { rows: mapped, total: Number(total.n) }
  }

  /** 按 provider/model/api key 汇总（管理台图表）。 */
  usageBreakdown(
    column: 'api_key_id' | 'provider_id' | 'model',
    options: { from?: number; to?: number } = {},
  ): Array<{
    key: string | null
    requests: number
    success: number
    requestTokens: number
    responseTokens: number
    totalTokens: number
  }> {
    this.flushUsage()
    const conditions: string[] = []
    const params: (number | string)[] = []
    if (options.from !== undefined) {
      conditions.push('ts >= ?')
      params.push(options.from)
    }
    if (options.to !== undefined) {
      conditions.push('ts <= ?')
      params.push(options.to)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT ${column} AS key, COUNT(*) AS requests,
                SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success,
                COALESCE(SUM(request_tokens), 0) AS request_tokens,
                COALESCE(SUM(response_tokens), 0) AS response_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM usage_events ${where}
         GROUP BY ${column} ORDER BY requests DESC`,
      )
      .all(...params) as {
      key: string | null
      requests: number
      success: number | null
      request_tokens: number
      response_tokens: number
      total_tokens: number
    }[]
    return rows.map(row => ({
      key: row.key,
      requests: row.requests,
      success: row.success ?? 0,
      requestTokens: row.request_tokens,
      responseTokens: row.response_tokens,
      totalTokens: row.total_tokens,
    }))
  }

  /** 按天汇总（用量图表；本地时区按 ts 偏移切分，前端按天显示）。 */
  usageByDay(options: { from?: number; to?: number } = {}): Array<{
    day: string
    requests: number
    success: number
    totalTokens: number
  }> {
    this.flushUsage()
    const conditions: string[] = []
    const params: (number | string)[] = []
    if (options.from !== undefined) {
      conditions.push('ts >= ?')
      params.push(options.from)
    }
    if (options.to !== undefined) {
      conditions.push('ts <= ?')
      params.push(options.to)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS requests,
                SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM usage_events ${where}
         GROUP BY day ORDER BY day`,
      )
      .all(...params) as {
      day: string
      requests: number
      success: number | null
      total_tokens: number
    }[]
    return rows.map(row => ({
      day: row.day,
      requests: row.requests,
      success: row.success ?? 0,
      totalTokens: row.total_tokens,
    }))
  }

  /** 按小时汇总（用量图表；本地时区按 ts 偏移切分，前端按小时显示）。 */
  usageByHour(options: { from?: number; to?: number } = {}): Array<{
    hour: string
    requests: number
    success: number
    totalTokens: number
  }> {
    this.flushUsage()
    const conditions: string[] = []
    const params: (number | string)[] = []
    if (options.from !== undefined) {
      conditions.push('ts >= ?')
      params.push(options.from)
    }
    if (options.to !== undefined) {
      conditions.push('ts <= ?')
      params.push(options.to)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d %H:00', ts / 1000, 'unixepoch', 'localtime') AS hour,
                COUNT(*) AS requests,
                SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM usage_events ${where}
         GROUP BY hour ORDER BY hour`,
      )
      .all(...params) as {
      hour: string
      requests: number
      success: number | null
      total_tokens: number
    }[]
    return rows.map(row => ({
      hour: row.hour,
      requests: row.requests,
      success: row.success ?? 0,
      totalTokens: row.total_tokens,
    }))
  }

  /** 返回 from 到 to 之间连续小时段（含两端），无数据的小时补零，用于 24 小时用量图表。 */
  usageByHourContinuous(options: { from: number; to: number }): Array<{
    hour: string
    requests: number
    success: number
    totalTokens: number
  }> {
    const byHour = this.usageByHour(options)
    const byHourMap = new Map(byHour.map(item => [item.hour, item]))
    const result: Array<{ hour: string; requests: number; success: number; totalTokens: number }> = []
    const cursor = new Date(options.from)
    cursor.setMinutes(0, 0, 0)
    const end = new Date(options.to)
    end.setMinutes(0, 0, 0)
    while (cursor.getTime() <= end.getTime()) {
      const hour = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')} ${String(cursor.getHours()).padStart(2, '0')}:00`
      result.push(byHourMap.get(hour) ?? { hour, requests: 0, success: 0, totalTokens: 0 })
      cursor.setHours(cursor.getHours() + 1)
    }
    return result
  }

  /** 清理指定时间之前的用量事件，返回删除行数。 */
  pruneUsage(before: number): number {
    this.flushUsage()
    const result = this.db.prepare('DELETE FROM usage_events WHERE ts < ?').run(before)
    return Number(result.changes)
  }

  close(): void {
    if (this.usageTimer !== undefined) {
      clearTimeout(this.usageTimer)
      this.usageTimer = undefined
    }
    this.flushUsage()
    this.db.close()
  }
}

function rowToProvider(row: {
  id: string
  type: string
  name: string
  enabled: number
  base_url: string | null
  api_key: string | null
  extra_headers: string
  timeout_ms: number | null
  models: string
  settings: string
  created_at: number
  updated_at: number
}): ProviderRecord {
  return {
    id: row.id,
    type: row.type as ProviderType,
    name: row.name,
    enabled: row.enabled,
    ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
    ...(row.api_key === null ? {} : { apiKey: row.api_key }),
    extraHeaders: row.extra_headers,
    ...(row.timeout_ms === null ? {} : { timeoutMs: row.timeout_ms }),
    models: row.models,
    settings: row.settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 供测试/脚本直接打开。 */
export function openGatewayStore(path: string = DEFAULT_DB_PATH): GatewayStore {
  return GatewayStore.open(path)
}
