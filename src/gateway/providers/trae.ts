/**
 * Trae 适配器：把现有 Trae 内核（auth/decrypt/solo/bridge）包装成
 * 统一 UpstreamProvider。模型目录来自 TraeCatalog，对话走 TraeSoloBridge。
 * 企业版账号通过 storage.json 的 iCubeHostInfo 实时选路。
 */

import { readFile } from 'node:fs/promises'
import type { TraeCredential } from '../../auth.ts'
import type { TraeIdentity } from '../../identity.ts'
import { traeStorageCandidates } from '../../paths.ts'
import { refreshTraeCredential } from '../../refresh.ts'
import { REGION_GATEWAYS, regionOfCredential, regionOfEdition, type TraeRegion } from '../../region.ts'
import { LiveTraeStore } from '../../auth.ts'
import { resolveTraeIdentity } from '../../identity.ts'
import { TraeSoloUpstreamClient } from '../../solo.ts'
import { TraeSoloBridge } from '../../solo-bridge.ts'
import { TraeCatalog, fromSoloModels } from '../../catalog.ts'
import { resolveEnterpriseGatewayFromStorage } from '../../enterprise-gateway.ts'
import type { GatewayChatFailure, GatewayChatResult, GatewayModel, UpstreamProvider } from '../providers.ts'
import type { ProviderRecord } from '../store.ts'

export interface TraeProviderOptions {
  record: ProviderRecord
  logger?: (message: string, detail?: unknown) => void
}

export class TraeGatewayProvider implements UpstreamProvider {
  readonly id: string
  readonly region: TraeRegion
  private readonly record: ProviderRecord
  private readonly logger?: (message: string, detail?: unknown) => void
  private readonly store: LiveTraeStore
  private readonly catalog: TraeCatalog
  private readonly bridge: TraeSoloBridge
  private readonly solo: TraeSoloUpstreamClient

  constructor(options: TraeProviderOptions) {
    this.id = options.record.id
    this.region = this.id === 'trae-ai' ? 'ai' : 'cn'
    this.record = options.record
    this.logger = options.logger
    this.catalog = new TraeCatalog(this.region)
    this.store = new LiveTraeStore({
      region: this.region,
      refresh: async credential => {
        const candidates = traeStorageCandidates().filter(item =>
          item.source === 'desktop' && regionOfEdition(item.edition) === this.region
          && item.edition === credential.edition)
        let device: { deviceId: string; machineId: string } | undefined
        try {
          const id = await resolveTraeIdentity(
            candidates.length > 0 ? candidates : traeStorageCandidates(),
            credential.edition,
          )
          device = { deviceId: id.deviceId, machineId: id.machineId }
        } catch {
          device = undefined
        }
        return refreshTraeCredential(credential, undefined, device)
      },
    })
    const identity = async (): Promise<TraeIdentity> => {
      const credential = await this.store.resolve()
      const candidates = traeStorageCandidates().filter(item =>
        item.source === 'desktop' && regionOfCredential(credential) === regionOfEdition(item.edition)
        && item.edition === credential.edition)
      return resolveTraeIdentity(
        candidates.length > 0 ? candidates : traeStorageCandidates(),
        credential.edition,
      )
    }
    this.solo = new TraeSoloUpstreamClient({
      credential: () => this.store.resolve(),
      identity,
      baseUrl: () => this.resolveUpstreamBase(),
      log: (message, detail) => this.logger?.(`trae(${this.region}) ${message}`, detail),
    })
    this.bridge = new TraeSoloBridge(this.solo, this.catalog)
  }

  private async resolveUpstreamBase(): Promise<string | undefined> {
    try {
      const credential = await this.store.resolve()
      const candidate = traeStorageCandidates().find(item =>
        item.source === 'desktop' && item.edition === credential.edition)
      if (candidate === undefined) return undefined
      const gateway = resolveEnterpriseGatewayFromStorage(await readFile(candidate.path, 'utf8'))
      if (gateway === undefined || gateway.chat === REGION_GATEWAYS[this.region].chat) return undefined
      return gateway.chat
    } catch {
      return undefined
    }
  }

  /** 刷新并暴露目录（失败时保留 fallback）。 */
  async refreshCatalog(): Promise<GatewayModel[]> {
    const models = await this.solo.fetchModels()
    if (models.length > 0) {
      this.catalog.set(fromSoloModels(models))
      return this.catalog.current().map(toGatewayModel)
    }
    return this.catalog.current().map(toGatewayModel)
  }

  async listModels(): Promise<GatewayModel[]> {
    if (this.catalog.current().length === 0) {
      try { await this.refreshCatalog() } catch { /* fallback 保持 */ }
    }
    return this.catalog.current().map(toGatewayModel)
  }

  async chat(bodyJson: string, signal?: AbortSignal): Promise<GatewayChatResult | GatewayChatFailure> {
    const result = await this.bridge.chatStream(bodyJson, signal)
    if (!result.ok) return result
    return { ok: true, response: result.response }
  }

  status(): Promise<unknown> {
    return this.store.status()
  }
}

function toGatewayModel(info: { id: string; name: string; contextWindow?: number; maxTokens?: number }): GatewayModel {
  return {
    id: info.id,
    name: info.name,
    ...(info.contextWindow === undefined ? {} : { contextWindow: info.contextWindow }),
    ...(info.maxTokens === undefined ? {} : { maxTokens: info.maxTokens }),
  }
}
