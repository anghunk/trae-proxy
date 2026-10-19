/**
 * WorkBuddy 登录态与直连客户端。
 *
 * WorkBuddy 桌面端 5.6 起把凭据以 `$wbEncrypted` 信封加密落盘，外部进程读不出来；
 * 桌面端 daemon 暴露的 wbipc `http.fetch` 又是 call 型 RPC，宿主硬编码了 50s 超时
 * 且 v1 协议没有任何 stream 方法，因此长回答必然被上游超时掐断。
 *
 * 这里改用 WorkBuddy 官方（浏览器）OAuth：换取 access / refresh token 后直连
 * `https://copilot.tencent.com/v2`，做真正的 SSE 流式转发，彻底绕开 daemon 的限制。
 * 协议细节参考 magpie-community/plugins 的 workbuddy 插件。
 *
 * @module trae-proxy/gateway/providers/workbuddy-auth
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** WorkBuddy 国内版（CodeBuddy 套餐）服务地址。 */
export const WORKBUDDY_ENDPOINT = 'https://copilot.tencent.com'
/** 对话与插件接口前缀。 */
export const WORKBUDDY_API = `${WORKBUDDY_ENDPOINT}/v2`
/** WorkBuddy 客户端版本号；上游按 `User-Agent: WorkBuddy/<v>` 校验。 */
const UA_VERSION = '5.5.6'
/** 打开登录页时附带的客户端版本。 */
const APP_VERSION = '2.0.0'
/** 产品线标识，换取登录页与模型目录时都要带上。 */
const PLATFORM = 'workbuddy'
/** access token 到期前的刷新提前量。 */
const REFRESH_LEAD_MS = 60_000
/** 浏览器登录轮询时的“尚未完成”业务码。 */
const PENDING_CODE = 11217

/** 一次可用的 WorkBuddy 登录态。 */
export interface WorkbuddyCredential {
  access: string
  refresh?: string
  /** access token 到期时间（毫秒时间戳）。 */
  expires: number
  /** refresh token 到期时间（毫秒时间戳）；缺失表示未知。 */
  refreshExpiresAt?: number
  /** 登录域，请求头 `X-Domain` 使用。 */
  domain: string
  tokenType?: string
  /** 账号 uid，请求头 `X-User-Id` 使用。 */
  uid: string
  /** 展示用账号名。 */
  accountId: string
  /** 企业（团队）账号的 id；个人账号为空。 */
  enterpriseId?: string
  /** 凭据来源，用于管理台区分“本代理登录”与“导入的本地登录态”。 */
  source?: 'login' | 'imported'
}

/** 上游返回的业务错误。 */
export class WorkbuddyApiError extends Error {
  readonly code: number
  readonly status: number

  constructor(message: string, code: number, status: number) {
    super(message)
    this.name = 'WorkbuddyApiError'
    this.code = code
    this.status = status
  }
}

/** 解析 WorkBuddy 的 `{code, msg, data}` 信封。 */
async function callApi(
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    signal?: AbortSignal
    timeoutMs?: number
    /** 允许的错误业务码，命中时按正常返回处理。 */
    acceptCodes?: readonly number[]
  } = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `WorkBuddy/${UA_VERSION}`,
    ...options.headers,
  }
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000)
  let response: Response
  try {
    response = await fetch(`${WORKBUDDY_ENDPOINT}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
      signal,
    })
  } catch (error: unknown) {
    throw new WorkbuddyApiError(
      `WorkBuddy 网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
      0,
      0,
    )
  }
  const text = await response.text()
  let envelope: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      envelope = parsed as Record<string, unknown>
    }
  } catch {
    envelope = {}
  }
  const code = typeof envelope['code'] === 'number' ? envelope['code'] : 0
  const accepted = code === 0 || (options.acceptCodes?.includes(code) ?? false)
  if (!response.ok || !accepted) {
    const detail = typeof envelope['msg'] === 'string' && envelope['msg'] !== ''
      ? envelope['msg']
      : text.trim().slice(0, 200) || response.statusText
    const suffix = code === 0 ? `HTTP ${response.status}` : `HTTP ${response.status}, code ${code}`
    throw new WorkbuddyApiError(`WorkBuddy: ${detail}（${suffix}）`, code, response.status)
  }
  const data = envelope['data']
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : envelope
}

/** 从 token 响应里构造登录态。 */
function credentialFromToken(
  token: Record<string, unknown>,
  extra: { uid?: string; accountId?: string; enterpriseId?: string; domain?: string; source?: 'login' | 'imported' },
  now = Date.now(),
): WorkbuddyCredential | undefined {
  const access = typeof token['accessToken'] === 'string' ? token['accessToken'] : ''
  if (access === '') return undefined
  const expiresAt = typeof token['expiresAt'] === 'number' && token['expiresAt'] > 0
    ? token['expiresAt']
    : typeof token['expiresIn'] === 'number' && token['expiresIn'] > 0
      ? now + token['expiresIn'] * 1000
      : 0
  const refreshExpiresAt = typeof token['refreshExpiresAt'] === 'number' && token['refreshExpiresAt'] > 0
    ? token['refreshExpiresAt']
    : typeof token['refreshExpiresIn'] === 'number' && token['refreshExpiresIn'] > 0
      ? now + token['refreshExpiresIn'] * 1000
      : undefined
  const refresh = typeof token['refreshToken'] === 'string' && token['refreshToken'] !== ''
    ? token['refreshToken']
    : undefined
  const domain = typeof token['domain'] === 'string' && token['domain'] !== ''
    ? token['domain']
    : extra.domain ?? 'www.workbuddy.cn'
  const tokenType = typeof token['tokenType'] === 'string' && token['tokenType'] !== ''
    ? token['tokenType']
    : undefined
  return {
    access,
    ...refresh === undefined ? {} : { refresh },
    expires: expiresAt,
    ...refreshExpiresAt === undefined ? {} : { refreshExpiresAt },
    domain,
    ...tokenType === undefined ? {} : { tokenType },
    uid: extra.uid ?? '',
    accountId: extra.accountId ?? extra.uid ?? 'WorkBuddy',
    ...extra.enterpriseId === undefined || extra.enterpriseId === '' ? {} : { enterpriseId: extra.enterpriseId },
    ...extra.source === undefined ? {} : { source: extra.source },
  }
}

/** 企业（团队）账号要在每个请求上带的企业头。 */
function enterpriseHeaders(credential: WorkbuddyCredential): Record<string, string> {
  const id = typeof credential.enterpriseId === 'string' ? credential.enterpriseId.trim() : ''
  return id === '' ? {} : { 'X-Enterprise-Id': id, 'X-Tenant-Id': id }
}

/**
 * 组装对话请求头。
 *
 * 上游只接受自己的客户端特征：`User-Agent: WorkBuddy/<v>`，加上账号、
 * 客户端归因与对话 id 三组头。缺 User-Agent 会被判 unknown channel。
 *
 * `conversation.requestId` 对应上游 `X-Conversation-Request-ID`：WorkBuddy 后端
 * 以它统计“一次用户发送”。同一轮里的重试、工具回传要保持同一个值，用户下一条
 * 消息换成新值，因此由调用方按轮次派生，而不是按 HTTP 请求生成。
 */
export function buildWorkbuddyHeaders(
  credential: WorkbuddyCredential,
  conversation?: { conversationId?: string; messageId?: string; requestId?: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${credential.access}`,
    'X-User-Id': credential.uid,
    'X-Domain': credential.domain,
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'User-Agent': `WorkBuddy/${UA_VERSION}`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': UA_VERSION,
    ...enterpriseHeaders(credential),
  }
  const messageId = conversation?.messageId ?? ''
  if (messageId !== '') {
    headers['X-Conversation-Message-ID'] = messageId
    headers['X-Request-ID'] = conversation?.requestId ?? messageId
  }
  const conversationId = conversation?.conversationId ?? ''
  if (conversationId !== '') headers['X-Conversation-ID'] = conversationId.slice(0, 128)
  const requestId = conversation?.requestId ?? ''
  if (requestId !== '') {
    headers['X-Conversation-Request-ID'] = requestId.slice(0, 128)
  }
  return headers
}

/**
 * 读取 WorkBuddy 产品配置（模型目录）。
 *
 * `User-Agent` 必须是 `CLI/<v> WorkBuddy/<v>`：只用 `WorkBuddy/<v>` 时上游会
 * 认为请求来自 IDE 而不是 CLI agent，返回的模型列表不含 `cli` 子集。
 */
export async function fetchWorkbuddyConfig(
  credential: WorkbuddyCredential,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${credential.access}`,
    'X-User-Id': credential.uid,
    'X-Domain': credential.domain,
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'User-Agent': `CLI/${APP_VERSION} WorkBuddy/${UA_VERSION}`,
    'X-Requested-With': 'XMLHttpRequest',
    ...enterpriseHeaders(credential),
  }
  return callApi('/v3/config', { headers, signal, timeoutMs: 15_000 })
}

/** 用 refresh token 换一份新的登录态。 */
export async function refreshWorkbuddyCredential(
  credential: WorkbuddyCredential,
  signal?: AbortSignal,
): Promise<WorkbuddyCredential> {
  const refresh = credential.refresh ?? ''
  if (refresh === '') throw new WorkbuddyApiError('登录态已过期，请重新登录 WorkBuddy', 0, 401)
  const token = await callApi('/v2/plugin/auth/token/refresh', {
    method: 'POST',
    body: {},
    signal,
    timeoutMs: 20_000,
    headers: {
      'X-Refresh-Token': refresh,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': credential.domain,
      ...enterpriseHeaders(credential),
    },
  })
  const next = credentialFromToken(token, {
    uid: credential.uid,
    accountId: credential.accountId,
    ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
    domain: credential.domain,
    ...credential.source === undefined ? {} : { source: credential.source },
  })
  if (next === undefined) throw new WorkbuddyApiError('WorkBuddy 未返回新的 access token', 0, 502)
  // 上游偶尔不回 refresh token，沿用旧的，避免下次刷新失败。
  return { ...next, refresh: next.refresh ?? refresh, refreshExpiresAt: next.refreshExpiresAt ?? credential.refreshExpiresAt }
}

/** 浏览器登录的一次发起结果。 */
export interface WorkbuddyLoginStart {
  state: string
  url: string
}

/**
 * 发起一次浏览器登录。
 *
 * 返回的 `url` 需要用户在浏览器里打开；`state` 用于后续轮询换取凭据。
 */
export async function startWorkbuddyLogin(): Promise<WorkbuddyLoginStart> {
  const state = await callApi(`/v2/plugin/auth/state?platform=${encodeURIComponent(PLATFORM)}`, {
    method: 'POST',
    body: {},
    timeoutMs: 20_000,
    headers: {
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
    },
  })
  const rawState = typeof state['state'] === 'string' ? state['state'] : ''
  const authUrl = typeof state['authUrl'] === 'string' ? state['authUrl'] : ''
  if (rawState === '' || authUrl === '') throw new WorkbuddyApiError('WorkBuddy 未返回登录页地址', 0, 502)
  const url = new URL(authUrl)
  if (url.protocol !== 'https:') throw new WorkbuddyApiError('WorkBuddy 登录页不是 https', 0, 502)
  url.searchParams.set('version', APP_VERSION)
  return { state: rawState, url: url.toString() }
}

/** 浏览器登录轮询结果。 */
export type WorkbuddyLoginPoll =
  | { status: 'pending' }
  | { status: 'done'; credential: WorkbuddyCredential }
  | { status: 'failed'; error: string }

/**
 * 轮询一次浏览器登录结果。
 *
 * 未完成时上游返回业务码 11217，这里映射为 `pending`，由调用方按秒重试。
 */
export async function pollWorkbuddyLogin(state: string): Promise<WorkbuddyLoginPoll> {
  let token: Record<string, unknown>
  try {
    token = await callApi(`/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      timeoutMs: 20_000,
      acceptCodes: [PENDING_CODE],
    })
  } catch (error: unknown) {
    if (error instanceof WorkbuddyApiError && error.code === PENDING_CODE) return { status: 'pending' }
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  const access = typeof token['accessToken'] === 'string' ? token['accessToken'] : ''
  if (access === '') return { status: 'pending' }
  const domain = typeof token['domain'] === 'string' && token['domain'] !== '' ? token['domain'] : undefined
  let uid = ''
  let accountId = ''
  let enterpriseId = ''
  try {
    const who = await callApi(`/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
      timeoutMs: 20_000,
      headers: {
        Authorization: `Bearer ${access}`,
        'X-Domain': domain ?? 'www.workbuddy.cn',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
      },
    })
    uid = typeof who['uid'] === 'string' ? who['uid'] : ''
    accountId = typeof who['nickname'] === 'string' && who['nickname'] !== ''
      ? who['nickname']
      : typeof who['phoneNumber'] === 'string' ? who['phoneNumber'] : ''
    enterpriseId = typeof who['enterpriseId'] === 'string' ? who['enterpriseId'] : ''
  } catch {
    // 账号信息拿不到不影响使用，uid 留空即可
  }
  const credential = credentialFromToken(token, {
    uid,
    accountId: accountId === '' ? domain ?? 'WorkBuddy' : accountId,
    ...enterpriseId === '' ? {} : { enterpriseId },
    ...domain === undefined ? {} : { domain },
    source: 'login',
  })
  if (credential === undefined) return { status: 'failed', error: 'WorkBuddy 返回的凭据不完整' }
  return { status: 'done', credential }
}

/** WorkBuddy 桌面端 auth 文件候选路径（含国际版）。 */
function desktopCredentialPaths(): string[] {
  const home = homedir()
  const base = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'CodeBuddyExtension')
    : process.platform === 'win32'
      ? join(home, 'AppData', 'Local', 'CodeBuddyExtension')
      : join(home, '.local', 'share', 'CodeBuddyExtension')
  return [
    join(base, 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    join(base, 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info'),
  ]
}

/** magpie / OpenCode 保存的 WorkBuddy 登录态候选路径。 */
function magpieCredentialPaths(): string[] {
  const home = homedir()
  return [
    join(home, '.config', 'magpie', 'plugin-auth.json'),
    join(home, '.local', 'share', 'opencode', 'auth.json'),
  ]
}

/**
 * 尝试从本机其它客户端导入一份 WorkBuddy 登录态。
 *
 * 只导入 access token，刻意丢弃 refresh token：刷新 token 是一次性的，
 * 两个客户端同时持有并刷新会把对方挤下线。导入的登录态过期后需要在本代理里重新登录。
 */
export function importLocalCredential(): WorkbuddyCredential | undefined {
  for (const path of magpieCredentialPaths()) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const entry = parsed['workbuddy']
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (record['type'] !== 'oauth') continue
      const access = typeof record['access'] === 'string' ? record['access'] : ''
      if (access === '') continue
      return {
        access,
        expires: typeof record['expires'] === 'number' ? record['expires'] : 0,
        domain: typeof record['domain'] === 'string' && record['domain'] !== '' ? record['domain'] : 'www.workbuddy.cn',
        uid: typeof record['uid'] === 'string' ? record['uid'] : '',
        accountId: typeof record['accountId'] === 'string' && record['accountId'] !== ''
          ? record['accountId']
          : 'WorkBuddy',
        ...typeof record['enterpriseId'] === 'string' && record['enterpriseId'] !== ''
          ? { enterpriseId: record['enterpriseId'] }
          : {},
        source: 'imported',
      }
    } catch {
      // 候选文件不存在或不可解析时继续尝试下一个
    }
  }
  for (const path of desktopCredentialPaths()) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const auth = parsed['auth']
      const account = parsed['account']
      if (typeof auth !== 'object' || auth === null) continue
      const access = (auth as Record<string, unknown>)['accessToken']
      // 5.6+ 的 accessToken 是 {$wbEncrypted, envelope}，外部进程解不开。
      if (typeof access !== 'string' || access === '') continue
      const uid = typeof account === 'object' && account !== null
        ? (account as Record<string, unknown>)['uid']
        : undefined
      const nickname = typeof account === 'object' && account !== null
        ? (account as Record<string, unknown>)['nickname']
        : undefined
      const enterpriseId = typeof account === 'object' && account !== null
        ? (account as Record<string, unknown>)['enterpriseId']
        : undefined
      const domain = (auth as Record<string, unknown>)['domain']
      return {
        access,
        expires: 0,
        domain: typeof domain === 'string' && domain !== '' ? domain : 'www.workbuddy.cn',
        uid: typeof uid === 'string' ? uid : '',
        accountId: typeof nickname === 'string' && nickname !== '' ? nickname : 'WorkBuddy',
        ...typeof enterpriseId === 'string' && enterpriseId !== '' ? { enterpriseId } : {},
        source: 'imported',
      }
    } catch {
      // 同上
    }
  }
  return undefined
}

/**
 * 一份登录态的持久化与刷新。
 *
 * 凭据写在 `config/` 下的独立文件（0600），不放进 provider.settings——
 * settings 会通过管理台接口回传，不适合承载令牌。
 */
export class WorkbuddyCredentialStore {
  private readonly filePath: string
  private readonly logger?: (message: string, detail?: unknown) => void
  private credential: WorkbuddyCredential | undefined
  private loaded = false
  private refreshing: Promise<WorkbuddyCredential> | undefined

  constructor(filePath: string, logger?: (message: string, detail?: unknown) => void) {
    this.filePath = filePath
    this.logger = logger
  }

  /** 读取已保存的登录态；没有保存过时尝试导入本机其它客户端的登录态。 */
  load(): WorkbuddyCredential | undefined {
    if (this.loaded) return this.credential
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>
      // 用户显式退出登录后不re-import本机其它客户端的凭据，否则“退出”会被立刻撤销
      if (parsed['signedOut'] === true) return undefined
      const credential = normalizeStoredCredential(parsed)
      if (credential !== undefined) {
        this.credential = credential
        return credential
      }
    } catch {
      // 文件不存在或损坏时继续走导入
    }
    const imported = importLocalCredential()
    if (imported !== undefined) this.credential = imported
    return this.credential
  }

  /** 覆盖保存登录态。 */
  save(credential: WorkbuddyCredential): void {
    this.credential = credential
    this.loaded = true
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      writeFileSync(this.filePath, JSON.stringify(credential, null, 2), { encoding: 'utf8', mode: 0o600 })
      chmodSync(this.filePath, 0o600)
    } catch (error: unknown) {
      this.logger?.('workbuddy 保存登录态失败', String(error))
    }
  }

  /** 清除登录态（管理台“退出登录”）。 */
  clear(): void {
    this.credential = undefined
    this.loaded = true
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      writeFileSync(this.filePath, JSON.stringify({ signedOut: true }), { encoding: 'utf8', mode: 0o600 })
      chmodSync(this.filePath, 0o600)
    } catch (error: unknown) {
      this.logger?.('workbuddy 写入退出标记失败', String(error))
    }
  }

  /**
   * 返回一份可用的登录态，必要时先刷新。
   *
   * 导入来源没有 refresh token，只能等它自然过期后由用户重新登录；
   * 刷新失败但 access token 仍在有效期内时继续沿用旧 token。
   */
  async ensure(signal?: AbortSignal): Promise<WorkbuddyCredential> {
    const credential = this.load()
    if (credential === undefined) {
      throw new WorkbuddyApiError(
        'WorkBuddy 未登录：请在管理台的该渠道里点“登录 WorkBuddy”，完成一次浏览器授权',
        0,
        401,
      )
    }
    if (credential.expires === 0 || Date.now() < credential.expires - REFRESH_LEAD_MS) return credential
    if (credential.refresh === undefined || credential.refresh === '') return credential
    if (credential.refreshExpiresAt !== undefined && Date.now() >= credential.refreshExpiresAt) return credential
    const refreshing = this.refreshing ?? this.startRefresh(credential, signal)
    try {
      return await refreshing
    } catch (error: unknown) {
      this.logger?.('workbuddy 刷新登录态失败', String(error))
      return credential
    }
  }

  /**
   * 强制刷新并保存登录态。
   *
   * 用于上游提前作废 access token（返回 401）时的重试；与 `ensure` 共用
   * 单飞状态，避免同一个 refresh token 被并发消费两次。
   *
   * @param credential 当前登录态。
   * @param signal 调用方中断信号。
   */
  async saveRefreshed(credential: WorkbuddyCredential, signal?: AbortSignal): Promise<WorkbuddyCredential> {
    const refreshing = this.refreshing ?? this.startRefresh(credential, signal)
    return refreshing
  }

  private startRefresh(credential: WorkbuddyCredential, signal?: AbortSignal): Promise<WorkbuddyCredential> {
    this.refreshing = refreshWorkbuddyCredential(credential, signal)
      .then(next => {
        this.save(next)
        this.logger?.('workbuddy 登录态已刷新', { accountId: next.accountId })
        return next
      })
      .finally(() => {
        this.refreshing = undefined
      })
    return this.refreshing
  }
}

/** 校验并归一化磁盘上的登录态结构。 */
function normalizeStoredCredential(raw: Record<string, unknown>): WorkbuddyCredential | undefined {
  const access = typeof raw['access'] === 'string' ? raw['access'] : ''
  if (access === '') return undefined
  return {
    access,
    ...typeof raw['refresh'] === 'string' && raw['refresh'] !== '' ? { refresh: raw['refresh'] } : {},
    expires: typeof raw['expires'] === 'number' ? raw['expires'] : 0,
    ...typeof raw['refreshExpiresAt'] === 'number' ? { refreshExpiresAt: raw['refreshExpiresAt'] } : {},
    domain: typeof raw['domain'] === 'string' && raw['domain'] !== '' ? raw['domain'] : 'www.workbuddy.cn',
    ...typeof raw['tokenType'] === 'string' && raw['tokenType'] !== '' ? { tokenType: raw['tokenType'] } : {},
    uid: typeof raw['uid'] === 'string' ? raw['uid'] : '',
    accountId: typeof raw['accountId'] === 'string' && raw['accountId'] !== '' ? raw['accountId'] : 'WorkBuddy',
    ...typeof raw['enterpriseId'] === 'string' && raw['enterpriseId'] !== ''
      ? { enterpriseId: raw['enterpriseId'] }
      : {},
    ...raw['source'] === 'login' || raw['source'] === 'imported' ? { source: raw['source'] } : {},
  }
}

/** 管理台展示用的登录态摘要。 */
export function describeCredential(credential: WorkbuddyCredential | undefined): {
  signedIn: boolean
  accountId?: string
  uid?: string
  source?: string
  expiresAt?: number
  refreshable: boolean
  expired: boolean
} {
  if (credential === undefined) return { signedIn: false, refreshable: false, expired: false }
  const expired = credential.expires > 0 && Date.now() >= credential.expires
  return {
    signedIn: true,
    accountId: credential.accountId,
    uid: credential.uid,
    ...credential.source === undefined ? {} : { source: credential.source },
    ...credential.expires > 0 ? { expiresAt: credential.expires } : {},
    refreshable: credential.refresh !== undefined && credential.refresh !== '',
    expired,
  }
}
