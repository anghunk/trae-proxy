/**
 * 管理台 API 客户端。
 */

export interface AdminSession {
  authed: boolean
  needsSetup: boolean
}

export interface Provider {
  id: string
  type: 'trae-cn' | 'trae-ai' | 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'workbuddy' | 'chatgpt-oauth'
  name: string
  enabled: boolean
  baseUrl?: string
  apiKeySet?: boolean
  extraHeaders: Record<string, string>
  timeoutMs?: number
  models: string[]
  settings: Record<string, unknown>
  createdAt: number
  updatedAt: number
  modelCount?: number
}

export interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  key: string
  plaintextStored: boolean
  modelPrefixes: string[]
  modelIds: string[]
  app: string
  createdAt: number
  revokedAt?: number
}

export interface UsageSummary {
  requests: number
  success: number
  requestTokens: number
  responseTokens: number
  totalTokens: number
  durationMs: number
}

export interface UsageRow {
  id: number
  ts: number
  apiKeyId?: string
  providerId?: string
  model?: string
  requestTokens: number
  responseTokens: number
  totalTokens: number
  status: number
  durationMs: number
  streamed: number
}

export interface UsageResponse {
  summary: UsageSummary
  recent: { rows: UsageRow[]; total: number }
  byDay: Array<{ day: string; requests: number; success: number; totalTokens: number }>
  activityByDay: Array<{ day: string; requests: number; success: number; totalTokens: number }>
  byHour: Array<{ hour: string; requests: number; success: number; totalTokens: number }>
  byProvider: Array<{ key: string | null; requests: number; success: number; requestTokens: number; responseTokens: number; totalTokens: number }>
  byKey: Array<{ key: string | null; requests: number; success: number; requestTokens: number; responseTokens: number; totalTokens: number }>
  byModel: Array<{ key: string | null; requests: number; success: number; requestTokens: number; responseTokens: number; totalTokens: number }>
}

export interface UsageLogsResponse {
  rows: UsageRow[]
  total: number
}

export interface UsageLogOptions {
  apiKeys: Array<{ id: string; name?: string }>
  models: string[]
}

export interface UsageLogFilters {
  from?: number
  to?: number
  apiKeyId?: string
  model?: string
  status?: 'success' | 'error'
}

export interface GatewaySettings {
  username: string
  port: number
  host: string
  databasePath: string
  apiBaseUrl: string
}

export interface CcSwitchFillResult {
  ok: boolean
  instruction: string
  modelCount?: number
  models?: string[]
}

/** WorkBuddy 渠道的登录态摘要。 */
export interface WorkbuddySession {
  signedIn: boolean
  accountId?: string
  uid?: string
  source?: string
  expiresAt?: number
  refreshable: boolean
  expired: boolean
}

/** 发起浏览器登录的结果。 */
export interface WorkbuddyLoginStart {
  ok: boolean
  url: string
}

/** 轮询浏览器登录的结果。 */
export interface WorkbuddyLoginPoll {
  ok: boolean
  status: 'pending' | 'done' | 'failed'
  accountId?: string
  error?: string
}

/** ChatGPT 订阅渠道的登录态摘要。 */
export interface ChatgptSession {
  signedIn: boolean
  accountId?: string
  email?: string
  expiresAt?: number
  refreshable: boolean
  expired: boolean
  planUsage: boolean
}

/** ChatGPT 订阅渠道的浏览器授权结果。 */
export interface ChatgptLoginStart {
  ok: boolean
  url: string
}

export interface ChatgptLoginPoll {
  ok: boolean
  status: 'pending' | 'done' | 'failed'
  accountId?: string
  error?: string
}

export interface ChatgptSignOutResult {
  ok: boolean
  remoteRevoked: boolean
}

/** 单个渠道在某一小时内的健康度分档。 */
export type ChannelStatusLevel = 'operational' | 'degraded' | 'outage' | 'idle'

/** 单次主动探活的结果分档。 */
export type ProbeLevel = 'up' | 'degraded' | 'down' | 'skipped'

export interface ChannelProbeSummary {
  ts: number
  level: ProbeLevel
  status: number
  durationMs: number
  model?: string
  error?: string
}

export interface ChannelStatusHour {
  hour: string
  /** 该小时最后一次探活对应的显示状态。 */
  status: ChannelStatusLevel
  /** 该小时最后一次探活时间；没有探活时为 null。 */
  latestTs: number | null
  /** 该小时内参与判定的探活次数（不含「跳过」）。 */
  samples: number
  up: number
  degraded: number
  down: number
  skipped: number
}

export interface ChannelStatus {
  id: string
  name: string
  type: Provider['type']
  enabled: boolean
  /** 区间内参与判定的探活次数。 */
  samples: number
  /** 区间可用性百分比；区间内没有任何探活时为 null。 */
  availability: number | null
  lastProbe: ChannelProbeSummary | null
  hours: ChannelStatusHour[]
}

export interface ChannelProbeSchedule {
  /** 探活间隔（毫秒）；0 表示未启用定时探活。 */
  intervalMs: number
  lastProbeAt: number | null
  nextProbeAt: number | null
}

export interface ChannelStatusResponse {
  from: number
  to: number
  hours: number
  generatedAt: number
  probe: ChannelProbeSchedule
  data: ChannelStatus[]
}

export interface ChannelProbeRunResult {
  ok: boolean
  results: Array<{
    providerId: string
    level: ProbeLevel
    status: number
    durationMs: number
    model?: string
    error?: string
  }>
}

export interface Dashboard {
  providers: { total: number; enabled: number }
  models: number
  usage: {
    today: {
      requests: number
      totalTokens: number
      byModel: Array<{ model: string; requests: number; totalTokens: number }>
      byProvider: Array<{ providerId: string; requests: number; totalTokens: number }>
    }
    total: { requests: number; totalTokens: number }
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    credentials: 'include',
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      message = body.error?.message ?? message
    } catch {
      // 非 JSON 错误保留状态码
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

export const api = {
  session: () => request<AdminSession>('/api/session'),
  bootstrap: (username: string, password: string) =>
    request<{ ok: boolean }>('/api/bootstrap', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    request<{ ok: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  settings: () => request<GatewaySettings>('/api/settings'),
  dashboard: () => request<Dashboard>('/api/dashboard'),
  status: (hours: number) =>
    request<ChannelStatusResponse>(`/api/status?hours=${encodeURIComponent(String(hours))}`),
  probeStatus: () => request<ChannelProbeRunResult>('/api/status/probe', { method: 'POST' }),
  updateAdmin: (username: string, currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; username: string }>('/api/settings/admin', {
      method: 'POST',
      body: JSON.stringify({ username, currentPassword, newPassword }),
    }),
  fillCcSwitchByKey: (id: string) =>
    request<CcSwitchFillResult>(`/api/api-keys/${encodeURIComponent(id)}/cc-switch`, { method: 'POST' }),
  providers: () => request<{ data: Provider[] }>('/api/providers'),
  saveProvider: (body: Partial<Provider> & { id: string }) =>
    request<{ ok: boolean; provider: Provider }>('/api/providers', { method: 'POST', body: JSON.stringify(body) }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  refreshProvider: (id: string) =>
    request<{ ok: boolean; count: number; models: string[] }>(`/api/providers/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  testProvider: (body: Partial<Provider>) =>
    request<{ ok: boolean; count: number; models: string[] }>('/api/providers/test', { method: 'POST', body: JSON.stringify(body) }),
  workbuddySession: (id: string) =>
    request<WorkbuddySession>(`/api/providers/${encodeURIComponent(id)}/workbuddy/session`),
  workbuddyStartLogin: (id: string) =>
    request<WorkbuddyLoginStart>(`/api/providers/${encodeURIComponent(id)}/workbuddy/login`, { method: 'POST' }),
  workbuddyPollLogin: (id: string) =>
    request<WorkbuddyLoginPoll>(`/api/providers/${encodeURIComponent(id)}/workbuddy/login`),
  workbuddySignOut: (id: string) =>
    request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}/workbuddy/login`, { method: 'DELETE' }),
  chatgptSession: (id: string) =>
    request<ChatgptSession>(`/api/providers/${encodeURIComponent(id)}/chatgpt-oauth/session`),
  chatgptStartLogin: (id: string) =>
    request<ChatgptLoginStart>(`/api/providers/${encodeURIComponent(id)}/chatgpt-oauth/login`, { method: 'POST' }),
  chatgptPollLogin: (id: string) =>
    request<ChatgptLoginPoll>(`/api/providers/${encodeURIComponent(id)}/chatgpt-oauth/login`),
  chatgptSignOut: (id: string) =>
    request<ChatgptSignOutResult>(`/api/providers/${encodeURIComponent(id)}/chatgpt-oauth/login`, { method: 'DELETE' }),
  apiKeys: () => request<{ data: ApiKey[] }>('/api/api-keys'),
  createApiKey: (name: string, modelPrefixes: string[], modelIds: string[]) =>
    request<{ ok: boolean; key: ApiKey & { key: string } }>('/api/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, modelPrefixes, modelIds }),
    }),
  updateApiKey: (id: string, name: string, modelPrefixes: string[], modelIds: string[]) =>
    request<{ ok: boolean }>('/api/api-keys', {
      method: 'PUT',
      body: JSON.stringify({ id, name, modelPrefixes, modelIds }),
    }),
  deleteApiKey: (id: string) =>
    request<{ ok: boolean }>(`/api/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  usage: (range: { from?: number; to?: number } = {}, recent: { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    if (range.from !== undefined) params.set('from', String(range.from))
    if (range.to !== undefined) params.set('to', String(range.to))
    if (recent.limit !== undefined) {
      params.set('recent', '1')
      params.set('recentLimit', String(recent.limit))
    }
    if (recent.offset !== undefined) params.set('recentOffset', String(recent.offset))
    const query = params.toString()
    return request<UsageResponse>(`/api/usage${query === '' ? '' : `?${query}`}`)
  },
  usageLogs: (options: UsageLogFilters & { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    if (options.from !== undefined) params.set('from', String(options.from))
    if (options.to !== undefined) params.set('to', String(options.to))
    if (options.apiKeyId !== undefined) params.set('apiKeyId', options.apiKeyId)
    if (options.model !== undefined) params.set('model', options.model)
    if (options.status !== undefined) params.set('status', options.status)
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    const query = params.toString()
    return request<UsageLogsResponse>(`/api/usage/logs${query === '' ? '' : `?${query}`}`)
  },
  usageLogOptions: () => request<UsageLogOptions>('/api/usage/logs/options'),
}
