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

export class ProviderRegistry {
  private readonly providers = new Map<string, UpstreamProvider>()
  private readonly modelCache = new Map<string, GatewayModel[]>()
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
  }

  get(id: string): UpstreamProvider | undefined {
    return this.providers.get(id)
  }

  list(): UpstreamProvider[] {
    return [...this.providers.values()]
  }

  async refreshModels(providerId: string): Promise<GatewayModel[]> {
    const provider = this.providers.get(providerId)
    if (provider === undefined) throw new Error(`provider ${providerId} is not registered`)
    const models = await provider.listModels()
    if (models.length === 0) throw new Error(`provider ${providerId} returned no models`)
    this.modelCache.set(providerId, models)
    return models
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
    try {
      return await provider.chat(bodyJson, signal, context)
    } catch (error: unknown) {
      this.logger?.('provider chat failed', { providerId, error: String(error) })
      return {
        ok: false,
        status: 502,
        kind: 'server',
        message: `provider ${providerId} chat failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
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
