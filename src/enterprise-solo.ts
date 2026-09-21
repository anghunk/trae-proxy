/**
 * 企业版优先的上游客户端。
 *
 * 企业版账号的对话与目录都在企业网关上：公开 SOLO 通道会以 HTTP 200 + error 事件拒绝
 * （公开网关 4011 / 企业网关 4001），因此探测到企业网关后，两者都改走企业网关。
 *
 * @module trae-proxy/enterprise-solo
 */

import type { TraeCredential } from './auth.ts'
import type { TraeIdentity } from './identity.ts'
import { buildTraeCnHeaders, traeEndpoint } from './protocol.ts'
import { REGION_GATEWAYS, regionOfCredential, type TraeRegion } from './region.ts'
import { fetchEnterpriseModels, type EnterpriseGatewayConfig } from './enterprise-gateway.ts'

export interface EnterpriseAwareSoloOptions {
  credential(): Promise<TraeCredential>
  identity(): Promise<TraeIdentity>
  storageText(): Promise<string>
  baseUrl?: string
  fetchImpl?: typeof fetch
  log?: (message: string, detail?: unknown) => void
}

export interface EnterpriseDiscovery {
  readonly enterprise: {
    readonly detected: boolean
    readonly gateway: EnterpriseGatewayConfig
    readonly models: readonly string[]
  }
  readonly upstreamBase: string
  readonly upstreamLabel: string
}

export class EnterpriseAwareSoloClient {
  private readonly fetchImpl: typeof fetch
  private readonly options: EnterpriseAwareSoloOptions
  private cachedDiscovery: Promise<EnterpriseDiscovery> | undefined

  constructor(options: EnterpriseAwareSoloOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async discover(): Promise<EnterpriseDiscovery> {
    this.cachedDiscovery ??= this.computeDiscovery()
    return this.cachedDiscovery
  }

  private async computeDiscovery(): Promise<EnterpriseDiscovery> {
    const [credential] = await Promise.all([this.options.credential()])
    const region = regionOfCredential(credential)
    const publicBase = this.options.baseUrl ?? REGION_GATEWAYS[region].chat
    const enterprise = await fetchEnterpriseModels({
      credential: this.options.credential,
      identity: this.options.identity,
      storageText: this.options.storageText,
      fetchImpl: this.fetchImpl,
      log: this.options.log,
    })
    if (enterprise.ok && enterprise.models.length > 0) {
      return {
        enterprise: { detected: true, gateway: enterprise.gateway, models: enterprise.models },
        upstreamBase: enterprise.gateway.chat,
        upstreamLabel: `enterprise(${enterprise.gateway.chat})`,
      }
    }
    return {
      enterprise: { detected: false, gateway: enterprise.gateway, models: enterprise.models },
      upstreamBase: publicBase,
      upstreamLabel: `public(${publicBase})`,
    }
  }

  async chatStream(bodyJson: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; message: string; response?: Response }> {
    const discovery = await this.discover()
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()])
    const headers = buildTraeCnHeaders(credential, identity)
    try {
      const response = await this.fetchImpl(traeEndpoint(discovery.upstreamBase, '/api/agent/v3/llm_utils_chat'), {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: signal ?? AbortSignal.timeout(120_000),
      })
      const text = await response.text()
      if (!response.ok) {
        this.options.log?.('enterprise-aware upstream chat failed', { status: response.status, upstream: discovery.upstreamLabel, body: text.slice(0, 200) })
        return { ok: false, status: response.status, message: text || `Trae upstream returned HTTP ${response.status}` }
      }
      return { ok: true, status: 200, message: '', response: new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) }
    } catch (error: unknown) {
      this.options.log?.('enterprise-aware upstream chat transport error', { upstream: discovery.upstreamLabel, error: String(error) })
      return { ok: false, status: 0, message: `transport error: ${String(error)}` }
    }
  }
}
