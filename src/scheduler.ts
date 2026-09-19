/**
 * 每日签到随机调度器（三个代理共用同一套逻辑）。
 *
 * 规则：
 * - 每个「目标」每天首次需要计划时，在本地 START_HOUR–END_HOUR 之间均匀随机一个时刻；
 * - 计划时刻生成后立即持久化，重启不重新随机；
 * - 跨天自动为新的一天重新随机；
 * - 领取动作由调用方提供（doTick），调度器只管「今天几点该跑 / 跑没跑过」；
 * - 到点后由外部定时器周期性调用 runIfDue()，命中后当天只跑一次。
 *
 * 状态文件结构：{ [target]: { date: 'YYYY-MM-DD', runAtSec: 29460, claimed: true, ... } }
 *
 * @module signin-scheduler
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SigninScheduleEntry {
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 当天计划执行的本地秒数（0–86399） */
  runAtSec: number
  /** 当天是否已成功确认领取（或确认无需领取） */
  claimed: boolean
  /** 最近一次结果摘要，供 /status 展示 */
  result?: string
  /** 最近一次尝试的本地时间戳 ms */
  attemptedAtMs?: number
}

export type SigninStateStore = Record<string, SigninScheduleEntry>

export interface SchedulerOptions {
  stateFile: string
  startHour: number
  endHour: number
  /** 每 N ms 由外部触发一次检查时调用；内部也用它做去重 */
  log?: (message: string) => void
}

function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function secondsInDay(d = new Date()): number {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
}

function randomRunAtSec(startHour: number, endHour: number): number {
  const lo = startHour * 3600
  const hi = endHour * 3600 // 落在 [lo, hi)
  return lo + Math.floor(Math.random() * (hi - lo))
}

export function formatSec(sec: number): string {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0')
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * 保证某目标今天有一条计划；跨天或缺失则（重）建。纯内存读，写盘由 save() 统一做。
 */
export function ensureEntry(
  store: SigninStateStore,
  target: string,
  startHour: number,
  endHour: number,
  now = new Date(),
): SigninScheduleEntry {
  const today = localDate(now)
  const existing = store[target]
  if (existing && existing.date === today) return existing
  const entry: SigninScheduleEntry = {
    date: today,
    runAtSec: randomRunAtSec(startHour, endHour),
    claimed: false,
  }
  store[target] = entry
  return entry
}

/**
 * 判断「现在是否已到/已过当天计划时刻」。
 */
export function isDue(entry: SigninScheduleEntry, now = new Date()): boolean {
  if (entry.claimed) return false
  return secondsInDay(now) >= entry.runAtSec
}

export class SigninScheduler {
  private store: SigninStateStore = {}
  private loaded = false
  private readonly inflight = new Set<string>()
  private readonly options: SchedulerOptions

  constructor(options: SchedulerOptions) {
    this.options = options
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.options.stateFile, 'utf8')
      this.store = JSON.parse(raw) as SigninStateStore
    } catch {
      this.store = {}
    }
    this.loaded = true
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true })
    await writeFile(this.options.stateFile, JSON.stringify(this.store, null, 2) + '\n', 'utf8')
  }

  /** 返回某目标今天的计划（确保已生成），不触发领取。 */
  async plan(target: string): Promise<SigninScheduleEntry> {
    await this.load()
    const entry = ensureEntry(this.store, target, this.options.startHour, this.options.endHour)
    return entry
  }

  async entry(target: string): Promise<SigninScheduleEntry | undefined> {
    await this.load()
    const e = this.store[target]
    if (e && e.date === localDate()) return e
    return undefined
  }

  /**
   * 若已到当天随机时刻且今天未确认，则调用 claimer 执行一次。
   * claimer 返回 { claimed, already, message }；抛错则不标记 claimed，下次再试。
   */
  async runIfDue(
    target: string,
    claimer: () => Promise<{ claimed: boolean; already: boolean; message: string }>,
    now = new Date(),
  ): Promise<{ ran: boolean; entry?: SigninScheduleEntry }> {
    await this.load()
    const entry = ensureEntry(this.store, target, this.options.startHour, this.options.endHour, now)
    if (entry.claimed) return { ran: false, entry }
    if (!isDue(entry, now)) return { ran: false, entry }
    if (this.inflight.has(target)) return { ran: false, entry }

    this.inflight.add(target)
    try {
      const outcome = await claimer()
      // 只有「确实领到」或「服务端确认今天已领」才算当天完成
      entry.claimed = outcome.claimed || outcome.already
      entry.result = outcome.message
      entry.attemptedAtMs = Date.now()
      await this.save()
      this.options.log?.(`签到[${target}] ${outcome.message}`)
      return { ran: true, entry }
    } catch (error) {
      entry.result = `失败：${String(error instanceof Error ? error.message : error)}`
      entry.attemptedAtMs = Date.now()
      await this.save().catch(() => {})
      this.options.log?.(`签到[${target}] 失败：${String(error instanceof Error ? error.message : error)}`)
      return { ran: true, entry }
    } finally {
      this.inflight.delete(target)
    }
  }

  /** 手动立即检查/领取（忽略时间窗，但仍尊重 claimed 与服务端幂等）。 */
  async runNow(
    target: string,
    claimer: () => Promise<{ claimed: boolean; already: boolean; message: string }>,
  ): Promise<{ ran: boolean; entry?: SigninScheduleEntry }> {
    await this.load()
    let entry = this.store[target]
    if (!entry || entry.date !== localDate()) {
      entry = ensureEntry(this.store, target, this.options.startHour, this.options.endHour)
    }
    if (entry.claimed) return { ran: false, entry }
    if (this.inflight.has(target)) return { ran: false, entry }
    this.inflight.add(target)
    try {
      const outcome = await claimer()
      entry.claimed = outcome.claimed || outcome.already
      entry.result = outcome.message
      entry.attemptedAtMs = Date.now()
      await this.save()
      this.options.log?.(`签到[${target}] 手动：${outcome.message}`)
      return { ran: true, entry }
    } finally {
      this.inflight.delete(target)
    }
  }
}
