/**
 * 回环 OpenAI 兼容端点（Trae 版）。
 *
 * 改自 dingminhua/dsh-connect-trae/src/shim.ts（MIT，Copyright (c) 2026 LaoDing）。
 * 四重回环安全校验（Host/Origin/JSON/bearer）、常量时间比对、body 上限、
 * 上游错误到 HTTP 状态码映射原样保留。
 *
 * 相对原版的改动：支持固定端口与持久 bearer；新增只读 GET /status。
 *
 * @module trae-proxy/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import type { LiveTraeStore } from './auth.ts'
import type { TraeCatalog } from './catalog.ts'
import { resolveTraeIdentity } from './identity.ts'
import { traeStorageCandidates } from './paths.ts'
import { regionOfEdition, type TraeRegion } from './region.ts'
import type { TraeUpstreamClient, TraeUpstreamErrorKind } from './upstream.ts'

export interface ShimLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface TraeShim {
  ready: Promise<void>
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

export interface TraeShimOptions {
  region: TraeRegion
  port: number
  host?: string
  token?: string
  store: LiveTraeStore
  client: TraeUpstreamClient
  catalog: TraeCatalog
  logger?: ShimLogger
  /** 只读签到状态；不提供则 /signin/* 返回 404 */
  signinStatus?: () => Promise<unknown>
  /** 立即检查/领取今日签到（幂等） */
  signinClaim?: () => Promise<unknown>
}

const BODY_LIMIT = 64 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const STATUS_BY_KIND: Readonly<Record<TraeUpstreamErrorKind, number>> = {
  authentication: 401,
  hard_credit: 402,
  soft_rate: 429,
  not_found: 502,
  server: 502,
  client: 400,
  unconfigured: 503,
}

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

function hostIsLoopback(host: string | undefined): boolean {
  return host !== undefined && host.trim() !== '' && LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const hostname = new URL(origin).hostname
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
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

export function createTraeShim(options: TraeShimOptions): TraeShim {
  const secret = options.token ?? randomBytes(32).toString('base64url')
  const region = options.region
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => { void handle(req, res) })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const host = options.host ?? '127.0.0.1'
  server.listen(options.port, host)

  function bearerOk(req: IncomingMessage): boolean {
    const match = typeof req.headers.authorization === 'string'
      ? /^Bearer\s+(.+)$/i.exec(req.headers.authorization.trim())
      : null
    if (match === null) return false
    const actual = Buffer.from(match[1] ?? '')
    const expected = Buffer.from(secret)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async function status(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await options.store.status()
    let identity: unknown
    try {
      const credential = await options.store.resolve()
      const candidates = traeStorageCandidates().filter(item =>
        item.source === 'desktop' && regionOfEdition(item.edition) === region
        && item.edition === credential.edition)
      const id = await resolveTraeIdentity(candidates.length > 0 ? candidates : traeStorageCandidates(), credential.edition)
      identity = { machineId: id.machineId.slice(0, 8) + '…', deviceId: id.deviceId, appVersion: id.appVersion, buildVersion: id.buildVersion }
    } catch (error: unknown) {
      identity = { error: String(error instanceof Error ? error.message : error) }
    }
    writeJson(res, 200, { region, auth, models: options.catalog.current().length, identity })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) return writeError(res, 403, 'host_not_allowed', 'Host must be loopback')
      if (!originIsLoopback(req.headers.origin)) return writeError(res, 403, 'origin_not_allowed', 'Origin must be loopback')
      if (!bearerOk(req)) return writeError(res, 401, 'unauthorized', 'Missing or invalid bearer')
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        return writeJson(res, 200, { ok: true, region })
      }
      if (req.method === 'GET' && (url === '/status' || url === '/status/')) {
        return await status(req, res)
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        return writeJson(res, 200, {
          object: 'list',
          data: options.catalog.current().map(model => ({ id: model.id, object: 'model', created: 0, owned_by: `trae-${region}` })),
        })
      }
      if (url.split('?')[0] === '/signin/status' && req.method === 'GET') {
        if (!options.signinStatus) return writeError(res, 404, 'not_found', 'sign-in not available')
        try { return writeJson(res, 200, await options.signinStatus()) }
        catch (error) { return writeError(res, 502, 'signin_error', error instanceof Error ? error.message : String(error)) }
      }
      if (url.split('?')[0] === '/signin/claim' && req.method === 'POST') {
        if (!options.signinClaim) return writeError(res, 404, 'not_found', 'sign-in not available')
        try { return writeJson(res, 200, await options.signinClaim()) }
        catch (error) { return writeError(res, 502, 'signin_error', error instanceof Error ? error.message : String(error)) }
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        if (typeof req.headers['content-type'] !== 'string'
          || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
          return writeError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
        }
        const raw = (await readBody(req)).toString('utf8')
        try { JSON.parse(raw) } catch { return writeError(res, 400, 'invalid_json', 'Request body must be valid JSON') }
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        req.once('aborted', abort)
        req.socket.once('close', abort)
        const result = await options.client.chatStream(raw, controller.signal)
        if (!result.ok) return writeError(res, STATUS_BY_KIND[result.kind], result.kind, result.message)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
        body.on('error', (error: unknown) => {
          options.logger?.warn(`trae(${region}): upstream stream failed`, error)
          if (!res.writableEnded) res.end()
        })
        body.pipe(res)
        return
      }
      writeError(res, 404, 'not_found', `No such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      options.logger?.error(`trae(${region}): shim request failed`, error)
      if (!res.headersSent) writeError(res, 500, 'internal', 'Internal shim error')
      else if (!res.writableEnded) res.end()
    }
  }

  return {
    ready,
    baseUrl: () => `http://${host}:${options.port}`,
    token: () => secret,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      server.close(error => error === undefined ? resolve() : reject(error))
    }),
  }
}
