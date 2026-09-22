/**
 * Trae Proxy 管理台。
 *
 * 视图：登录/初始化、概览、Providers、API Keys、用量。
 * 设计参考 Vercel 的克制单色风格（Geist 字体、表格化布局），但不复制其品牌。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FormEvent } from 'react'
import { api, type ApiKey, type Dashboard, type Provider } from './api.ts'

type View = 'overview' | 'providers' | 'keys' | 'usage' | 'provider-detail' | 'settings-password' | 'settings-gateway'

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'overview', label: '控制台' },
  { id: 'providers', label: '渠道模型' },
  { id: 'keys', label: 'API Keys' },
  { id: 'usage', label: '用量统计' },
  { id: 'settings-password', label: '系统设置' },
]

const SETTING_VIEWS: Array<{ id: View; path: string; label: string }> = [
  { id: 'settings-password', path: 'password', label: '修改密码' },
  { id: 'settings-gateway', path: 'gateway', label: '网关信息' },
]

function viewFromPath(): View {
  if (/^\/providers\/[^/]+\/?$/.test(window.location.pathname)) return 'provider-detail'
  const settingsMatch = /^\/settings\/(password|gateway)\/?$/.exec(window.location.pathname)
  if (settingsMatch !== null) return `settings-${settingsMatch[1]}` as View
  const match = /^\/(overview|providers|keys|usage)\/?$/.exec(window.location.pathname)
  return match === null ? 'overview' : match[1] as View
}

function navigate(view: View, id?: string): void {
  const path = view === 'provider-detail' && id !== undefined
    ? `/providers/${encodeURIComponent(id)}`
    : view === 'settings-password' ? '/settings/password'
    : view === 'settings-gateway' ? '/settings/gateway'
    : `/${view}`
  window.history.pushState(null, '', path)
}

const TYPE_LABEL: Record<Provider['type'], string> = {
  'trae-cn': 'Trae 国内',
  'trae-ai': 'Trae 国际',
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
}

const TYPE_HINT: Record<Provider['type'], string> = {
  'trae-cn': '读取本机 Trae CN / TRAE SOLO CN 登录态',
  'trae-ai': '读取本机 Trae / TRAE SOLO 国际登录态',
  openai: '任意 OpenAI 兼容服务',
  anthropic: 'Anthropic Messages API',
  gemini: 'Google Gemini API',
  ollama: '本地 Ollama',
}

const TYPE_DEFAULT: Record<Provider['type'], { baseUrl: string; needsKey: boolean; models: string[] }> = {
  'trae-cn': { baseUrl: '', needsKey: false, models: [] },
  'trae-ai': { baseUrl: '', needsKey: false, models: [] },
  openai: { baseUrl: 'https://api.openai.com/v1', needsKey: true, models: ['gpt-4o-mini'] },
  anthropic: { baseUrl: 'https://api.anthropic.com', needsKey: true, models: ['claude-3-5-sonnet-latest'] },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', needsKey: true, models: ['gemini-1.5-flash'] },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, models: ['llama3.1'] },
}

interface OfficialPreset {
  id: string
  name: string
  type: Provider['type']
  baseUrl: string
  needsKey: boolean
  models: string[]
  hint: string
}

const OFFICIAL_PRESETS: OfficialPreset[] = [
  { id: 'deepseek', name: 'DeepSeek 官方', type: 'openai', baseUrl: 'https://api.deepseek.com', needsKey: true, models: ['deepseek-chat', 'deepseek-reasoner'], hint: 'deepseek-chat / deepseek-reasoner' },
  { id: 'zhipu', name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true, models: ['glm-4-plus', 'glm-4-flash'], hint: 'glm-4 系列' },
  { id: 'kimi', name: '月之暗面 Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', needsKey: true, models: ['kimi-k2-0711-preview', 'moonshot-v1-8k'], hint: 'kimi 系列' },
  { id: 'qwen', name: '阿里通义千问', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true, models: ['qwen-max', 'qwen-plus', 'qwen-turbo'], hint: 'qwen 系列' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', needsKey: true, models: ['Qwen/Qwen2.5-72B-Instruct'], hint: '开源模型托管' },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, models: ['anthropic/claude-3.5-sonnet'], hint: '聚合多厂商模型' },
  { id: 'anthropic', name: 'Anthropic 官方', type: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true, models: ['claude-3-5-sonnet-latest'], hint: 'Claude 系列' },
  { id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', needsKey: true, models: ['gemini-2.0-flash'], hint: 'Gemini 系列' },
  { id: 'ollama', name: '本地 Ollama', type: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, models: ['llama3.1'], hint: '本地模型' },
]

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

/** 大数 Token 显示：不足 1 万显示原值，1 万以上以「万」为单位，1 亿以上以「亿」为单位。 */
function formatToken(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(2).replace(/\.?0+$/, '')} 亿`
  }
  if (abs >= 10_000) {
    return `${(value / 10_000).toFixed(2).replace(/\.?0+$/, '')} 万`
  }
  return formatNumber(value)
}

function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(1)} s`
}

function formatDate(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

interface UsageBarItem {
  id: string
  label: string
  detail: string
  requests: number
  success: number
  totalTokens: number
}

/** 用量柱状图：悬停时展示请求、成功率和 Token 明细。 */
function UsageBarChart({ items }: { items: UsageBarItem[] }) {
  const max = Math.max(...items.map(item => item.totalTokens), 1)
  return (
    <div className="bar-chart">
      {items.map(item => {
        const successRate = item.requests === 0 ? '-' : `${((item.success / item.requests) * 100).toFixed(1)}%`
        return (
          <div className="bar-col" key={item.id}>
            <div className="bar-tooltip" role="tooltip">
              <span className="bar-tooltip-title">{item.detail}</span>
              <span className="bar-tooltip-row"><span>请求</span><strong>{formatNumber(item.requests)}</strong></span>
              <span className="bar-tooltip-row"><span>成功率</span><strong>{successRate}</strong></span>
              <span className="bar-tooltip-row"><span>Token</span><strong>{formatToken(item.totalTokens)}</strong></span>
            </div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ height: `${Math.max(4, (item.totalTokens / max) * 100)}%` }}
              />
            </div>
            <span className="bar-label">{item.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="field">
      <span className="field-head">
        <span className="field-label">{label}</span>
        {hint !== undefined && <span className="field-hint" title={hint}>{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/**
 * 渠道启停滑块。
 *
 * 开启状态下显示「启用」，关闭状态下显示「停用」，可直接点击切换。
 */
function ProviderToggle({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`switch${enabled ? ' on' : ''}`}
      onClick={() => onChange(!enabled)}
      disabled={disabled}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{enabled ? '启用' : '停用'}</span>
    </button>
  )
}

/**
 * 构造仅更新启停状态的渠道保存参数。
 *
 * 后端保存接口需要 type/name/models 等完整字段，切换开关时保留
 * 列表里已有的渠道配置，只覆盖 enabled。
 */
function providerEnabledPatch(provider: Provider, enabled: boolean): Parameters<typeof api.saveProvider>[0] {
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

function Spinner({ label }: { label: string }) {
  return <div className="spinner">{label}...</div>
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fn()
      .then(value => {
        if (cancelled) return
        setData(value)
        setError(undefined)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [...deps, tick])
  return { data, error, loading, reload: () => setTick(value => value + 1) }
}

function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'setup' | 'login'>('setup')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.session()
      .then(session => {
        if (session.authed) onDone()
        else setMode(session.needsSetup ? 'setup' : 'login')
      })
      .catch(() => setMode('login'))
  }, [onDone])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError(undefined)
    if (mode === 'setup' && password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      if (mode === 'setup') {
        await api.bootstrap(username, password)
      } else {
        await api.login(username, password)
      }
      onDone()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={event => { void submit(event) }}>
        <img className="brand-mark" src="/logo.png" alt="Trae Proxy" />
        <h1>{mode === 'setup' ? '创建管理员' : '登录管理台'}</h1>
        <p className="auth-sub">
          {mode === 'setup' ? '首次启动需要初始化本地管理员账户。' : '使用管理员账户登录统一网关控制台。'}
        </p>
        <Field label="用户名">
          <input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" />
        </Field>
        <Field label="密码">
          <input
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
          />
        </Field>
        {mode === 'setup' && (
          <Field label="确认密码">
            <input
              type="password"
              value={confirm}
              onChange={event => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        )}
        {error !== undefined && <div className="alert error">{error}</div>}
        <button className="primary wide" disabled={busy}>
          {busy ? '提交中...' : mode === 'setup' ? '创建并进入' : '登录'}
        </button>
        {mode === 'login' && (
          <button type="button" className="link-button" onClick={() => setMode('setup')}>
            未初始化？创建管理员
          </button>
        )}
      </form>
    </div>
  )
}

function Overview({ providers, dashboard, onRefresh }: {
  providers: Provider[]
  dashboard: Dashboard | undefined
  onRefresh: () => void
}) {
  const enabled = providers.filter(provider => provider.enabled)
  const totalModels = dashboard?.models ?? providers.reduce((sum, provider) => sum + (provider.modelCount ?? 0), 0)
  const cards = [
    { label: '启用渠道', value: `${enabled.length}/${providers.length}` },
    { label: '已配置模型', value: formatNumber(totalModels) },
    { label: '今日请求', value: dashboard === undefined ? '-' : formatNumber(dashboard.usage.today.requests) },
    { label: '累计 Token', value: dashboard === undefined ? '-' : formatToken(dashboard.usage.total.totalTokens) },
  ]
  const modelRows = dashboard?.usage.today.byModel ?? []
  const providerRows = dashboard?.usage.today.byProvider ?? []
  const maxModelTokens = Math.max(...modelRows.map(row => row.totalTokens), 0)
  const maxProviderTokens = Math.max(...providerRows.map(row => row.totalTokens), 0)
  return (
    <section>
      <div className="stat-grid">
        {cards.map(card => (
          <div className="stat-card" key={card.label}>
            <span className="stat-label">{card.label}</span>
            <span className="stat-value">{card.value}</span>
          </div>
        ))}
      </div>
      <div className="overview-actions">
        <button className="secondary compact" onClick={onRefresh}>刷新</button>
      </div>
      <div className="usage-mini-grid">
        <div className="panel">
          <div className="panel-head">
            <h2>今日模型用量</h2>
          </div>
          {modelRows.length === 0 ? (
            <div className="empty">今日暂无模型请求</div>
          ) : (
            <div className="usage-rows">
              {modelRows.slice(0, 6).map(row => (
                <div className="usage-row" key={row.model}>
                  <div className="usage-row-head">
                    <span className="mono">{row.model}</span>
                    <span className="usage-row-value">{formatToken(row.totalTokens)}</span>
                  </div>
                  <div className="usage-bar">
                    <div
                      className="usage-bar-fill"
                      style={{ width: `${maxModelTokens === 0 ? 0 : Math.max(2, (row.totalTokens / maxModelTokens) * 100)}%` }}
                      title={`${row.requests} 次请求`}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>今日渠道用量</h2>
          </div>
          {providerRows.length === 0 ? (
            <div className="empty">今日暂无渠道请求</div>
          ) : (
            <div className="usage-rows">
              {providerRows.slice(0, 6).map(row => (
                <div className="usage-row" key={row.providerId}>
                  <div className="usage-row-head">
                    <span className="mono">{row.providerId}</span>
                    <span className="usage-row-value">
                      {formatNumber(row.requests)} 次 · {formatToken(row.totalTokens)}
                    </span>
                  </div>
                  <div className="usage-bar">
                    <div
                      className="usage-bar-fill"
                      style={{ width: `${maxProviderTokens === 0 ? 0 : Math.max(2, (row.totalTokens / maxProviderTokens) * 100)}%` }}
                      title={`${formatToken(row.totalTokens)} tokens`}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>渠道状态</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>状态</th>
                <th>模型数</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {providers.map(provider => (
                <tr key={provider.id}>
                  <td>
                    <div className="cell-main">{provider.name}</div>
                    <div className="cell-sub mono">{provider.id}</div>
                  </td>
                  <td>{TYPE_LABEL[provider.type]}</td>
                  <td>{provider.enabled ? <span className="badge success">启用</span> : <span className="badge">停用</span>}</td>
                  <td>{provider.modelCount ?? provider.models.length}</td>
                  <td>{formatDate(provider.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function ChannelsView({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const { data, error, loading, reload } = useAsync(() => api.providers(), [])
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [refreshResult, setRefreshResult] = useState<Record<string, string>>({})
  const [toggling, setToggling] = useState<Record<string, boolean>>({})

  const setEnabled = async (provider: Provider, enabled: boolean): Promise<void> => {
    setActionError(undefined)
    setToggling(current => ({ ...current, [provider.id]: true }))
    try {
      await api.saveProvider(providerEnabledPatch(provider, enabled))
      reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setToggling(current => {
        const next = { ...current }
        delete next[provider.id]
        return next
      })
    }
  }

  const refresh = async (id: string): Promise<void> => {
    setActionError(undefined)
    try {
      const result = await api.refreshProvider(id)
      setRefreshResult(current => ({ ...current, [id]: `已刷新 ${result.count} 个模型` }))
      reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const remove = async (provider: Provider): Promise<void> => {
    if (!window.confirm(`删除 provider ${provider.id}？此操作不可撤销。`)) return
    setActionError(undefined)
    try {
      await api.deleteProvider(provider.id)
      reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <section>
      <div className="panel-head">
        <h2>渠道</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          新增渠道
        </button>
      </div>
      {actionError !== undefined && <div className="alert error">{actionError}</div>}
      {creating && (
        <ChannelForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false)
              reload()
            }}
        />
      )}
      <div className="panel">
        {loading && <Spinner label="加载中" />}
        {error !== undefined && <div className="alert error">{error}</div>}
        {!loading && data !== undefined && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>模型</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map(provider => (
                  <tr key={provider.id}>
                    <td>
                      <div className="cell-main">{provider.name}</div>
                      <div className="cell-sub mono">{provider.id}</div>
                    </td>
                    <td>{TYPE_LABEL[provider.type]}</td>
                    <td>
                      <ProviderToggle
                        enabled={provider.enabled}
                        disabled={toggling[provider.id] === true}
                        onChange={next => { void setEnabled(provider, next) }}
                      />
                    </td>
                    <td>
                      {provider.modelCount !== undefined
                        ? `${provider.modelCount}${provider.models.length > 0 ? ` / 映射 ${provider.models.length}` : ''}`
                        : provider.models.length > 0 ? `${provider.models.length}（映射）` : '动态'}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="secondary compact"
                          onClick={() => onOpenDetail(provider.id)}
                        >
                          详情
                        </button>
                        <button className="secondary compact" onClick={() => { void refresh(provider.id) }}>刷新模型</button>
                        <button className="secondary compact danger" onClick={() => { void remove(provider) }}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {refreshResult !== undefined && Object.keys(refreshResult).length > 0 && (
          <div className="toast-row">
            {Object.entries(refreshResult).map(([id, message]) => (
              <span key={id} className="toast">{message}</span>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ChannelForm({
  initial,
  catalog,
  onCancel,
  onSaved,
}: {
  initial?: Provider
  catalog?: string[]
  onCancel: () => void
  onSaved: () => void
}) {
  const template = TYPE_DEFAULT[initial?.type ?? 'openai']
  const [id, setId] = useState(initial?.id ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<Provider['type']>(initial?.type ?? 'openai')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? template.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 120000)
  const [selected, setSelected] = useState<string[]>([])
  const [discovered, setDiscovered] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [success, setSuccess] = useState<string | undefined>(undefined)
  const [presetId, setPresetId] = useState<string | undefined>(undefined)

  const needsKey = TYPE_DEFAULT[type].needsKey
  const models = discovered.length > 0
    ? discovered
    : catalog !== undefined ? catalog : template.models

  const isEdit = initial !== undefined

  useEffect(() => {
    if (initial === undefined) return
    setSelected(initial.models)
    if (initial.models.length === 0 && catalog === undefined) {
      api.refreshProvider(initial.id)
        .then(result => setDiscovered(result.models))
        .catch(() => setDiscovered([]))
    }
  }, [initial])

  useEffect(() => {
    if (catalog !== undefined && catalog.length > 0) setDiscovered(catalog)
  }, [catalog])

  const changeType = (next: Provider['type']): void => {
    setType(next)
    const nextTemplate = TYPE_DEFAULT[next]
    if (isEdit || baseUrl === template.baseUrl || baseUrl === '') setBaseUrl(nextTemplate.baseUrl)
    setApiKey('')
    setSelected([])
    setDiscovered([])
    setSuccess(undefined)
  }

  const applyPreset = (preset: OfficialPreset): void => {
    setPresetId(preset.id)
    setId(preset.id)
    setName(preset.name)
    setType(preset.type)
    setBaseUrl(preset.baseUrl)
    setApiKey('')
    setSelected(preset.models)
    setDiscovered([])
    setSuccess(undefined)
    setError(undefined)
  }

  const validate = (): string | undefined => {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id)) return '渠道 ID 仅允许小写字母、数字和连字符（1-32 位）'
    if (name.trim() === '') return '请填写渠道名称'
    if (type !== 'trae-cn' && type !== 'trae-ai') {
      if (baseUrl.trim() === '') return '请填写 Base URL'
      if (!/^https?:\/\//.test(baseUrl.trim())) return 'Base URL 需要以 http:// 或 https:// 开头'
      if (needsKey && apiKey.trim() === '' && !(isEdit && initial?.apiKeySet)) return '请填写 API Key'
    }
    return undefined
  }

  const testConnection = async (): Promise<void> => {
    setError(undefined)
    setSuccess(undefined)
    const invalid = validate()
    if (invalid !== undefined) {
      setError(invalid)
      return
    }
    setTesting(true)
    try {
      const result = await api.testProvider({
        id,
        name: name.trim(),
        type,
        enabled,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
        timeoutMs,
      })
      setDiscovered(result.models)
      setSuccess(`连接成功，发现 ${result.models.length} 个模型`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setTesting(false)
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError(undefined)
    setSuccess(undefined)
    const invalid = validate()
    if (invalid !== undefined) {
      setError(invalid)
      return
    }
    setBusy(true)
    try {
      await api.saveProvider({
        id,
        name: name.trim(),
        type,
        enabled,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
        timeoutMs,
        models: selected,
      })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel editor">
      <form className="provider-form" onSubmit={event => { void submit(event) }}>
        {!isEdit && (
          <div className="preset-section">
            <div className="preset-head">
              <span>官方渠道</span>
              <span className="preset-hint">点击后自动填充地址与常用模型</span>
            </div>
            <div className="preset-grid">
              {OFFICIAL_PRESETS.map(preset => (
                <button
                  type="button"
                  key={preset.id}
                  className={`preset-card${presetId === preset.id ? ' active' : ''}`}
                  onClick={() => applyPreset(preset)}
                >
                  <span className="preset-name">{preset.name}</span>
                  <span className="preset-models">{preset.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="channel-grid">
          <div className="channel-main">
            <div className="form-grid">
              <Field label="渠道 ID" hint="作为模型前缀，保存后不可变更">
                <input
                  value={id}
                  onChange={event => setId(event.target.value.toLowerCase())}
                  placeholder="如 deepseek"
                  disabled={isEdit}
                />
              </Field>
              <Field label="名称">
                <input value={name} onChange={event => setName(event.target.value)} placeholder="如 DeepSeek 官方" />
              </Field>
              <Field label="类型">
                <select value={type} onChange={event => changeType(event.target.value as Provider['type'])} disabled={isEdit}>
                  {(Object.keys(TYPE_LABEL) as Provider['type'][]).map(item => (
                    <option key={item} value={item}>{TYPE_LABEL[item]}</option>
                  ))}
                </select>
              </Field>
              <Field label="状态">
                <ProviderToggle enabled={enabled} onChange={setEnabled} />
              </Field>
              {(type === 'openai' || type === 'anthropic' || type === 'gemini' || type === 'ollama') && (
                <>
                  <Field label="Base URL" hint={TYPE_HINT[type]}>
                    <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://..." />
                  </Field>
                  <Field label="API Key" hint={isEdit && initial?.apiKeySet ? '已保存，留空保持不变' : '明文保存在本地数据库'}>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={event => setApiKey(event.target.value)}
                      placeholder={isEdit && initial?.apiKeySet ? '••••••••' : 'sk-...'}
                      autoComplete="new-password"
                    />
                  </Field>
                </>
              )}
              <Field label="超时 (ms)">
                <input
                  type="number"
                  min={1000}
                  step={1000}
                  value={timeoutMs}
                  onChange={event => setTimeoutMs(Number(event.target.value))}
                />
              </Field>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => { void testConnection() }}
                disabled={testing || busy}
              >
                {testing ? '获取模型中...' : '获取全部模型'}
              </button>
              <button className="primary" disabled={busy || testing}>{busy ? '保存中...' : '保存并生效'}</button>
              <button type="button" className="secondary" onClick={onCancel}>取消</button>
            </div>
          </div>
          <div className="channel-models">
            <div className="models-head">
              <span>模型映射</span>
              <span className="models-count">
                {models.length === 0 ? '点击获取全部模型' : selected.length === 0 ? '全部' : `映射 ${selected.length} / ${models.length}`}
              </span>
            </div>
            {models.length === 0 ? (
              <div className="empty">点击「获取全部模型」查看并选择要映射的模型</div>
            ) : (
              <>
                <div className="models-tools">
                  <button type="button" className="link-button" onClick={() => setSelected(models)}>全选</button>
                  <button type="button" className="link-button" onClick={() => setSelected([])}>清空</button>
                </div>
                <div className="models-tip">留空表示映射该渠道全部模型，勾选后仅暴露所选模型</div>
                <div className="model-list">
                  {models.map(model => {
                    const checked = selected.includes(model)
                    return (
                      <label key={model} className={`model-item${checked ? ' selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={event => {
                            setSelected(current => event.target.checked
                              ? [...current, model]
                              : current.filter(item => item !== model))
                          }}
                        />
                        <span className="mono">{model}</span>
                      </label>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>
        {error !== undefined && <div className="alert error">{error}</div>}
        {success !== undefined && <div className="alert success">{success}</div>}
      </form>
    </div>
  )
}

function ChannelDetail({ id, onBack, onDeleted }: {
  id: string
  onBack: () => void
  onDeleted: (id: string) => void
}) {
  const { data: provider, error, loading, reload } = useAsync(
    () => api.providers().then(result => result.data.find(item => item.id === id)),
    [id],
  )
  const [refreshedModels, setRefreshedModels] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [testResult, setTestResult] = useState<string | undefined>(undefined)
  const [toggling, setToggling] = useState(false)
  const autoRefreshed = useRef<string | undefined>(undefined)

  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (provider === undefined) return
    setActionError(undefined)
    setTestResult(undefined)
    setToggling(true)
    try {
      await api.saveProvider(providerEnabledPatch(provider, enabled))
      reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setToggling(false)
    }
  }

  const refresh = async (): Promise<void> => {
    setActionError(undefined)
    setTestResult(undefined)
    setRefreshing(true)
    try {
      const result = await api.refreshProvider(id)
      setRefreshedModels(result.models)
      reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRefreshing(false)
    }
  }

  // 进入渠道详情后自动拉取一次完整模型目录，已手动刷新过的渠道不重复请求。
  useEffect(() => {
    if (provider === undefined) return
    if (autoRefreshed.current === provider.id) return
    autoRefreshed.current = provider.id
    void refresh()
  }, [provider])

  const test = async (): Promise<void> => {
    setActionError(undefined)
    setTestResult(undefined)
    setTesting(true)
    try {
      const result = await api.testProvider({
        id,
        name: provider?.name ?? id,
        type: provider?.type ?? 'openai',
        enabled: true,
        ...(provider?.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
        ...(provider?.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }),
      })
      setTestResult(`连接成功，发现 ${result.count} 个模型`)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setTesting(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`删除渠道 ${id}？此操作不可撤销。`)) return
    setActionError(undefined)
    try {
      await api.deleteProvider(id)
      onDeleted(id)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const enabledModels = provider?.models ?? []
  const hasPinned = enabledModels.length > 0
  const previewModels = hasPinned ? enabledModels : refreshedModels
  const previewLabel = hasPinned
    ? `已开启 ${enabledModels.length} 个`
    : refreshedModels.length > 0 ? `${refreshedModels.length} 个可用` : '映射全部'

  return (
    <section>
      <div className="panel-head">
        <h2>渠道详情</h2>
        <div className="row-actions">
          {provider !== undefined && (
            <>
              <ProviderToggle
                enabled={provider.enabled}
                disabled={toggling}
                onChange={next => { void setEnabled(next) }}
              />
              <button className="secondary compact" onClick={() => { void test() }} disabled={testing}>
                {testing ? '检测中...' : '检测连通性'}
              </button>
              <button className="secondary compact" onClick={() => { void refresh() }} disabled={refreshing}>
                {refreshing ? '获取中...' : '刷新模型'}
              </button>
            </>
          )}
          <button className="secondary compact" onClick={() => { navigate('providers'); onBack() }}>返回</button>
          <button className="secondary compact danger" onClick={() => { void remove() }}>删除</button>
        </div>
      </div>
      {actionError !== undefined && <div className="alert error">{actionError}</div>}
      {testResult !== undefined && <div className="alert success">{testResult}</div>}
      {loading && <Spinner label="加载中" />}
      {error !== undefined && <div className="alert error">{error}</div>}
      {!loading && provider !== undefined && (
        <>
          <ChannelForm
            initial={provider}
            catalog={refreshedModels}
            onCancel={() => { navigate('providers'); onBack() }}
            onSaved={() => { void refresh(); reload() }}
          />
          <div className="panel">
            <div className="panel-head">
              <h2>已开启模型</h2>
            </div>
            {refreshing && previewModels.length === 0 ? (
              <Spinner label="正在获取全部模型" />
            ) : previewModels.length === 0 ? (
              <div className="empty">
                {refreshedModels.length > 0 ? '模型目录已拉取，当前映射全部模型' : '点击「刷新模型」拉取可用目录，当前映射全部模型'}
              </div>
            ) : (
              <div>
                <div className="model-tags">
                  {previewModels.map(model => (
                    <span key={model} className="model-tag mono">{model}</span>
                  ))}
                </div>
                <div className="detail-note">{previewLabel}</div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

interface KeyDraft {
  name: string
  providers: string[]
  models: string[]
}

function permissionLabel(modelPrefixes: string[], modelIds: string[]): string {
  if (modelPrefixes.length === 0 && modelIds.length === 0) return '全部'
  if (modelIds.length > 0) return `${modelIds.length} 个模型`
  return `${modelPrefixes.length} 个渠道`
}

function KeyEditorModal({
  providers,
  initial,
  onClose,
  onSaved,
}: {
  providers: Provider[]
  initial?: ApiKey
  onClose: () => void
  onSaved: (created?: ApiKey & { key: string }) => void
}) {
  const [draft, setDraft] = useState<KeyDraft>({
    name: initial?.name ?? '',
    providers: initial?.modelPrefixes ?? [],
    models: initial?.modelIds ?? [],
  })
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [modelCache, setModelCache] = useState<Record<string, string[]>>({})
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const loadModels = async (provider: Provider): Promise<void> => {
    if (modelCache[provider.id] !== undefined || loadingModels[provider.id]) return
    setLoadingModels(current => ({ ...current, [provider.id]: true }))
    try {
      const result = await api.refreshProvider(provider.id)
      const visible = provider.models.length === 0 ? result.models : result.models.filter(model => provider.models.includes(model))
      setModelCache(current => ({ ...current, [provider.id]: visible }))
    } catch {
      setModelCache(current => ({ ...current, [provider.id]: provider.models }))
    } finally {
      setLoadingModels(current => ({ ...current, [provider.id]: false }))
    }
  }

  const toggleProvider = (provider: Provider): void => {
    setDraft(current => {
      const enabled = current.providers.includes(provider.id)
      if (enabled) {
        return {
          ...current,
          providers: current.providers.filter(id => id !== provider.id),
          models: current.models.filter(model => !model.startsWith(`${provider.id}/`)),
        }
      }
      return { ...current, providers: [...current.providers, provider.id] }
    })
  }

  const toggleModel = (providerId: string, modelId: string): void => {
    const full = `${providerId}/${modelId}`
    setDraft(current => ({
      ...current,
      models: current.models.includes(full)
        ? current.models.filter(item => item !== full)
        : [...current.models, full],
    }))
  }

  const submit = async (): Promise<void> => {
    if (draft.name.trim() === '') {
      setError('请填写密钥名称')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      if (initial === undefined) {
        const result = await api.createApiKey(draft.name.trim(), draft.providers, draft.models)
        onSaved(result.key)
      } else {
        await api.updateApiKey(initial.id, draft.name.trim(), draft.providers, draft.models)
        onSaved()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const selectedModelIds = new Set(draft.models)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <h3>{initial === undefined ? '新增密钥' : '编辑密钥'}</h3>
          <button type="button" className="text-button" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">
          <div className="form-grid single-column">
            <Field label="名称">
              <input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="如 opencode" />
            </Field>
          </div>
          <div className="permission-head">
            <span>可访问范围</span>
            <span className="permission-hint">留空表示全部渠道；勾选渠道后可进一步限定模型</span>
          </div>
          {providers.length === 0 ? (
            <div className="empty">还没有可用渠道</div>
          ) : (
            <div className="permission-list">
              {providers.map(provider => {
                const enabled = draft.providers.includes(provider.id)
                const models = modelCache[provider.id] ?? provider.models
                const expandedHere = expanded === provider.id
                return (
                  <div key={provider.id} className={`permission-item${enabled ? ' enabled' : ''}`}>
                    <div className="permission-row">
                      <label className="permission-check">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => toggleProvider(provider)}
                        />
                        <span className="permission-name">{provider.name || provider.id}</span>
                        <span className="mono permission-id">{provider.id}</span>
                      </label>
                      <div className="row-actions">
                        {enabled && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => {
                              setExpanded(expandedHere ? undefined : provider.id)
                              if (!expandedHere) void loadModels(provider)
                            }}
                          >
                            {expandedHere ? '收起模型' : '选择模型'}
                          </button>
                        )}
                        <span className="badge">{provider.modelCount ?? 0}</span>
                      </div>
                    </div>
                    {expandedHere && enabled && (
                      <div className="permission-models">
                        {loadingModels[provider.id] && models.length === 0 ? (
                          <div className="empty">正在加载模型...</div>
                        ) : models.length === 0 ? (
                          <div className="empty">暂无可选模型</div>
                        ) : (
                          <>
                            <div className="models-tools">
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => setDraft(current => {
                                  const without = current.models.filter(model => !model.startsWith(`${provider.id}/`))
                                  return { ...current, models: [...without, ...models.map(model => `${provider.id}/${model}`)] }
                                })}
                              >
                                全选
                              </button>
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => setDraft(current => ({
                                  ...current,
                                  models: current.models.filter(model => !model.startsWith(`${provider.id}/`)),
                                }))}
                              >
                                清空
                              </button>
                            </div>
                            <div className="permission-model-list">
                              {models.map(model => {
                                const full = `${provider.id}/${model}`
                                return (
                                  <label key={full} className={`permission-model${selectedModelIds.has(full) ? ' selected' : ''}`}>
                                    <input
                                      type="checkbox"
                                      checked={selectedModelIds.has(full)}
                                      onChange={() => toggleModel(provider.id, model)}
                                    />
                                    <span className="mono">{model}</span>
                                  </label>
                                )
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <div className="permission-summary">
            {draft.providers.length === 0 && draft.models.length === 0
              ? '允许访问全部渠道与全部模型'
              : draft.models.length > 0
                ? `已限定 ${draft.models.length} 个模型`
                : `已限定 ${draft.providers.length} 个渠道`}
          </div>
          {error !== undefined && <div className="alert error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" className="primary" onClick={() => { void submit() }} disabled={busy || draft.name.trim() === ''}>
            {busy ? '保存中...' : initial === undefined ? '创建密钥' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

function KeysView() {
  const { data, error, loading, reload } = useAsync(() => api.apiKeys(), [])
  const { data: providers, reload: reloadProviders } = useAsync(() => api.providers(), [])
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; key: ApiKey } | undefined>(undefined)
  const [created, setCreated] = useState<ApiKey & { key: string } | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | undefined>(undefined)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const [copiedKey, setCopiedKey] = useState<string | undefined>(undefined)
  const [actionSuccess, setActionSuccess] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (menu === undefined) return
    const close = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('.popover-menu') !== null) return
      setMenu(undefined)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  const fillCcSwitch = async (key: ApiKey): Promise<void> => {
    setMenu(undefined)
    setBusyKey(key.id)
    setActionError(undefined)
    setActionSuccess(undefined)
    try {
      const result = await api.fillCcSwitchByKey(key.id)
      setActionSuccess(result.instruction)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyKey(undefined)
    }
  }

  const remove = async (key: ApiKey): Promise<void> => {
    if (!window.confirm(`删除 ${key.name}？`)) return
    setActionError(undefined)
    try {
      await api.deleteApiKey(key.id)
      reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** 复制密钥明文；旧版未保留明文的密钥不可复制。 */
  const copyKey = async (key: ApiKey): Promise<void> => {
    if (!key.plaintextStored || key.key === '') return
    setActionError(undefined)
    try {
      await navigator.clipboard.writeText(key.key)
      setCopiedKey(key.id)
      window.setTimeout(() => {
        setCopiedKey(current => (current === key.id ? undefined : current))
      }, 2000)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const menuKey = menu === undefined || data === undefined ? undefined : data.data.find(item => item.id === menu.id)

  return (
    <section>
      <div className="panel-head">
        <h2>API Keys</h2>
        <button className="primary" onClick={() => setModal({ mode: 'create' })}>新增密钥</button>
      </div>
      {created !== undefined && (
        <div className="alert success key-reveal">
          <div className="alert-title">请立即复制，明文只显示一次</div>
          <code className="key-value">{created.key}</code>
          <button className="secondary" onClick={() => { void navigator.clipboard.writeText(created.key) }}>复制</button>
        </div>
      )}
      {actionSuccess !== undefined && <div className="alert success">{actionSuccess}</div>}
      {actionError !== undefined && <div className="alert error">{actionError}</div>}
      <div className="panel">
        {loading && <Spinner label="加载中" />}
        {error !== undefined && <div className="alert error">{error}</div>}
        {!loading && data !== undefined && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>密钥</th>
                  <th>可访问</th>
                  <th>创建时间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map(key => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      <span className="mono">{key.keyPrefix}...</span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={!key.plaintextStored}
                        title={key.plaintextStored ? '复制密钥明文' : '旧版密钥未保留明文'}
                        onClick={() => { void copyKey(key) }}
                      >
                        {copiedKey === key.id ? '已复制' : '复制'}
                      </button>
                    </td>
                    <td>{permissionLabel(key.modelPrefixes, key.modelIds)}</td>
                    <td>{formatDate(key.createdAt)}</td>
                    <td>{key.revokedAt === undefined ? <span className="badge success">有效</span> : <span className="badge">已吊销</span>}</td>
                    <td>
                      <div className="row-actions">
                        <button className="text-button" onClick={() => setModal({ mode: 'edit', key })}>编辑</button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={key.revokedAt !== undefined}
                          onClick={event => {
                            if (menu?.id === key.id) {
                              setMenu(undefined)
                              return
                            }
                            const rect = event.currentTarget.getBoundingClientRect()
                            setMenu({ id: key.id, x: rect.left, y: rect.bottom })
                          }}
                        >
                          配置
                        </button>
                        <button className="text-button danger" onClick={() => { void remove(key) }}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {modal !== undefined && (
        <KeyEditorModal
          providers={providers?.data ?? []}
          initial={modal.mode === 'edit' ? modal.key : undefined}
          onClose={() => setModal(undefined)}
          onSaved={createdKey => {
            if (createdKey !== undefined) {
              setCreated(createdKey)
            }
            setModal(undefined)
            reload()
            reloadProviders()
          }}
        />
      )}
      {menu !== undefined && menuKey !== undefined && createPortal(
        <div
          className="popover-menu fixed"
          style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 188)), top: menu.y + 6 }}
        >
          {!menuKey.plaintextStored && (
            <div className="popover-note">旧版密钥未保留明文，请删除后重新创建</div>
          )}
          <button
            type="button"
            disabled={busyKey === menuKey.id || !menuKey.plaintextStored}
            onClick={() => { void fillCcSwitch(menuKey) }}
          >
            {busyKey === menuKey.id ? '唤起中...' : '填充到 CC-switch'}
          </button>
        </div>,
        document.body,
      )}
    </section>
  )
}

function UsageView() {
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'all'>('7d')
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 10
  const rangeParams = useMemo(() => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    if (range === 'today') {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      return { from: start.getTime() }
    }
    if (range === '7d') return { from: now - 7 * day }
    if (range === '30d') return { from: now - 30 * day }
    return {}
  }, [range])
  const { data, error, loading, reload } = useAsync(
    () => api.usage(rangeParams, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    [rangeParams, page],
  )
  const summary = useMemo(() => data?.summary, [data])
  const recent = data?.recent
  const totalPages = recent === undefined || recent.total === 0 ? 0 : Math.max(1, Math.ceil(recent.total / PAGE_SIZE))
  const currentPage = Math.min(page, Math.max(1, totalPages))
  const successRate = summary === undefined || summary.requests === 0
    ? '-'
    : `${((summary.success / summary.requests) * 100).toFixed(1)}%`

  return (
    <section>
      <div className="panel-head">
        <h2>用量统计</h2>
        <div className="segmented">
          {(['today', '7d', '30d', 'all'] as const).map(item => (
            <button
              key={item}
              className={range === item ? 'active' : ''}
              onClick={() => setRange(item)}
            >
              {item === 'today' ? '今天' : item === '7d' ? '7 天' : item === '30d' ? '30 天' : '全部'}
            </button>
          ))}
        </div>
      </div>
      {loading && <Spinner label="加载中" />}
      {error !== undefined && <div className="alert error">{error}</div>}
      {!loading && data !== undefined && (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-label">请求</span>
              <span className="stat-value">{formatNumber(summary?.requests ?? 0)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">成功率</span>
              <span className="stat-value">{successRate}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Token</span>
              <span className="stat-value">{formatToken(summary?.totalTokens ?? 0)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">平均耗时</span>
              <span className="stat-value">
                {summary === undefined || summary.requests === 0 ? '-' : formatMs(summary.durationMs / summary.requests)}
              </span>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>按天</h2>
            </div>
            {data.byDay.length === 0 ? (
              <div className="empty">暂无数据</div>
            ) : (
              <UsageBarChart
                items={data.byDay.map(item => ({
                  id: item.day,
                  label: item.day.slice(5),
                  detail: item.day,
                  requests: item.requests,
                  success: item.success,
                  totalTokens: item.totalTokens,
                }))}
              />
            )}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>按小时</h2>
              <span className="panel-note">最近 24 小时</span>
            </div>
            {data.byHour.length === 0 ? (
              <div className="empty">暂无数据</div>
            ) : (
              <UsageBarChart
                items={data.byHour.map(item => ({
                  id: item.hour,
                  label: item.hour.slice(11),
                  detail: item.hour,
                  requests: item.requests,
                  success: item.success,
                  totalTokens: item.totalTokens,
                }))}
              />
            )}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>模型用量</h2>
            </div>
            {data.byModel.length === 0 ? (
              <div className="empty">暂无数据</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>请求</th>
                      <th>成功率</th>
                      <th>Token</th>
                      <th>输入 Token</th>
                      <th>输出 Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map(item => (
                      <tr key={item.key ?? '-'}>
                        <td><span className="mono">{item.key ?? '-'}</span></td>
                        <td>{formatNumber(item.requests)}</td>
                        <td>{item.requests === 0 ? '-' : `${((item.success / item.requests) * 100).toFixed(1)}%`}</td>
                        <td>{formatToken(item.totalTokens)}</td>
                        <td>{formatToken(item.requestTokens)}</td>
                        <td>{formatToken(item.responseTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>最近请求</h2>
              <button className="secondary" onClick={reload}>刷新</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>模型</th>
                    <th>状态</th>
                    <th>Token</th>
                    <th>耗时</th>
                    <th>流式</th>
                  </tr>
                </thead>
                <tbody>
                  {(recent?.rows ?? []).map(row => (
                    <tr key={row.id}>
                      <td>{formatDate(row.ts)}</td>
                      <td><span className="mono">{row.model ?? '-'}</span></td>
                      <td>
                        <span className={row.status >= 200 && row.status < 400 ? 'badge success' : 'badge error'}>
                          {row.status}
                        </span>
                      </td>
                      <td>{formatToken(row.totalTokens)}</td>
                      <td>{formatMs(row.durationMs)}</td>
                      <td>{row.streamed === 1 ? '是' : '否'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <button
                className="secondary"
                disabled={page <= 1}
                onClick={() => setPage(value => value - 1)}
              >
                上一页
              </button>
              <span className="pagination-info">
                {recent !== undefined && recent.total > 0
                  ? `第 ${currentPage} / ${totalPages} 页 · 共 ${formatNumber(recent.total)} 条`
                  : '暂无记录'}
              </span>
              <button
                className="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage(value => value + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function PasswordSettingsView() {
  const { data } = useAsync(() => api.settings(), [])
  const [username, setUsername] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | undefined>(undefined)
  const [formError, setFormError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (data !== undefined) setUsername(data.username)
  }, [data])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setFormError(undefined)
    setResult(undefined)
    if (newPassword !== confirm) {
      setFormError('两次输入的新密码不一致')
      return
    }
    if (username.trim() === '') {
      setFormError('用户名不能为空')
      return
    }
    setBusy(true)
    try {
      const saved = await api.updateAdmin(username.trim(), currentPassword, newPassword)
      setUsername(saved.username)
      setCurrentPassword('')
      setNewPassword('')
      setConfirm('')
      setResult('管理员信息已更新')
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <div className="panel">
        <div className="panel-head">
          <h2>管理员</h2>
        </div>
        <form className="provider-form settings-form" onSubmit={event => { void submit(event) }}>
          <div className="form-grid single-column">
            <Field label="用户名">
              <input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" />
            </Field>
            <Field label="当前密码" hint="修改任何设置前需要验证">
              <input
                type="password"
                value={currentPassword}
                onChange={event => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="新密码" hint="留空表示不修改">
              <input
                type="password"
                value={newPassword}
                onChange={event => setNewPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="确认新密码">
              <input
                type="password"
                value={confirm}
                onChange={event => setConfirm(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
          {formError !== undefined && <div className="alert error">{formError}</div>}
          {result !== undefined && <div className="alert success">{result}</div>}
          <div className="form-actions">
            <button className="primary" disabled={busy || currentPassword === ''}>
              {busy ? '保存中...' : '保存管理员信息'}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}

function GatewaySettingsView() {
  const { data, error, loading, reload } = useAsync(() => api.settings(), [])
  return (
    <section>
      <div className="panel">
        <div className="panel-head">
          <h2>网关信息</h2>
          <button className="secondary compact" onClick={reload}>刷新</button>
        </div>
        {loading && <Spinner label="加载中" />}
        {error !== undefined && <div className="alert error">{error}</div>}
        {!loading && data !== undefined && (
          <div className="settings-meta">
            <div className="settings-meta-item">
              <span>API Base URL</span>
              <code className="mono">{data.apiBaseUrl}</code>
            </div>
            <div className="settings-meta-item">
              <span>监听地址</span>
              <code className="mono">{data.host}:{data.port}</code>
            </div>
            <div className="settings-meta-item">
              <span>数据库</span>
              <code className="mono">{data.databasePath}</code>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function Sidebar({ view, onView, onLogout }: {
  view: View
  onView: (view: View) => void
  onLogout: () => void
}) {
  const settingsActive = view === 'settings-password' || view === 'settings-gateway'
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img className="brand-mark" src="/logo.png" alt="Trae Proxy" />
        <div>
          <div className="brand-name">Trae Proxy</div>
          <div className="brand-sub">统一模型网关</div>
        </div>
      </div>
      <nav className="nav">
        {VIEWS.map(item => (
          <button
            key={item.id}
            className={item.id === 'settings-password' && settingsActive ? 'active' : view === item.id ? 'active' : ''}
            onClick={() => {
              navigate(item.id)
              onView(item.id)
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className="dot" />
        <span>{window.location.port || '39310'}</span>
        <button className="link-button" onClick={onLogout}>退出登录</button>
      </div>
    </aside>
  )
}

/**
 * 三栏布局中的中间二级导航。
 *
 * 需要带二级菜单的页面传入 items 与当前激活项即可复用，
 * 展示在左侧主导航与右侧内容之间。
 */
function SecondaryNav({ items, activeId, onSelect }: {
  items: Array<{ id: string; label: string }>
  activeId: string
  onSelect: (id: string) => void
}) {
  return (
    <aside className="secondary-nav">
      <nav>
        {items.map(item => (
          <button
            key={item.id}
            className={activeId === item.id ? 'active' : ''}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  )
}

function Shell() {
  const [view, setView] = useState<View>(viewFromPath)
  const providers = useAsync(() => api.providers(), [])
  const dashboard = useAsync(() => api.dashboard(), [])
  const logout = async (): Promise<void> => {
    await api.logout()
    window.location.reload()
  }
  useEffect(() => {
    const onPopState = (): void => setView(viewFromPath())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const openDetail = (id: string): void => {
    navigate('provider-detail', id)
    setView('provider-detail')
  }
  const backToProviders = (): void => {
    navigate('providers')
    setView('providers')
  }
  const providerId = view === 'provider-detail'
    ? decodeURIComponent(window.location.pathname.slice('/providers/'.length).replace(/\/$/, ''))
    : undefined

  const topbarTitle = view === 'overview' ? '概览'
    : view === 'providers' ? '渠道'
    : view === 'keys' ? 'API Keys'
    : view === 'usage' ? '用量'
    : view === 'settings-password' ? '设置'
    : view === 'settings-gateway' ? '设置'
    : '渠道详情'
  const endpointUrl = `http://127.0.0.1:${window.location.port || '39310'}/v1`
  const settingsActive = view === 'settings-password' || view === 'settings-gateway'

  return (
    <div className={`shell${settingsActive ? ' has-secondary' : ''}`}>
      <Sidebar view={view} onView={setView} onLogout={() => { void logout() }} />
      {settingsActive && (
        <SecondaryNav
          items={SETTING_VIEWS}
          activeId={view}
          onSelect={id => {
            const item = SETTING_VIEWS.find(entry => entry.id === id)
            if (item !== undefined) {
              navigate(item.id, item.path)
              setView(item.id)
            }
          }}
        />
      )}
      <main className="content">
        <header className="topbar">
          <h1>{topbarTitle}</h1>
          <span className="endpoint mono">{endpointUrl}</span>
        </header>
        {view === 'overview' && (
          <Overview
            providers={providers.data?.data ?? []}
            dashboard={dashboard.data}
            onRefresh={() => {
              providers.reload()
              dashboard.reload()
            }}
          />
        )}
        {view === 'providers' && <ChannelsView onOpenDetail={openDetail} />}
        {view === 'provider-detail' && providerId !== undefined && (
          <ChannelDetail id={providerId} onBack={backToProviders} onDeleted={backToProviders} />
        )}
        {view === 'keys' && <KeysView />}
        {view === 'usage' && <UsageView />}
        {view === 'settings-password' && <PasswordSettingsView />}
        {view === 'settings-gateway' && <GatewaySettingsView />}
      </main>
    </div>
  )
}

export function App() {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  useEffect(() => {
    api.session()
      .then(session => {
        setAuthed(session.authed)
        setChecking(false)
      })
      .catch(() => {
        setAuthed(false)
        setChecking(false)
      })
  }, [])
  if (checking) {
    return <div className="app-loading"><Spinner label="正在连接网关" /></div>
  }
  if (!authed) {
    return <AuthScreen onDone={() => {
      setAuthed(true)
      setChecking(false)
    }} />
  }
  return <Shell />
}
