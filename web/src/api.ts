/**
 * 管理台 API 客户端。
 */

export interface AdminSession {
  authed: boolean
  needsSetup: boolean
}

export interface Provider {
  id: string
  type: 'trae-cn' | 'trae-ai' | 'openai' | 'anthropic' | 'gemini' | 'ollama'
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
  byHour: Array<{ hour: string; requests: number; success: number; totalTokens: number }>
  byProvider: Array<{ key: string | null; requests: number; success: number; requestTokens: number; responseTokens: number; totalTokens: number }>
  byKey: Array<{ key: string | null; requests: number; success: number; requestTokens: number; responseTokens: number; totalTokens: number }>
  byModel: Array<{ key: string | null; requests: number; success: number; requestTokens: number; responseTokens: number; totalTokens: number }>
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
}
