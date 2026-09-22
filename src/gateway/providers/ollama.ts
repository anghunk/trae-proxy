/**
 * Ollama 上游：OpenAI 兼容的本地端点，与 openai 直转一致。
 * 默认 baseUrl 为 http://127.0.0.1:11434/v1。
 */

import { OpenAiCompatibleProvider, type OpenAiProviderOptions } from './openai.ts'
import type { ProviderRecord } from '../store.ts'

export class OllamaProvider extends OpenAiCompatibleProvider {
  constructor(options: OpenAiProviderOptions) {
    super({
      ...options,
      record: {
        ...options.record,
        baseUrl: options.record.baseUrl ?? 'http://127.0.0.1:11434/v1',
      },
    })
  }
}

export function normalizeOllamaRecord(record: ProviderRecord): ProviderRecord {
  return { ...record, baseUrl: record.baseUrl ?? 'http://127.0.0.1:11434/v1' }
}
