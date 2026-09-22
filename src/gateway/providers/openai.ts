/**
 * OpenAI 兼容上游：直转 /v1/chat/completions 与 /v1/models。
 * 支持流式 SSE 透传，不解析内容，只记录可选 usage。
 */

import type {
  ChatRequestContext,
  GatewayChatFailure,
  GatewayChatResult,
  GatewayModel,
  UpstreamProvider,
} from '../providers.ts'
import type { ProviderRecord } from '../store.ts'
import { modelFromOpenAI } from '../providers.ts'

export interface OpenAiProviderOptions {
  record: ProviderRecord
  logger?: (message: string, detail?: unknown) => void
}

function mergeHeaders(record: ProviderRecord): Record<string, string> {
  const extra: Record<string, string> = {}
  try {
    const parsed = JSON.parse(record.extraHeaders) as Record<string, unknown>
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value !== '') extra[key] = value
    }
  } catch {
    // 忽略非法 extraHeaders
  }
  if (record.apiKey !== undefined && record.apiKey !== '') {
    extra['Authorization'] = `Bearer ${record.apiKey}`
  }
  return extra
}

function baseUrl(record: ProviderRecord): string {
  return (record.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
}

/**
 * 上游要求“稳定会话头”时返回对应请求头名。
 *
 * opencode.ai 用 `x-opencode-session` 做请求路由与 prompt 缓存，
 * 缺失会直接返回 400 MissingSessionID，因此对它的主机自动带上。
 */
function sessionHeaderName(record: ProviderRecord): string | undefined {
  try {
    const host = new URL(baseUrl(record)).hostname.toLowerCase()
    if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) return 'x-opencode-session'
  } catch {
    // base_url 非法时交给 fetch 报错，这里不额外处理
  }
  return undefined
}

export class OpenAiCompatibleProvider implements UpstreamProvider {
  readonly id: string
  private readonly record: ProviderRecord
  private readonly logger?: (message: string, detail?: unknown) => void

  constructor(options: OpenAiProviderOptions) {
    this.id = options.record.id
    this.record = options.record
    this.logger = options.logger
  }

  async listModels(): Promise<GatewayModel[]> {
    const headers = mergeHeaders(this.record)
    headers['Accept'] = 'application/json'
    const response = await fetch(`${baseUrl(this.record)}/models`, { headers, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`models HTTP ${response.status}`)
    const document = (await response.json()) as { data?: unknown }
    const data = Array.isArray(document.data) ? document.data : []
    const models = data
      .map(modelFromOpenAI)
      .filter((model): model is GatewayModel => model !== undefined)
    if (models.length === 0) throw new Error('openai-compatible models response contained no models')
    return models
  }

  async chat(
    bodyJson: string,
    signal?: AbortSignal,
    context?: ChatRequestContext,
  ): Promise<GatewayChatResult | GatewayChatFailure> {
    const headers = mergeHeaders(this.record)
    headers['Content-Type'] = 'application/json'
    const sessionHeader = sessionHeaderName(this.record)
    if (sessionHeader !== undefined && context?.sessionId !== undefined && context.sessionId !== '') {
      headers[sessionHeader] = context.sessionId
    }
    let response: Response
    try {
      response = await fetch(`${baseUrl(this.record)}/chat/completions`, {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: signal ?? AbortSignal.timeout(this.record.timeoutMs ?? 120_000),
      })
    } catch (error: unknown) {
      return {
        ok: false,
        status: 0,
        kind: 'server',
        message: `openai-compatible transport error: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 1024)
      this.logger?.('openai-compatible chat rejected', { providerId: this.id, status: response.status, body: text })
      return {
        ok: false,
        status: response.status,
        kind: classifyStatus(response.status),
        message: text || `openai-compatible upstream returned HTTP ${response.status}`,
      }
    }
    return { ok: true, response }
  }
}

function classifyStatus(status: number): GatewayChatFailure['kind'] {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}
