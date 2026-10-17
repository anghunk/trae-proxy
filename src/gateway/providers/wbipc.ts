/**
 * WorkBuddy IPC（wbipc）客户端。
 *
 * 桌面端 daemon 在 `~/.workbuddy/wbipc/endpoint.json` 暴露一个 Unix socket，
 * 用自己的登录态对外提供受限能力。其中 `wb.request` pipe 的 `http.fetch`
 * 方法会在转发时**自动注入 Authorization / X-User-Id 等凭据**，因此这是唯一
 * 能在不接触 at-rest 密钥的前提下复用桌面端登录态的入口。
 *
 * 握手为 HMAC 挑战应答：
 *   session_hello    → 带 client_nonce 与 ticket_id
 *   session_challenge← 返回 server_nonce 与 server_proof
 *   session_prove    → 回 client_proof
 *   session_hello_ack← 返回可见 pipes
 * 帧格式为 NDJSON（每行一个 JSON 对象）。
 *
 * @module trae-proxy/gateway/providers/wbipc
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'

/** 握手与请求的超时。 */
const HANDSHAKE_TIMEOUT_MS = 10_000
const RPC_TIMEOUT_MS = 600_000
/** wbipc 单帧上限，与 daemon 侧的读缓冲一致。 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024
/** 提供带凭据 HTTP 转发的 pipe 名与方法名。 */
const REQUEST_PIPE = 'wb.request'
const REQUEST_METHOD = 'http.fetch'

/** endpoint.json 的内容。 */
export interface WbipcEndpoint {
  endpoint: string
  ticket: string
}

/** `http.fetch` 的返回结构。 */
export interface WbipcFetchResult {
  status: number
  headers: Record<string, string>
  /** 响应体（原始字节）。 */
  body: Buffer
}

export interface WbipcFetchOptions {
  method: string
  /** 相对路径，必须以 `/` 开头；查询参数放在 `query`。 */
  path: string
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: string | Buffer
  signal?: AbortSignal
}

/** 解析 endpoint.json；文件不存在或损坏时返回 undefined。 */
export function readWbipcEndpoint(configDir: string): WbipcEndpoint | undefined {
  const path = join(configDir, 'wbipc', 'endpoint.json')
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const endpoint = parsed['endpoint']
    const ticket = parsed['ticket']
    if (typeof endpoint !== 'string' || endpoint === '') return undefined
    if (typeof ticket !== 'string' || ticket === '') return undefined
    return { endpoint, ticket }
  } catch {
    return undefined
  }
}

/** 默认的 WorkBuddy 配置目录。 */
export function defaultWorkbuddyConfigDir(): string {
  return join(homedir(), '.workbuddy')
}

/**
 * 一条已完成握手的 wbipc 连接。
 *
 * 连接建立后先取一次 `wb.request` 的 channel 名，之后所有 http.fetch 都通过它转发。
 * 桌面端重启会换掉 socket 与 ticket，因此调用方应在失败时重建实例。
 */
export class WbipcConnection {
  private readonly socket: Socket
  private buffer = ''
  private readonly waiters: Array<{
    match: (message: Record<string, unknown>) => boolean
    resolve: (message: Record<string, unknown>) => void
  }> = []
  private readonly closed: Promise<void>
  private requestId = 0
  private requestChannel: string | undefined
  private failure: Error | undefined

  private constructor(socket: Socket) {
    this.socket = socket
    this.closed = new Promise(resolve => {
      socket.once('close', () => resolve())
      socket.once('error', error => {
        this.failure = error instanceof Error ? error : new Error(String(error))
        resolve()
      })
    })
    socket.setNoDelay(true)
    socket.on('data', chunk => this.onData(chunk))
  }

  /** 建立连接并完成握手。 */
  static async open(endpoint: WbipcEndpoint, signal?: AbortSignal): Promise<WbipcConnection> {
    const socket = connect(endpoint.endpoint)
    const connection = new WbipcConnection(socket)
    try {
      await connection.handshake(endpoint, signal)
      return connection
    } catch (error) {
      connection.destroy()
      throw error
    }
  }

  /**
   * 通过 daemon 转发一次 HTTP 请求（自动附带登录态）。
   *
   * @param options 请求方法、路径与可选请求体。
   * @returns 上游状态码、响应头与响应体。
   */
  async fetch(options: WbipcFetchOptions): Promise<WbipcFetchResult> {
    const channel = this.requestChannel ?? await this.resolveRequestChannel(options.signal)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      // daemon 只允许这两个头；其余会在转发前被拒绝。
      const lower = key.toLowerCase()
      if ((lower === 'content-type' || lower === 'accept') && value !== '') headers[lower] = value
    }
    const params: Record<string, unknown> = { method: options.method.toUpperCase(), path: options.path }
    if (options.query !== undefined) params['query'] = options.query
    if (Object.keys(headers).length > 0) params['headers'] = headers
    if (options.body !== undefined) {
      params['body_b64'] = Buffer.isBuffer(options.body)
        ? options.body.toString('base64')
        : Buffer.from(options.body, 'utf8').toString('base64')
    }
    const result = await this.call(`${channel}/${REQUEST_METHOD}`, params, options.signal)
    const status = typeof result['status'] === 'number' ? result['status'] : 0
    const rawHeaders = typeof result['headers'] === 'object' && result['headers'] !== null
      ? result['headers'] as Record<string, unknown>
      : {}
    const outHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === 'string') outHeaders[key.toLowerCase()] = value
    }
    const bodyB64 = typeof result['body_b64'] === 'string' ? result['body_b64'] : ''
    return { status, headers: outHeaders, body: Buffer.from(bodyB64, 'base64') }
  }

  /** 关闭连接。 */
  destroy(): void {
    this.socket.destroy()
  }

  /** 握手：hello → challenge → prove → ack。 */
  private async handshake(endpoint: WbipcEndpoint, signal?: AbortSignal): Promise<void> {
    const ticketId = createHash('sha256').update(endpoint.ticket, 'utf8').digest('hex').slice(0, 16)
    const clientNonce = randomBytes(16).toString('base64url')
    this.write({
      type: 'session_hello',
      protocol_min: 1,
      protocol_max: 1,
      client_nonce: clientNonce,
      ticket_id: ticketId,
      client: { kind: 'trae-proxy', id: 'trae-proxy', version: '1.0' },
    })
    const challenge = await this.next(message => !('id' in message), HANDSHAKE_TIMEOUT_MS, signal)
    if (challenge['type'] === 'session_hello_error') {
      throw new Error(`wbipc 握手被拒绝: ${String(challenge['code'] ?? 'unknown')}`)
    }
    if (challenge['type'] !== 'session_challenge') {
      throw new Error(`wbipc 握手响应异常: ${JSON.stringify(challenge).slice(0, 200)}`)
    }
    const serverNonce = typeof challenge['server_nonce'] === 'string' ? challenge['server_nonce'] : ''
    if (serverNonce === '') throw new Error('wbipc 握手缺少 server_nonce')
    const transcript = { protocol: 1, endpoint: endpoint.endpoint, clientNonce, serverNonce }
    const expected = proof(endpoint.ticket, 'server', transcript)
    if (expected !== challenge['server_proof']) throw new Error('wbipc 服务端证明校验失败')
    this.write({ type: 'session_prove', client_proof: proof(endpoint.ticket, 'client', transcript) })
    const ack = await this.next(message => !('id' in message), HANDSHAKE_TIMEOUT_MS, signal)
    if (ack['type'] === 'session_hello_error') {
      throw new Error(`wbipc 身份校验失败: ${String(ack['code'] ?? 'unknown')}`)
    }
    if (ack['type'] !== 'session_hello_ack') {
      throw new Error(`wbipc 握手未完成: ${JSON.stringify(ack).slice(0, 200)}`)
    }
    const pipes = Array.isArray(ack['pipes']) ? ack['pipes'] : []
    if (!pipes.includes(REQUEST_PIPE)) {
      throw new Error(`WorkBuddy 未登录或未开放转发通道（可见通道: ${pipes.join(', ') || '无'}）`)
    }
  }

  /** 取 `wb.request` 的 channel 名。 */
  private async resolveRequestChannel(signal?: AbortSignal): Promise<string> {
    const result = await this.call('broker/GetPipe', { pipe: REQUEST_PIPE }, signal)
    const channel = typeof result['channel'] === 'string' ? result['channel'] : ''
    if (channel === '') throw new Error('wbipc 未返回 wb.request 的 channel')
    this.requestChannel = channel
    return channel
  }

  /** 发一条 JSON-RPC 请求并等待同 id 的结果。 */
  private async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.requestId += 1
    const id = this.requestId
    this.write({ jsonrpc: '2.0', id, method, params, mode: 'call' })
    const message = await this.next(candidate => candidate['id'] === id, RPC_TIMEOUT_MS, signal, id)
    const error = message['error']
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>
      throw new Error(`wbipc 调用 ${method} 失败: ${String(record['message'] ?? 'unknown')}`)
    }
    const result = message['result']
    return typeof result === 'object' && result !== null ? result as Record<string, unknown> : {}
  }

  /**
   * 取下一帧满足条件的消息。
   *
   * JSON-RPC 响应按 id 匹配，不能按到达顺序消费；否则前一个超时/取消的
   * waiter 会在队列里吃掉后续响应，让整条连接永久挂起。
   */
  private next(
    match: (message: Record<string, unknown>) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
    cancelId?: number,
  ): Promise<Record<string, unknown>> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false
      const waiter = {
        match,
        resolve: (message: Record<string, unknown>): void => finish(() => resolve(message)),
      }
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        fn()
      }
      const onAbort = (): void => {
        this.cancelActiveRequest(cancelId)
        finish(() => reject(new Error('wbipc 请求已取消')))
      }
      const timer = setTimeout(() => {
        this.cancelActiveRequest(cancelId)
        finish(() => reject(new Error('wbipc 请求超时')))
      }, timeoutMs)
      if (signal?.aborted === true) {
        finish(() => reject(new Error('wbipc 请求已取消')))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
      void this.closed.then(() => {
        finish(() => reject(this.failure ?? new Error('wbipc 连接已关闭')))
      })
    })
  }

  /** 尽力通知 daemon 取消当前 in-flight 调用，避免占住它的并发槽。 */
  private cancelActiveRequest(id?: number): void {
    try {
      const params = id === undefined ? {} : { id }
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: '$/cancel', params })}\n`)
    } catch {
      // 取消失败不覆盖原始错误
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > MAX_FRAME_BYTES) {
        this.failure = new Error('wbipc 帧超出上限')
        this.destroy()
        return
      }
      if (line.trim() === '') continue
      let message: Record<string, unknown>
      try {
        const parsed = JSON.parse(line) as unknown
        if (typeof parsed !== 'object' || parsed === null) continue
        message = parsed as Record<string, unknown>
      } catch {
        continue
      }
      const waiter = this.waiters.find(item => item.match(message))
      if (waiter !== undefined) waiter.resolve(message)
    }
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.failure = new Error('wbipc 帧超出上限')
      this.destroy()
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.failure !== undefined) throw this.failure
    this.socket.write(`${JSON.stringify(message)}\n`)
  }
}

/** 拼接 HMAC 挑战应答的待签名内容（各字段带 4 字节大端长度前缀）。 */
function transcriptBytes(role: 'client' | 'server', t: {
  protocol: number
  endpoint: string
  clientNonce: string
  serverNonce: string
}): Buffer {
  const parts = [
    role === 'server' ? 'wbipc-s' : 'wbipc-c',
    String(t.protocol),
    t.endpoint,
    t.clientNonce,
    t.serverNonce,
  ]
  const buffers: Buffer[] = []
  for (const part of parts) {
    const value = Buffer.from(part, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(value.length, 0)
    buffers.push(length, value)
  }
  return Buffer.concat(buffers)
}

function proof(ticket: string, role: 'client' | 'server', t: {
  protocol: number
  endpoint: string
  clientNonce: string
  serverNonce: string
}): string {
  return createHmac('sha256', Buffer.from(ticket, 'utf8')).update(transcriptBytes(role, t)).digest('base64url')
}
