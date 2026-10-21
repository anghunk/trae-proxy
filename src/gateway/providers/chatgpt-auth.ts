/**
 * ChatGPT 订阅授权与凭据管理。
 *
 * 该实现遵循 OpenAI Sign in with ChatGPT 的开源客户端动态注册流程：
 * 使用 PKCE 在系统浏览器完成授权，回调到本机 127.0.0.1，随后用短期
 * access token 调用公开的 Responses API。凭据单独存放在 config 目录，
 * 不进入数据库，也不通过管理台接口回传。
 *
 * @module trae-proxy/gateway/providers/chatgpt-auth
 */

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type JsonWebKey,
} from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname } from 'node:path'

const AUTHORIZE_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize'
const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token'
const DISCOVERY_ENDPOINT = 'https://auth.openai.com/.well-known/openid-configuration'
const CALLBACK_PATH = '/auth/callback'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORTS = [1455, 1456, 1457, 1458, 1459, 1460, 1461, 1462]
const RESOURCE = 'https://api.openai.com/v1'
const APP_NAME = 'trae-proxy'
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  PLAN_SCOPE,
].join(' ')
const REFRESH_LEAD_MS = 60_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const DISCOVERY_TTL_MS = 10 * 60_000

/** 一次 ChatGPT 订阅授权的持久化凭据。 */
export interface ChatgptCredential {
  extAgentHostId: string
  clientId?: string
  email?: string
  subject?: string
  idToken?: string
  accessToken?: string
  refreshToken?: string
  tokenType?: string
  expiresAt?: number
  earliestRefreshAt?: number
  scopes?: string[]
  savedAt?: number
  signedOut?: boolean
}

/** 管理台展示的登录态摘要。 */
export interface ChatgptSessionDescription {
  signedIn: boolean
  accountId?: string
  email?: string
  expiresAt?: number
  refreshable: boolean
  expired: boolean
  planUsage: boolean
}

/** 发起授权后返回给管理台的登录页地址。 */
export interface ChatgptLoginStart {
  url: string
}

/** 轮询授权结果。 */
export type ChatgptLoginPoll =
  | { status: 'pending' }
  | { status: 'done'; accountId: string }
  | { status: 'failed'; error: string }

interface DiscoveryDocument {
  issuer: string
  jwksUri: string
  revocationEndpoint?: string
}

interface IdTokenClaims {
  iss?: unknown
  aud?: unknown
  exp?: unknown
  nbf?: unknown
  nonce?: unknown
  sub?: unknown
  email?: unknown
}

interface PendingLogin {
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  server: Server
  timer: ReturnType<typeof setTimeout>
  finished: boolean
  result?: ChatgptLoginPoll
}

const pendingLogins = new Map<string, PendingLogin>()
let discoveryCache: { at: number; value: DiscoveryDocument } | undefined
let jwksCache: { at: number; value: Record<string, unknown>[] } | undefined

function endpointError(status: number, text: string, fallback: string): Error {
  let message = text.trim()
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const error = parsed['error']
    if (typeof error === 'object' && error !== null) {
      const detail = (error as Record<string, unknown>)['message']
      if (typeof detail === 'string' && detail !== '') message = detail
    } else if (typeof error === 'string' && error !== '') {
      const description = typeof parsed['error_description'] === 'string'
        ? parsed['error_description']
        : ''
      message = description === '' ? error : `${error}: ${description}`
    } else if (typeof parsed['detail'] === 'string') {
      message = parsed['detail']
    }
  } catch {
    // 非 JSON 错误保留原始文本
  }
  return new Error(`${fallback}（HTTP ${status}）${message === '' ? '' : `: ${message.slice(0, 300)}`}`)
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  if (!response.ok) throw endpointError(response.status, text, 'ChatGPT 授权请求失败')
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('unexpected JSON')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('ChatGPT 授权服务返回了不可解析的 JSON')
  }
}

async function discovery(): Promise<DiscoveryDocument> {
  if (discoveryCache !== undefined && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.value
  }
  const document = await fetchJson(DISCOVERY_ENDPOINT)
  const issuer = typeof document['issuer'] === 'string' ? document['issuer'] : ''
  const jwksUri = typeof document['jwks_uri'] === 'string' ? document['jwks_uri'] : ''
  if (issuer === '' || jwksUri === '') throw new Error('ChatGPT OIDC 配置缺少 issuer 或 jwks_uri')
  const value: DiscoveryDocument = {
    issuer,
    jwksUri,
    ...typeof document['revocation_endpoint'] === 'string'
      ? { revocationEndpoint: document['revocation_endpoint'] }
      : {},
  }
  discoveryCache = { at: Date.now(), value }
  return value
}

async function jwks(): Promise<Record<string, unknown>[]> {
  if (jwksCache !== undefined && Date.now() - jwksCache.at < DISCOVERY_TTL_MS) {
    return jwksCache.value
  }
  const config = await discovery()
  const document = await fetchJson(config.jwksUri)
  const keys = Array.isArray(document['keys']) ? document['keys'] : []
  const value = keys.filter((key): key is Record<string, unknown> =>
    typeof key === 'object' && key !== null && !Array.isArray(key))
  if (value.length === 0) throw new Error('ChatGPT OIDC 配置没有可用的签名公钥')
  jwksCache = { at: Date.now(), value }
  return value
}

function decodeSegment(segment: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('ID token 格式无效')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ID token 载荷无效')
  }
  return parsed as Record<string, unknown>
}

/**
 * 校验 ID token 的签名、issuer、audience、有效期和本次授权的 nonce。
 */
async function validateIdToken(token: string, clientId: string, expectedNonce?: string): Promise<IdTokenClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('ID token 不是三段式 JWT')
  const header = decodeSegment(parts[0]!)
  const claims = decodeSegment(parts[1]!) as IdTokenClaims
  const algorithm = header['alg']
  if (algorithm !== 'RS256') throw new Error(`不支持的 ID token 签名算法: ${String(algorithm)}`)

  const keys = await jwks()
  const kid = typeof header['kid'] === 'string' ? header['kid'] : undefined
  const jwk = kid === undefined ? keys[0] : keys.find(key => key['kid'] === kid)
  if (jwk === undefined) throw new Error('ID token 对应的签名公钥不存在')

  const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2]!, 'base64url'),
  )
  if (!valid) throw new Error('ID token 签名校验失败')

  const config = await discovery()
  if (claims.iss !== config.issuer) throw new Error('ID token issuer 不匹配')
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(clientId)) throw new Error('ID token audience 不匹配')
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now - 60) throw new Error('ID token 已过期')
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new Error('ID token 尚未生效')
  if (expectedNonce !== undefined && claims.nonce !== expectedNonce) throw new Error('ID token nonce 不匹配')
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('ID token 缺少 sub')
  return claims
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function optionalTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function tokenExpiry(token: Record<string, unknown>, now = Date.now()): number | undefined {
  const explicit = optionalTime(token['expires_at'])
  if (explicit !== undefined) return explicit
  const seconds = token['expires_in']
  return typeof seconds === 'number' && seconds > 0 ? now + seconds * 1000 : undefined
}

function scopeList(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split(/\s+/).filter(item => item !== '')
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item !== '')
      : []
}

function credentialFromToken(options: {
  token: Record<string, unknown>
  clientId: string
  claims: IdTokenClaims
  hostId: string
  previous?: ChatgptCredential
}): ChatgptCredential {
  const accessToken = optionalString(options.token['access_token'])
  if (accessToken === undefined) throw new Error('ChatGPT 未返回 access token')
  const refreshToken = optionalString(options.token['refresh_token']) ?? options.previous?.refreshToken
  const scopes = scopeList(options.token['scope'])
  const now = Date.now()
  const email = optionalString(options.claims.email) ?? options.previous?.email
  const subject = optionalString(options.claims.sub) ?? options.previous?.subject
  return {
    extAgentHostId: options.hostId,
    clientId: options.clientId,
    ...email === undefined ? {} : { email },
    ...subject === undefined ? {} : { subject },
    ...options.token['id_token'] === undefined
      ? options.previous?.idToken === undefined ? {} : { idToken: options.previous.idToken }
      : { idToken: String(options.token['id_token']) },
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...optionalString(options.token['token_type']) === undefined
      ? {}
      : { tokenType: optionalString(options.token['token_type']) },
    ...tokenExpiry(options.token) === undefined ? {} : { expiresAt: tokenExpiry(options.token) },
    ...optionalTime(options.token['earliest_refresh_at']) === undefined
      ? {}
      : { earliestRefreshAt: optionalTime(options.token['earliest_refresh_at']) },
    scopes: scopes.length > 0 ? scopes : options.previous?.scopes ?? [],
    savedAt: now,
    signedOut: false,
  }
}

/**
 * 凭据文件存储。
 *
 * 文件在 Unix 上始终使用 0600，并通过临时文件加 rename 原子替换，
 * 避免进程中断留下半个 JSON。
 */
export class ChatgptCredentialStore {
  private readonly filePath: string
  private readonly logger?: (message: string, detail?: unknown) => void
  private credential: ChatgptCredential | undefined
  private loaded = false
  private refreshing: Promise<ChatgptCredential> | undefined

  constructor(filePath: string, logger?: (message: string, detail?: unknown) => void) {
    this.filePath = filePath
    this.logger = logger
  }

  /** 读取凭据；文件不存在或损坏时返回 undefined。 */
  load(): ChatgptCredential | undefined {
    if (this.loaded) return this.credential
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>
      this.credential = normalizeCredential(parsed)
    } catch {
      this.credential = undefined
    }
    return this.credential
  }

  /** 在首次登录前生成并持久化稳定的 agent host ID。 */
  ensureHostId(): string {
    const existing = this.load()
    if (existing !== undefined) return existing.extAgentHostId
    const hostId = `urn:uuid:${randomUUID()}`
    this.save({ extAgentHostId: hostId })
    return hostId
  }

  /** 原子保存完整凭据。 */
  save(credential: ChatgptCredential): void {
    this.credential = credential
    this.loaded = true
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(credential, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
    } catch (error: unknown) {
      try {
        unlinkSync(temporary)
      } catch {
        // 临时文件未创建时无需清理
      }
      this.logger?.('保存 ChatGPT OAuth 凭据失败', String(error))
      throw error
    }
  }

  /** 清除 token，保留 host、client 与账号映射供下次重新授权。 */
  clear(): void {
    const existing = this.load()
    const hostId = existing?.extAgentHostId ?? this.ensureHostId()
    this.save({
      extAgentHostId: hostId,
      ...existing?.clientId === undefined ? {} : { clientId: existing.clientId },
      ...existing?.email === undefined ? {} : { email: existing.email },
      ...existing?.subject === undefined ? {} : { subject: existing.subject },
      signedOut: true,
    })
  }

  /**
   * 返回未过期的 access token；临近过期时用轮换 refresh token 刷新。
   *
   * 同一凭据的刷新串行化，避免并发请求消费同一个一次性 refresh token。
   */
  async ensure(signal?: AbortSignal): Promise<ChatgptCredential> {
    const credential = this.load()
    if (credential === undefined || credential.signedOut === true || credential.accessToken === undefined) {
      throw new Error('ChatGPT 未登录：请在渠道详情页完成一次“继续使用 ChatGPT”授权')
    }
    const expiresAt = credential.expiresAt
    if (expiresAt === undefined || Date.now() < expiresAt - REFRESH_LEAD_MS) return credential
    return this.refresh(credential, signal)
  }

  /** 在收到 401 时强制刷新一次。 */
  async forceRefresh(credential: ChatgptCredential, signal?: AbortSignal): Promise<ChatgptCredential> {
    if (credential.refreshToken === undefined || credential.refreshToken === '') {
      throw new Error('ChatGPT 登录态已过期，请重新授权')
    }
    return this.refresh(credential, signal)
  }

  private refresh(credential: ChatgptCredential, signal?: AbortSignal): Promise<ChatgptCredential> {
    if (this.refreshing !== undefined) return this.refreshing
    if (credential.clientId === undefined || credential.refreshToken === undefined) {
      return Promise.reject(new Error('ChatGPT 登录态缺少 refresh token，请重新授权'))
    }
    this.refreshing = refreshChatgptCredential(credential, signal)
      .then(next => {
        this.save(next)
        this.logger?.('ChatGPT 订阅登录态已刷新', { accountId: next.email ?? next.subject })
        return next
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token_(expired|invalidated|reused)/i.test(message)) {
          this.clear()
        }
        throw error
      })
      .finally(() => {
        this.refreshing = undefined
      })
    return this.refreshing
  }
}

function normalizeCredential(raw: Record<string, unknown>): ChatgptCredential | undefined {
  const hostId = typeof raw['extAgentHostId'] === 'string' ? raw['extAgentHostId'] : ''
  if (hostId === '') return undefined
  return {
    extAgentHostId: hostId,
    ...optionalString(raw['clientId']) === undefined ? {} : { clientId: optionalString(raw['clientId']) },
    ...optionalString(raw['email']) === undefined ? {} : { email: optionalString(raw['email']) },
    ...optionalString(raw['subject']) === undefined ? {} : { subject: optionalString(raw['subject']) },
    ...optionalString(raw['idToken']) === undefined ? {} : { idToken: optionalString(raw['idToken']) },
    ...optionalString(raw['accessToken']) === undefined ? {} : { accessToken: optionalString(raw['accessToken']) },
    ...optionalString(raw['refreshToken']) === undefined ? {} : { refreshToken: optionalString(raw['refreshToken']) },
    ...optionalString(raw['tokenType']) === undefined ? {} : { tokenType: optionalString(raw['tokenType']) },
    ...optionalTime(raw['expiresAt']) === undefined ? {} : { expiresAt: optionalTime(raw['expiresAt']) },
    ...optionalTime(raw['earliestRefreshAt']) === undefined
      ? {}
      : { earliestRefreshAt: optionalTime(raw['earliestRefreshAt']) },
    scopes: scopeList(raw['scopes']),
    ...optionalTime(raw['savedAt']) === undefined ? {} : { savedAt: optionalTime(raw['savedAt']) },
    ...raw['signedOut'] === true ? { signedOut: true } : {},
  }
}

async function refreshChatgptCredential(
  credential: ChatgptCredential,
  signal?: AbortSignal,
): Promise<ChatgptCredential> {
  if (credential.clientId === undefined || credential.refreshToken === undefined) {
    throw new Error('ChatGPT 登录态缺少必要的 refresh 信息')
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credential.clientId,
    refresh_token: credential.refreshToken,
    resource: RESOURCE,
  })
  const token = await fetchJson(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    ...signal === undefined ? {} : { signal },
  })
  const rawIdToken = optionalString(token['id_token'])
  const claims = rawIdToken === undefined
    ? { sub: credential.subject, email: credential.email }
    : await validateIdToken(rawIdToken, credential.clientId)
  return credentialFromToken({
    token,
    clientId: credential.clientId,
    claims,
    hostId: credential.extAgentHostId,
    previous: credential,
  })
}

function randomVerifier(): string {
  return randomBytes(48).toString('base64url')
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

async function listenLoopback(): Promise<{ server: Server; port: number }> {
  for (const port of CALLBACK_PORTS) {
    const server = createServer()
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE') resolve(false)
        else reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, CALLBACK_HOST)
    })
    if (bound) return { server, port }
  }
  throw new Error(`ChatGPT 登录回调端口 ${CALLBACK_PORTS[0]}–${CALLBACK_PORTS.at(-1)} 均被占用`)
}

function closePending(id: string, pending: PendingLogin, result?: ChatgptLoginPoll): void {
  if (pending.finished) return
  pending.finished = true
  pending.result = result
  clearTimeout(pending.timer)
  pending.server.close()
}

function callbackHtml(ok: boolean, message: string): string {
  const escaped = message.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${ok ? '授权成功' : '授权失败'}</title><body style="font-family:system-ui,sans-serif;padding:40px;max-width:680px;margin:auto"><h1>${ok ? '授权成功' : '授权失败'}</h1><p>${escaped}</p><p>可以关闭此页面并返回 trae-proxy 管理台。</p></body></html>`
}

/**
 * 发起一次 ChatGPT 订阅 OAuth。
 *
 * 管理台负责打开返回的 URL；本机监听器在浏览器回调后完成 code exchange，
 * 校验 ID token，并把凭据写入 0600 文件。
 */
export async function startChatgptLogin(
  id: string,
  credentials: ChatgptCredentialStore,
): Promise<ChatgptLoginStart> {
  const previous = pendingLogins.get(id)
  if (previous !== undefined) closePending(id, previous, { status: 'failed', error: '已重新发起登录' })

  const stored = credentials.load()
  const hostId = credentials.ensureHostId()
  const { server, port } = await listenLoopback()
  const redirectUri = `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomVerifier()
  const requestedClientId = stored?.clientId ?? DYNAMIC_CLIENT_ID
  const pending: PendingLogin = {
    state,
    nonce,
    verifier,
    redirectUri,
    server,
    timer: setTimeout(() => {
      closePending(id, pending, { status: 'failed', error: 'ChatGPT 授权超时，请重新发起登录' })
    }, LOGIN_TIMEOUT_MS),
    finished: false,
  }
  pending.timer.unref?.()
  pendingLogins.set(id, pending)

  server.on('request', (req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', redirectUri)
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
        return
      }
      const fail = (message: string): void => {
        closePending(id, pending, { status: 'failed', error: message })
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackHtml(false, message))
      }
      if (url.searchParams.get('state') !== state) {
        fail('授权回调 state 校验失败')
        return
      }
      const oauthError = url.searchParams.get('error')
      if (oauthError !== null) {
        fail(url.searchParams.get('error_description') ?? oauthError)
        return
      }
      const code = url.searchParams.get('code') ?? ''
      const issuedClientId = url.searchParams.get('client_id')
      if (code === '') {
        fail('授权回调缺少 code')
        return
      }
      if (stored?.clientId !== undefined && issuedClientId !== null && issuedClientId !== stored.clientId) {
        fail('授权回调返回了不同账号的 client ID')
        return
      }
      const clientId = issuedClientId ?? stored?.clientId ?? ''
      if (clientId === '' || clientId === DYNAMIC_CLIENT_ID) {
        fail('新授权未返回有效的 client ID')
        return
      }
      // 官方要求 invalid_grant 后保留本次 issued client ID，再重新发起授权。
      // 在 code exchange 前落盘，避免失败后丢失动态注册结果。
      credentials.save({
        ...(stored ?? { extAgentHostId: hostId }),
        extAgentHostId: hostId,
        clientId,
      })
      try {
        const token = await fetchJson(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            resource: RESOURCE,
          }),
        })
        const idToken = optionalString(token['id_token'])
        if (idToken === undefined) throw new Error('ChatGPT 授权未返回 ID token')
        const claims = await validateIdToken(idToken, clientId, nonce)
        const credential = credentialFromToken({ token, clientId, claims, hostId, previous: stored })
        if (!(credential.scopes ?? []).includes(PLAN_SCOPE)) {
          throw new Error('用户未授权使用 ChatGPT 套餐额度')
        }
        credentials.save(credential)
        const accountId = credential.email ?? credential.subject ?? 'ChatGPT'
        closePending(id, pending, { status: 'done', accountId })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackHtml(true, `已连接账号 ${accountId}`))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        fail(/invalid_grant/i.test(message)
          ? `${message}。本次 client ID 已保留，请返回管理台再次点击“继续使用 ChatGPT”`
          : message)
      }
    })()
  })

  const authorization = new URL(AUTHORIZE_ENDPOINT)
  authorization.searchParams.set('client_id', requestedClientId)
  if (requestedClientId === DYNAMIC_CLIENT_ID) authorization.searchParams.set('agent_name_hint', APP_NAME)
  authorization.searchParams.set('ext_agent_host_id', hostId)
  if (stored?.idToken !== undefined) authorization.searchParams.set('id_token_hint', stored.idToken)
  if (stored?.email !== undefined) authorization.searchParams.set('login_hint', stored.email)
  authorization.searchParams.set('response_type', 'code')
  authorization.searchParams.set('redirect_uri', redirectUri)
  authorization.searchParams.set('scope', SCOPES)
  authorization.searchParams.set('resource', RESOURCE)
  authorization.searchParams.set('state', state)
  authorization.searchParams.set('nonce', nonce)
  authorization.searchParams.set('code_challenge_method', 'S256')
  authorization.searchParams.set('code_challenge', challenge(verifier))
  return { url: authorization.toString() }
}

/** 读取一次当前授权状态。 */
export function pollChatgptLogin(id: string): ChatgptLoginPoll {
  const pending = pendingLogins.get(id)
  if (pending === undefined) return { status: 'failed', error: '登录会话已失效，请重新发起授权' }
  if (pending.result === undefined) return { status: 'pending' }
  pendingLogins.delete(id)
  return pending.result
}

/** 远端撤销 refresh token，并清理本地登录态。 */
export async function signOutChatgpt(
  credentials: ChatgptCredentialStore,
): Promise<{ remoteRevoked: boolean }> {
  const credential = credentials.load()
  let remoteRevoked = false
  if (credential?.refreshToken !== undefined && credential.clientId !== undefined) {
    try {
      const config = await discovery()
      if (config.revocationEndpoint !== undefined) {
        const response = await fetch(config.revocationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: credential.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: credential.clientId,
          }),
          signal: AbortSignal.timeout(15_000),
        })
        remoteRevoked = response.ok
      }
    } catch {
      remoteRevoked = false
    }
  }
  credentials.clear()
  return { remoteRevoked }
}

/** 管理台展示用的登录态摘要。 */
export function describeChatgptCredential(
  credential: ChatgptCredential | undefined,
): ChatgptSessionDescription {
  const signedIn = credential !== undefined
    && credential.signedOut !== true
    && credential.accessToken !== undefined
  const expired = signedIn
    && credential.expiresAt !== undefined
    && Date.now() >= credential.expiresAt
  return {
    signedIn,
    ...credential?.email === undefined ? {} : { email: credential.email },
    ...credential?.email === undefined && credential?.subject === undefined
      ? {}
      : { accountId: credential.email ?? credential.subject },
    ...credential?.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt },
    refreshable: credential?.refreshToken !== undefined && credential.refreshToken !== '',
    expired,
    planUsage: credential?.scopes?.includes(PLAN_SCOPE) === true,
  }
}
