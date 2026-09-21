/**
 * 企业版 Trae 网关探测/目录客户端。
 *
 * 只用于模型目录探测；企业版聊天接口当前未完全确认，因此不直接用于生产对话。
 *
 * @module trae-proxy/enterprise-gateway
 */

import { readFile } from 'node:fs/promises'
import type { TraeCredential } from './auth.ts'
import type { TraeIdentity } from './identity.ts'
import { buildTraeHeaders, traeEndpoint } from './protocol.ts'

export interface EnterpriseGatewayConfig {
  readonly chat: string
  readonly modelDetail: string
}

export interface EnterpriseModelsResult {
  readonly gateway: EnterpriseGatewayConfig
  readonly ok: boolean
  readonly models: readonly string[]
  readonly rawCount: number
  readonly error?: string
}

function parseHostInfo(raw: unknown): EnterpriseGatewayConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const apiHost = typeof record['apiHost'] === 'string' && record['apiHost'].trim() !== '' ? record['apiHost'].trim() : undefined
  const consoleHost = typeof record['consoleHost'] === 'string' && record['consoleHost'].trim() !== '' ? record['consoleHost'].trim() : undefined
  const host = apiHost ?? consoleHost
  if (host === undefined) return undefined
  return {
    chat: host,
    modelDetail: host,
  }
}

export function resolveEnterpriseGatewayFromStorage(storageText: string): EnterpriseGatewayConfig | undefined {
  try {
    const parsed = JSON.parse(storageText) as Record<string, unknown>
    return parseHostInfo(parsed['iCubeHostInfo'])
  } catch {
    return undefined
  }
}

export async function fetchEnterpriseModels(options: {
  credential: () => Promise<TraeCredential>
  identity: () => Promise<TraeIdentity>
  storageText: () => Promise<string>
  fetchImpl?: typeof fetch
  log?: (message: string, detail?: unknown) => void
}): Promise<EnterpriseModelsResult> {
  const gateway = resolveEnterpriseGatewayFromStorage(await options.storageText())
  if (gateway === undefined) {
    return { gateway: { chat: '', modelDetail: '' }, ok: false, models: [], rawCount: 0, error: 'no enterprise host info' }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const [credential, identity] = await Promise.all([options.credential(), options.identity()])
  const headers = { ...buildTraeHeaders(credential, identity), Accept: 'application/json' }
  const functions = ['solo_work_remote', 'solo_work_lite', 'solo_agent'] as const
  const byId = new Map<string, number>()
  const failures: string[] = []
  for (const directoryFunction of functions) {
    try {
      const response = await fetchImpl(traeEndpoint(gateway.modelDetail, '/api/ide/v1/get_detail_param'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          function: directoryFunction,
          config_names: null,
          need_prompt: false,
          current_config_info: null,
          poly_prompt: true,
          mode_type: null,
          agent_type: null,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const document = (await response.json()) as Record<string, unknown>
      const list = Array.isArray(document['config_info_list']) ? (document['config_info_list'] as Record<string, unknown>[]) : []
      for (const raw of list) {
        const id = typeof raw['config_name'] === 'string' ? raw['config_name'] : ''
        if (id === '') continue
        byId.set(id, (byId.get(id) ?? 0) + 1)
      }
    } catch (error: unknown) {
      failures.push(`${directoryFunction}: ${String(error).slice(0, 80)}`)
    }
  }
  const models = [...byId.keys()].sort()
  if (models.length === 0) {
    const detail = failures.length > 0 ? ` (${failures.join('; ')})` : ''
    options.log?.('enterprise gateway model discovery failed', { detail })
    return { gateway, ok: false, models: [], rawCount: 0, error: failures.length > 0 ? failures.join('; ') : 'empty enterprise roster' }
  }
  options.log?.('enterprise gateway model discovery ok', { models: models.length, failures })
  return { gateway, ok: true, models, rawCount: models.length }
}
