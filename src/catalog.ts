/**
 * 简化版 Trae 模型目录（独立 OpenAI 兼容代理用）。
 *
 * 改自 dingminhua/dsh-connect-trae/src/catalog.ts（MIT，Copyright (c) 2026 LaoDing）。
 * 相对原版的简化：只采用 SOLO `get_detail_param` 已验证的 wire config_name，
 * 不做 remote /models 骨架合并（那是 DSH 卡片显示所需，代理转发不需要），
 * 因此模型 id 就是 `llm_utils_chat` 可直接接受的 config_name，无需 wireConfigName 映射。
 *
 * @module trae-proxy/catalog
 */

import type { TraeReasoningCapability, TraeReasoningEffort } from './reasoning.ts'
import type { TraeRegion } from './region.ts'
import type { TraeSoloModel } from './solo.ts'

export interface TraeModelInfo {
  /** wire config_name，即 /v1/models 暴露给 opencode 的模型 id。 */
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  /** 该模型必须经由的 SOLO 目录 function（solo_work_remote / solo_work_lite / solo_agent）。 */
  wireFunction?: string
  /** reasoning_effort 取值到 wire 取值的映射（供 bridge 使用）。 */
  reasoningEfforts?: Partial<Record<TraeReasoningEffort, string | null>>
}

/** 启动兜底目录（CN），首次线上目录成功后即被替换。 */
const FALLBACK_CN: readonly TraeModelInfo[] = [
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000, wireFunction: 'solo_work_remote' },
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', contextWindow: 200_000, wireFunction: 'solo_work_remote' },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', contextWindow: 200_000, wireFunction: 'solo_work_remote' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200_000, wireFunction: 'solo_work_remote' },
]

/** 启动兜底目录（国际 ai），首次线上目录成功后即被替换。 */
const FALLBACK_AI: readonly TraeModelInfo[] = [
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, wireFunction: 'solo_agent' },
  { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272_000, wireFunction: 'solo_agent' },
  { id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro', contextWindow: 200_000, wireFunction: 'solo_agent' },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200_000, wireFunction: 'solo_agent' },
]

function reasoningEffortMap(reasoning: TraeReasoningCapability | undefined) {
  if (reasoning === undefined) return undefined
  return Object.fromEntries(
    reasoning.supported.map(effort => [effort, effort === 'low' ? 'light' : effort === 'xhigh' ? 'extra_high' : 'high']),
  ) as Partial<Record<TraeReasoningEffort, string | null>>
}

/** 把 SOLO get_detail_param 的模型条目转成目录条目（id 即 wire config_name）。 */
export function fromSoloModels(models: readonly TraeSoloModel[]): TraeModelInfo[] {
  return models.map(model => ({
    id: model.id,
    name: model.name,
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.function === undefined ? {} : { wireFunction: model.function },
    ...reasoningEffortMap(model.reasoning) === undefined
      ? {}
      : { reasoningEfforts: reasoningEffortMap(model.reasoning) },
  }))
}

export class TraeCatalog {
  private models: readonly TraeModelInfo[]

  constructor(region: TraeRegion = 'cn') {
    this.models = region === 'ai' ? FALLBACK_AI : FALLBACK_CN
  }

  current(): readonly TraeModelInfo[] {
    return this.models
  }

  set(models: readonly TraeModelInfo[]): void {
    if (models.length === 0) throw new Error('trae model catalog cannot be empty')
    this.models = models.map(model => ({ ...model }))
  }
}
