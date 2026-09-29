/** 渠道类型、默认值和官方预设。 */

import type { Provider } from '../api.ts'

export const TYPE_LABEL: Record<Provider['type'], string> = {
  'trae-cn': 'Trae 国内',
  'trae-ai': 'Trae 国际',
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
}

export const TYPE_HINT: Record<Provider['type'], string> = {
  'trae-cn': '读取本机 Trae CN / TRAE SOLO CN 登录态',
  'trae-ai': '读取本机 Trae / TRAE SOLO 国际登录态',
  openai: '任意 OpenAI 兼容服务',
  anthropic: 'Anthropic Messages API',
  gemini: 'Google Gemini API',
  ollama: '本地 Ollama（未运行时自动调用 CLI）',
}

export const TYPE_DEFAULT: Record<Provider['type'], { baseUrl: string; needsKey: boolean; models: string[] }> = {
  'trae-cn': { baseUrl: '', needsKey: false, models: [] },
  'trae-ai': { baseUrl: '', needsKey: false, models: [] },
  openai: { baseUrl: 'https://api.openai.com/v1', needsKey: true, models: ['gpt-4o-mini'] },
  anthropic: { baseUrl: 'https://api.anthropic.com', needsKey: true, models: ['claude-3-5-sonnet-latest'] },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', needsKey: true, models: ['gemini-1.5-flash'] },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, models: ['llama3.1'] },
}

export interface OfficialPreset {
  id: string
  name: string
  type: Provider['type']
  baseUrl: string
  needsKey: boolean
  hint: string
}

export const OFFICIAL_PRESETS: OfficialPreset[] = [
  { id: 'deepseek', name: 'DeepSeek 官方', type: 'openai', baseUrl: 'https://api.deepseek.com', needsKey: true, hint: 'deepseek-chat / deepseek-reasoner' },
  { id: 'zhipu', name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true, hint: 'glm-4 系列' },
  { id: 'kimi', name: '月之暗面 Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', needsKey: true, hint: 'kimi 系列' },
  { id: 'qwen', name: '阿里通义千问', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true, hint: 'qwen 系列' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', needsKey: true, hint: '开源模型托管' },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, hint: '聚合多厂商模型' },
  { id: 'anthropic', name: 'Anthropic 官方', type: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true, hint: 'Claude 系列' },
  { id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', needsKey: true, hint: 'Gemini 系列' },
  { id: 'ollama', name: '本地 Ollama', type: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, hint: '自动调用本机 CLI' },
]

/**
 * 构造仅更新启停状态的渠道保存参数。
 *
 * 后端保存接口需要 type/name/models 等完整字段，切换开关时保留
 * 列表里已有的渠道配置，只覆盖 enabled。
 */
export function providerEnabledPatch(provider: Provider, enabled: boolean): Parameters<typeof import('../api.ts').api.saveProvider>[0] {
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    enabled,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }),
    extraHeaders: provider.extraHeaders,
    models: provider.models,
    settings: provider.settings,
  }
}
