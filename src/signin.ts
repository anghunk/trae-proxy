/**
 * Trae 每日签到客户端（CN）。
 *
 * 端点（在 api.trae.cn，Cloud-IDE-JWT + 设备头鉴权）：
 *   POST /trae/api/v2/ug/checkin_credits/status   { req_source: 1 }
 *   POST /trae/api/v2/ug/checkin_credits/claim    { req_source: 1 }
 *
 * 状态返回 { checked_in, credits, extra_credits, enable, code }；
 * claim 返回 { code:0, message }。仅 CN 区可用（国际区直接跳过）。
 *
 * 只读 access token，绝不主动刷新。
 *
 * @module trae-proxy/signin
 */

import type { LiveTraeStore } from './auth.ts'
import { buildTraeHeaders } from './protocol.ts'
import type { TraeIdentity } from './identity.ts'
import type { TraeRegion } from './region.ts'

export interface TraeCheckinView {
  enabled: boolean
  checkedIn: boolean
  credits: number
  extraCredits: number
  raw?: unknown
}

interface StatusBody {
  code?: number
  checked_in?: boolean
  did_checked_in?: boolean
  credits?: number
  extra_credits?: number
  enable?: boolean
  message?: string
}

const CN_PAY_BASE = 'https://api.trae.cn'
const STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
const CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'

export class TraeSigninClient {
  private readonly region: TraeRegion
  private readonly store: LiveTraeStore
  private readonly resolveIdentity: () => Promise<TraeIdentity>

  constructor(
    region: TraeRegion,
    store: LiveTraeStore,
    resolveIdentity: () => Promise<TraeIdentity>,
  ) {
    this.region = region
    this.store = store
    this.resolveIdentity = resolveIdentity
  }

  private supported(): boolean {
    return this.region === 'cn'
  }

  private async postJson(path: string): Promise<{ http: number; body: StatusBody }> {
    const credential = await this.store.resolve()
    const identity = await this.resolveIdentity()
    const headers = buildTraeHeaders(credential, identity, { profile: 'model-detail' })
    headers['Content-Type'] = 'application/json'
    const res = await fetch(`${CN_PAY_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ req_source: 1 }),
    })
    const text = await res.text()
    let body: StatusBody = {}
    try { body = JSON.parse(text) as StatusBody } catch { body = { message: text.slice(0, 200) } }
    return { http: res.status, body }
  }

  async getStatus(): Promise<TraeCheckinView> {
    if (!this.supported()) {
      return { enabled: false, checkedIn: false, credits: 0, extraCredits: 0 }
    }
    const { http, body } = await this.postJson(STATUS_PATH)
    if (http !== 200 || (body.code !== undefined && body.code !== 0)) {
      throw new Error(`签到状态查询失败 HTTP ${http} ${body.message ?? ''}`.trim())
    }
    return {
      enabled: body.enable === true,
      checkedIn: body.checked_in === true || body.did_checked_in === true,
      credits: typeof body.credits === 'number' ? body.credits : 0,
      extraCredits: typeof body.extra_credits === 'number' ? body.extra_credits : 0,
      raw: body,
    }
  }

  async claim(): Promise<{ claimed: boolean; already: boolean; message: string }> {
    if (!this.supported()) {
      return { claimed: false, already: true, message: '国际区暂不支持自动签到' }
    }
    const before = await this.getStatus()
    if (before.checkedIn) {
      return { claimed: false, already: true, message: `今天已签到（${before.credits} 积分）` }
    }
    if (!before.enabled) {
      return { claimed: false, already: false, message: '签到活动未开启' }
    }
    const { http, body } = await this.postJson(CLAIM_PATH)
    if (http !== 200 || (body.code !== undefined && body.code !== 0)) {
      throw new Error(`签到领取失败 HTTP ${http} ${body.message ?? ''}`.trim())
    }
    const after = await this.getStatus().catch(() => before)
    return {
      claimed: after.checkedIn,
      already: false,
      message: `签到成功，+${after.credits} 积分${after.extraCredits ? `（连签额外 ${after.extraCredits}）` : ''}`,
    }
  }
}
