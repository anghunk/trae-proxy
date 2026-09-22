/**
 * Provider 工厂：把数据库中的 ProviderRecord 实例化为可热替换的上游适配器。
 *
 * id 作为模型前缀，必须是稳定、可由 URL/JSON 安全使用的 slug。
 * 保存配置后网关调用 replaceProvider，旧实例立即从 registry 摘除。
 */

import type { ProviderRecord, ProviderType } from './store.ts'
import type { UpstreamProvider } from './providers.ts'
import { OpenAiCompatibleProvider } from './providers/openai.ts'
import { OllamaProvider } from './providers/ollama.ts'
import { AnthropicProvider } from './providers/anthropic.ts'
import { GeminiProvider } from './providers/gemini.ts'
import { TraeGatewayProvider } from './providers/trae.ts'

export interface ProviderFactoryOptions {
  logger?: (message: string, detail?: unknown) => void
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** 校验 provider id 可作为模型前缀（模型 id 形如 `<providerId>/<modelId>`）。 */
export function isValidProviderId(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 32 && ID_PATTERN.test(id)
}

export function createProvider(
  record: ProviderRecord,
  options: ProviderFactoryOptions = {},
): UpstreamProvider {
  if (!isValidProviderId(record.id)) {
    throw new Error(`invalid provider id: ${record.id}（仅允许小写字母、数字、连字符）`)
  }
  switch (record.type) {
    case 'trae-cn':
    case 'trae-ai':
      return new TraeGatewayProvider({ record, logger: options.logger })
    case 'openai':
      return new OpenAiCompatibleProvider({ record, logger: options.logger })
    case 'ollama':
      return new OllamaProvider({ record, logger: options.logger })
    case 'anthropic':
      return new AnthropicProvider({ record, logger: options.logger })
    case 'gemini':
      return new GeminiProvider({ record, logger: options.logger })
    default:
      throw new Error(`unsupported provider type: ${(record.type as ProviderType)}`)
  }
}

/** 重建一个 provider 并原子替换 registry 中的旧实例。 */
export function upsertProviderInstance(
  registry: import('./providers.ts').ProviderRegistry,
  record: ProviderRecord,
  options: ProviderFactoryOptions = {},
): UpstreamProvider {
  const instance = createProvider(record, options)
  registry.register(instance)
  if (!record.enabled) {
    // 未启用的 provider 不参与模型目录，但仍可被显式调用时返回 503。
    registry.unregister(instance.id)
  }
  return instance
}

export function providerTypeLabel(type: ProviderType): string {
  const labels: Record<ProviderType, string> = {
    'trae-cn': 'Trae 国内',
    'trae-ai': 'Trae 国际',
    openai: 'OpenAI 兼容',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    ollama: 'Ollama',
  }
  return labels[type]
}
