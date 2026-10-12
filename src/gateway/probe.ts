/**
 * 渠道主动探活。
 *
 * 与用量统计无关：按固定间隔对每个启用的渠道发起一次最小的对话请求，
 * 把结果写入 provider_probes，状态页据此判定每小时健康度。探活从网关
 * 启动后开始记录，不会回填历史请求数据。
 *
 * @module trae-proxy/gateway/probe
 */

import type { ProbeLevel } from './store.ts'
import type { ProviderRegistry } from './providers.ts'
import type { GatewayStore } from './store.ts'

export interface ProbeLogger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
}

export interface ProbeRunnerOptions {
  store: GatewayStore
  registry: ProviderRegistry
  /** 两次探活之间的间隔；调用方保证大于 0。 */
  intervalMs: number
  /** 单次探活超时，默认 30 秒。 */
  timeoutMs?: number
  /** 单轮并发探活的渠道数，默认 3。 */
  concurrency?: number
  logger?: ProbeLogger
}

export interface ProbeOutcome {
  providerId: string
  level: ProbeLevel
  status: number
  durationMs: number
  model?: string
  error?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CONCURRENCY = 3
/** 冷启动时等待模型目录的超时，避免拖住整轮探活。 */
const MODEL_WAIT_MS = 15_000

/** 给一个 Promise 加超时；超时返回 undefined，不取消底层任务。 */
async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 把探活失败按严重程度分成「波动」或「故障」。 */
function levelForFailure(status: number, kind: string): ProbeLevel {
  if (status === 0) return 'down'
  if (status === 429) return 'degraded'
  if (status === 401 || status === 402 || status === 403 || status >= 500) return 'down'
  if (kind === 'authentication' || kind === 'hard_credit' || kind === 'server' || kind === 'unconfigured') return 'down'
  return 'degraded'
}

export class ProviderProbeRunner {
  private readonly store: GatewayStore
  private readonly registry: ProviderRegistry
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly logger?: ProbeLogger
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private intervalTimer: ReturnType<typeof setInterval> | undefined
  private inflight: Promise<ProbeOutcome[]> | undefined
  private lastFinishedAt: number | undefined

  constructor(options: ProbeRunnerOptions) {
    this.store = options.store
    this.registry = options.registry
    this.intervalMs = options.intervalMs
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    this.logger = options.logger
  }

  /** 是否已经启动定时探活。 */
  get started(): boolean {
    return this.startupTimer !== undefined || this.intervalTimer !== undefined
  }

  getIntervalMs(): number {
    return this.intervalMs
  }

  lastProbeAt(): number | undefined {
    return this.lastFinishedAt
  }

  nextProbeAt(): number | undefined {
    if (this.intervalTimer === undefined || this.lastFinishedAt === undefined) return undefined
    return this.lastFinishedAt + this.intervalMs
  }

  /**
   * 启动定时探活。
   *
   * 延迟一小段时间再跑第一轮，给模型目录刷新留出时间；之后按 intervalMs
   * 周期执行。重复调用不会叠加定时器。
   */
  start(delayMs = 5_000): void {
    if (this.started) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      void this.runOnce('startup')
      this.intervalTimer = setInterval(() => {
        void this.runOnce('schedule')
      }, this.intervalMs)
      this.intervalTimer.unref?.()
    }, delayMs)
    this.startupTimer.unref?.()
  }

  stop(): void {
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer)
      this.startupTimer = undefined
    }
    if (this.intervalTimer !== undefined) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = undefined
    }
  }

  /** 立即执行一轮探活；并发调用会复用同一轮结果。 */
  runOnce(reason: 'startup' | 'schedule' | 'manual'): Promise<ProbeOutcome[]> {
    if (this.inflight !== undefined) return this.inflight
    const job = this.runRound(reason).finally(() => {
      this.inflight = undefined
      this.lastFinishedAt = Date.now()
    })
    this.inflight = job
    return job
  }

  private async runRound(reason: string): Promise<ProbeOutcome[]> {
    const providers = this.store.listProviders().filter(record => record.enabled === 1)
    if (providers.length === 0) return []
    const queue = [...providers]
    const results: ProbeOutcome[] = []
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      for (;;) {
        const record = queue.shift()
        if (record === undefined) return
        results.push(await this.probeProvider(record.id))
      }
    })
    await Promise.all(workers)
    const failed = results.filter(item => item.level !== 'up')
    this.logger?.info(
      `渠道探活完成（${reason}）：${results.length - failed.length}/${results.length} 正常`,
      failed.map(item => ({ providerId: item.providerId, level: item.level, status: item.status, error: item.error })),
    )
    return results
  }

  /** 探测单个渠道：先确定可用模型，再发一次最小对话请求并落库。 */
  private async probeProvider(providerId: string): Promise<ProbeOutcome> {
    const provider = this.registry.get(providerId)
    if (provider === undefined) {
      return this.record(providerId, 'down', 0, 0, '渠道未成功加载', undefined)
    }
    const model = await this.resolveModel(providerId)
    if (model === undefined) {
      return this.record(providerId, 'skipped', 0, 0, '暂无可用模型，无法探活', undefined)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const started = Date.now()
    try {
      const result = await this.registry.chat(
        providerId,
        JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 16,
          temperature: 0,
          stream: false,
        }),
        controller.signal,
        { sessionId: `trae-proxy-probe-${providerId}` },
      )
      if (result.ok) {
        return this.record(providerId, 'up', result.response.status, Date.now() - started, undefined, model)
      }
      return this.record(
        providerId,
        levelForFailure(result.status, result.kind),
        result.status,
        Date.now() - started,
        result.message,
        model,
      )
    } catch (error: unknown) {
      return this.record(
        providerId,
        'down',
        0,
        Date.now() - started,
        controller.signal.aborted ? '探活超时' : error instanceof Error ? error.message : String(error),
        model,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /** 取缓存目录里的首个模型；冷启动没有缓存时短暂等待一次模型刷新。 */
  private async resolveModel(providerId: string): Promise<string | undefined> {
    const cached = this.registry.cachedModels(providerId)[0]
    if (cached !== undefined) return cached.id
    try {
      const models = await withTimeout(this.registry.ensureModels(providerId), MODEL_WAIT_MS)
      return models?.[0]?.id
    } catch {
      return undefined
    }
  }

  /** 写库并返回结果，保证每轮探测都有记录。 */
  private record(
    providerId: string,
    level: ProbeLevel,
    status: number,
    durationMs: number,
    error: string | undefined,
    model: string | undefined,
  ): ProbeOutcome {
    const outcome: ProbeOutcome = {
      providerId,
      level,
      status,
      durationMs,
      ...(model === undefined ? {} : { model }),
      ...(error === undefined ? {} : { error }),
    }
    this.store.insertProbe({
      ts: Date.now(),
      providerId,
      ok: level === 'up' ? 1 : 0,
      status,
      level,
      durationMs,
      ...(model === undefined ? {} : { model }),
      ...(error === undefined ? {} : { error }),
    })
    if (level !== 'up') {
      this.logger?.warn(`渠道探活异常: ${providerId}`, { level, status, error })
    }
    return outcome
  }
}
