/**
 * Provider 注册表与统一上游接口。
 *
 * 网关把 model id 解析为 `<providerId>/<upstreamModelId>`，再由注册表
 * 找到对应 provider 实例执行对话/模型目录。Trae provider 走本地适配器，
 * 其余走各自协议的客户端。
 */

import type { ProviderRecord } from './store.ts'

export interface GatewayModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: string[]
}

export interface ChatRequestMeta {
  apiKeyId: string
  model: string
  providerId: string
}

/**
 * 单次上游对话的附加上下文。
 *
 * `sessionId` 用于需要会话粘性的上游（例如 opencode.ai 的
 * `x-opencode-session`），网关从入站请求推导后透传，保证同一会话
 * 的请求落在同一条路由上并命中 prompt 缓存。
 */
export interface ChatRequestContext {
  sessionId?: string
}

export interface GatewayChatResult {
  ok: true
  response: Response
  /** 可选：记录用量事件。 */
  usage?: { requestTokens?: number; responseTokens?: number; totalTokens?: number }
}

export type GatewayChatFailure = {
  ok: false
  status: number
  kind: 'authentication' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client' | 'unconfigured'
  message: string
}

export interface UpstreamProvider {
  readonly id: string
  listModels(): Promise<GatewayModel[]>
  chat(
    bodyJson: string,
    signal?: AbortSignal,
    context?: ChatRequestContext,
  ): Promise<GatewayChatResult | GatewayChatFailure>
  /** 可选：返回面向管理台的运行状态（Trae 登录态等）。 */
  status?(): Promise<unknown>
}

export interface ProviderRegistryOptions {
  logger?: (message: string, detail?: unknown) => void
}

const UPSTREAM_ERROR_MAX = 300
const UPSTREAM_RETRY_MAX = 1
const UPSTREAM_RETRY_DELAY_MS = 400

/**
 * 从上游错误正文中提取人类可读信息，避免把 HTML / 超长响应直接透传给客户端。
 * 优先解析 JSON 错误结构，再退回清洗后的纯文本，并统一截断。
 */
export function readableUpstreamError(text: string, fallback: string): string {
  const raw = String(text ?? '').trim().slice(0, 4096)
  if (raw === '') return fallback
  let extracted: string | undefined
  try {
    extracted = pickErrorMessage(JSON.parse(raw) as unknown)
  } catch {
    extracted = undefined
  }
  const source = extracted ?? raw
  const singleLine = source.replace(/\s+/g, ' ').trim()
  if (singleLine === '') return fallback
  if (singleLine.length <= UPSTREAM_ERROR_MAX) return singleLine
  return `${singleLine.slice(0, UPSTREAM_ERROR_MAX)}…`
}

/** 递归寻找 OpenAI / Anthropic / Gemini 常见的错误 message 字段。 */
function pickErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickErrorMessage(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['message'] === 'string' && record['message'].trim() !== '') return record['message'].trim()
  for (const key of ['error', 'err']) {
    if (key in record) {
      const found = pickErrorMessage(record[key])
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** 判断 fetch 异常是否为连接/超时类错误（可用于重试）。 */
export function isTransportError(error: unknown): boolean {
  let current: unknown = error
  let depth = 0
  while (current !== undefined && current !== null && depth < 8) {
    if (current instanceof Error) {
      const name = current.name
      if (name === 'AbortError' || name === 'TimeoutError' || name === 'FetchError') return true
      const message = current.message
      if (/fetch failed|network|socket|timeout|timed out|aborted/i.test(message)) return true
    }
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code
      if (typeof code === 'string' && /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/.test(code)) {
        return true
      }
    }
    current = (current as { cause?: unknown } | undefined)?.cause
    depth += 1
  }
  return false
}

export class ProviderRegistry {
  private readonly providers = new Map<string, UpstreamProvider>()
  private readonly modelCache = new Map<string, GatewayModel[]>()
  private readonly refreshInflight = new Map<string, Promise<GatewayModel[]>>()
  private readonly logger?: (message: string, detail?: unknown) => void

  constructor(options: ProviderRegistryOptions = {}) {
    this.logger = options.logger
  }

  register(provider: UpstreamProvider): void {
    this.providers.set(provider.id, provider)
  }

  unregister(id: string): void {
    this.providers.delete(id)
    this.modelCache.delete(id)
    this.refreshInflight.delete(id)
  }

  get(id: string): UpstreamProvider | undefined {
    return this.providers.get(id)
  }

  list(): UpstreamProvider[] {
    return [...this.providers.values()]
  }

  async refreshModels(providerId: string): Promise<GatewayModel[]> {
    const inflight = this.refreshInflight.get(providerId)
    if (inflight !== undefined) return inflight
    const provider = this.providers.get(providerId)
    if (provider === undefined) return Promise.reject(new Error(`provider ${providerId} is not registered`))
    const job = provider.listModels()
      .then(models => {
        if (models.length === 0) throw new Error(`provider ${providerId} returned no models`)
        this.modelCache.set(providerId, models)
        return models
      })
      .finally(() => {
        this.refreshInflight.delete(providerId)
      })
    this.refreshInflight.set(providerId, job)
    return job
  }

  /** 返回缓存目录；没有缓存时即时拉取一次。 */
  async ensureModels(providerId: string): Promise<GatewayModel[]> {
    const cached = this.modelCache.get(providerId)
    if (cached !== undefined && cached.length > 0) return cached
    return this.refreshModels(providerId)
  }

  cachedModels(providerId: string): GatewayModel[] {
    return this.modelCache.get(providerId) ?? []
  }

  /** 所有已注册 provider 的缓存模型（调用方负责在必要时先 ensure）。 */
  allCachedModels(): GatewayModel[] {
    const result: GatewayModel[] = []
    for (const [providerId, models] of this.modelCache) {
      if (!this.providers.has(providerId)) continue
      for (const model of models) result.push(model)
    }
    return result
  }

  async chat(
    providerId: string,
    bodyJson: string,
    signal?: AbortSignal,
    context?: ChatRequestContext,
  ): Promise<GatewayChatResult | GatewayChatFailure> {
    const provider = this.providers.get(providerId)
    if (provider === undefined) {
      return { ok: false, status: 404, kind: 'not_found', message: `unknown provider: ${providerId}` }
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await provider.chat(bodyJson, signal, context)
        if (result.ok || !this.shouldRetry(result, signal)) return result
        if (attempt >= UPSTREAM_RETRY_MAX || signal?.aborted === true) return result
        this.logger?.('retrying provider chat', { providerId, attempt: attempt + 1, status: result.status, kind: result.kind })
        await new Promise(resolve => setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS * (attempt + 1)))
      } catch (error: unknown) {
        this.logger?.('provider chat failed', { providerId, error: String(error) })
        if (attempt >= UPSTREAM_RETRY_MAX || signal?.aborted === true) {
          const transport = isTransportError(error)
          return {
            ok: false,
            status: transport ? 0 : 502,
            kind: 'server',
            message: readableUpstreamError(
              error instanceof Error ? error.message : String(error),
              `provider ${providerId} chat failed`,
            ),
          }
        }
        this.logger?.('retrying provider chat after throw', { providerId, attempt: attempt + 1 })
        await new Promise(resolve => setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS * (attempt + 1)))
      }
    }
  }

  /** 429 / 5xx / 连接失败值得重试；鉴权与业务 4xx 直接返回。 */
  private shouldRetry(failure: GatewayChatFailure, signal?: AbortSignal): boolean {
    if (signal?.aborted === true) return false
    if (failure.status === 0) return true
    return failure.status === 429 || failure.status >= 500
  }

  async close(): Promise<void> {
    // 预留：将来 provider 可持有连接/定时器。
  }
}

/** 把 OpenAI 兼容 provider 的模型响应标准化成 GatewayModel。 */
export function modelFromOpenAI(raw: unknown): GatewayModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return undefined
  return {
    id,
    name: typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : id,
    ...typeof record['contextWindow'] === 'number' ? { contextWindow: record['contextWindow'] } : {},
    ...typeof record['maxTokens'] === 'number' ? { maxTokens: record['maxTokens'] } : {},
  }
}
