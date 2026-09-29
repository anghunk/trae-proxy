/**
 * Trae Proxy 管理台。
 *
 * 视图：登录/初始化、概览、Providers、API Keys、用量统计、使用日志。
 * 设计参考 Vercel 的克制单色风格（Geist 字体、表格化布局），但不复制其品牌。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  ConfigProvider,
  DatePicker,
  Descriptions,
  Divider,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme as antdTheme,
} from 'antd'
import type { MenuProps, TableColumnsType } from 'antd'
import {
  ApiOutlined,
  BarChartOutlined,
  CopyOutlined,
  DashboardOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  GithubOutlined,
  KeyOutlined,
  LinkOutlined,
  LockOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  ReloadOutlined,
  SettingOutlined,
  SunOutlined,
  SyncOutlined,
  UserOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import { api, type ApiKey, type Dashboard, type Provider, type UsageRow } from './api.ts'
import { useTheme, type Theme } from './theme.ts'

const { Title, Text, Paragraph } = Typography
const GITHUB_URL = 'https://github.com/anghunk/trae-proxy'

interface DateRange {
  from: string
  to: string
}

type View = 'overview' | 'providers' | 'keys' | 'usage' | 'logs' | 'provider-detail' | 'settings-password' | 'settings-gateway'

const SETTING_VIEWS: Array<{ id: View; label: string }> = [
  { id: 'settings-password', label: '修改密码' },
  { id: 'settings-gateway', label: '网关信息' },
]

function viewFromPath(): View {
  if (/^\/providers\/[^/]+\/?$/.test(window.location.pathname)) return 'provider-detail'
  const settingsMatch = /^\/settings\/(password|gateway)\/?$/.exec(window.location.pathname)
  if (settingsMatch !== null) return `settings-${settingsMatch[1]}` as View
  const match = /^\/(overview|providers|keys|usage|logs)\/?$/.exec(window.location.pathname)
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
  ollama: '本地 Ollama（未运行时自动调用 CLI）',
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
  hint: string
}

const OFFICIAL_PRESETS: OfficialPreset[] = [
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

/** 返回 1/2/5 序列中的整齐刻度步长。 */
function niceAxisStep(range: number): number {
  if (range <= 0) return 1
  const roughStep = range / 4
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const normalized = roughStep / magnitude
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return niceNormalized * magnitude
}

/** Y 轴刻度使用整齐的万/亿单位，例如 500w、1000w、1.5亿。 */
function formatAxisToken(value: number): string {
  const rounded = Math.round(value)
  const abs = Math.abs(rounded)
  if (abs >= 100_000_000) {
    const yi = rounded / 100_000_000
    return Number.isInteger(yi) ? `${yi}亿` : `${yi.toFixed(1)}亿`
  }
  if (abs >= 10_000) {
    return `${Math.round(rounded / 10_000)}万`
  }
  return formatNumber(rounded)
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

/** 将日期输入值转换为本地时区时间戳；结束边界使用次日零点作为开区间上界。 */
function localDateBoundary(value: string, endExclusive = false): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return undefined
  }
  if (endExclusive) date.setDate(date.getDate() + 1)
  return date.getTime()
}

const CONTRIBUTION_WEEKS = 53
const CONTRIBUTION_DAY_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
})

interface ContributionDay {
  day: string
  requests: number
  success: number
  totalTokens: number
}

/** 返回本地时区日期字符串，避免 UTC 转换导致热力图日期偏移。 */
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 把日期归零到本地当天零点。 */
function localMidnight(value: Date): Date {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

/** 把日期调整到所在周的周一。 */
function localWeekStart(value: Date): Date {
  const date = localMidnight(value)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return date
}

/** 在本地日期上增减天数，自动处理跨月与夏令时。 */
function addLocalDays(value: Date, days: number): Date {
  const date = new Date(value)
  date.setDate(date.getDate() + days)
  return date
}

/** 返回有序数组的分位数，用于把请求量映射为相对热力等级。 */
function quantile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.floor((sorted.length - 1) * ratio)] ?? 0
}

/**
 * 最近一年请求活跃度热力图。
 *
 * 布局对齐 GitHub 贡献墙：每列一周、每行一天，最近 53 周按请求次数分成
 * 五档深浅。未来日期留空，热力等级使用活跃日的分位数计算，避免单日尖峰
 * 让其余日期都退化为同一颜色。
 */
function ContributionWall({ days }: { days: ContributionDay[] }) {
  const calendar = useMemo(() => {
    const today = localMidnight(new Date())
    const firstDay = addLocalDays(localWeekStart(today), -(CONTRIBUTION_WEEKS - 1) * 7)
    const byDay = new Map(days.map(item => [item.day, item]))
    const baseCells = Array.from({ length: CONTRIBUTION_WEEKS * 7 }, (_, index) => {
      const date = addLocalDays(firstDay, index)
      const day = localDayKey(date)
      const value = byDay.get(day)
      return {
        day,
        date,
        future: date.getTime() > today.getTime(),
        requests: value?.requests ?? 0,
        success: value?.success ?? 0,
        totalTokens: value?.totalTokens ?? 0,
      }
    })
    const activeRequests = baseCells
      .filter(cell => !cell.future && cell.requests > 0)
      .map(cell => cell.requests)
      .sort((left, right) => left - right)
    const maxRequests = activeRequests[activeRequests.length - 1] ?? 0
    const thresholds = [
      quantile(activeRequests, 0.25),
      quantile(activeRequests, 0.5),
      quantile(activeRequests, 0.75),
    ]
    const levelFor = (requests: number): number => {
      if (requests <= 0) return 0
      if (activeRequests.length <= 4) {
        if (requests <= maxRequests * 0.25) return 1
        if (requests <= maxRequests * 0.5) return 2
        if (requests <= maxRequests * 0.75) return 3
        return 4
      }
      if (requests <= thresholds[0]) return 1
      if (requests <= thresholds[1]) return 2
      if (requests <= thresholds[2]) return 3
      return 4
    }
    const cells = baseCells.map(cell => ({
      ...cell,
      level: cell.future ? 0 : levelFor(cell.requests),
    }))
    const monthChanges: number[] = []
    for (let index = 0; index < CONTRIBUTION_WEEKS; index += 1) {
      const date = addLocalDays(firstDay, index * 7)
      const previous = index === 0 ? undefined : addLocalDays(firstDay, (index - 1) * 7)
      if (index === 0 || date.getMonth() !== previous?.getMonth()) monthChanges.push(index)
    }
    const monthLabels = Array.from({ length: CONTRIBUTION_WEEKS }, () => '')
    monthChanges.forEach((index, position) => {
      const next = monthChanges[position + 1]
      if (position === 0 && next !== undefined && next - index < 3) return
      monthLabels[index] = `${addLocalDays(firstDay, index * 7).getMonth() + 1}月`
    })
    return {
      cells,
      monthLabels,
      totalRequests: cells.reduce((sum, cell) => sum + (cell.future ? 0 : cell.requests), 0),
      totalTokens: cells.reduce((sum, cell) => sum + (cell.future ? 0 : cell.totalTokens), 0),
      activeDays: activeRequests.length,
    }
  }, [days])

  return (
    <Card className="page-card contribution-panel" title="请求活跃度">
      <div className="contribution-scroll">
        <div
          className="contribution-calendar"
          aria-label={`最近一年每日请求活跃度，共 ${formatNumber(calendar.totalRequests)} 次请求`}
        >
          <div className="contribution-months" aria-hidden="true">
            {calendar.monthLabels.map((label, index) => (
              <span key={`${index}-${label}`}>{label}</span>
            ))}
          </div>
          <div className="contribution-weekdays" aria-hidden="true">
            {['一', '', '三', '', '五', '', '日'].map((label, index) => (
              <span key={`${index}-${label}`}>{label}</span>
            ))}
          </div>
          <div className="contribution-grid">
            {calendar.cells.map((cell, index) => {
              const column = Math.floor(index / 7)
              const row = index % 7
              return (
                <span
                  key={cell.day}
                  className={[
                    'contribution-cell',
                    `level-${cell.level}`,
                    cell.requests <= 0 ? 'no-data' : '',
                    cell.future ? 'future' : '',
                    row < 2 ? 'tooltip-below' : '',
                    column < 4 ? 'tooltip-align-left' : '',
                    column > CONTRIBUTION_WEEKS - 5 ? 'tooltip-align-right' : '',
                  ].filter(Boolean).join(' ')}
                  aria-label={cell.future
                    ? undefined
                    : `${cell.day}：请求数 ${formatNumber(cell.requests)}，Token ${formatToken(cell.totalTokens)}`}
                >
                  {!cell.future && (
                    <span className="contribution-tooltip" role="tooltip">
                      <span className="contribution-tooltip-title">
                        {CONTRIBUTION_DAY_FORMAT.format(cell.date)}
                      </span>
                      <span className="contribution-tooltip-row"><span>请求数</span><strong>{formatNumber(cell.requests)}</strong></span>
                      <span className="contribution-tooltip-row"><span>Token</span><strong>{formatToken(cell.totalTokens)}</strong></span>
                    </span>
                  )}
                </span>
              )
            })}
          </div>
        </div>
      </div>
      <div className="contribution-foot">
        <div className="contribution-summary">
          <span><strong>{formatNumber(calendar.totalRequests)}</strong> 次请求</span>
          <span><strong>{formatToken(calendar.totalTokens)}</strong> Token</span>
          <span><strong>{calendar.activeDays}</strong> 个活跃日</span>
        </div>
      </div>
    </Card>
  )
}

interface UsageBarItem {
  id: string
  label: string
  detail: string
  requests: number
  success: number
  totalTokens: number
}

/**
 * 用量柱状图：悬停时展示请求、成功率和 Token 明细。
 *
 * groupSize 大于 1 时，相邻柱会合并成一格展示；同一格内的用量会求和，
 * 标签只取该组第一条记录，明细则用「起止时间」表示，便于一格容纳两个
 * 小时而不出现横向滚动条。
 */
function UsageBarChart({ items, groupSize = 1, fit = false }: {
  items: UsageBarItem[]
  groupSize?: number
  fit?: boolean
}) {
  const groups = useMemo<UsageBarItem[]>(() => {
    if (groupSize <= 1) return items
    const result: UsageBarItem[] = []
    for (let index = 0; index < items.length; index += groupSize) {
      const chunk = items.slice(index, index + groupSize)
      const first = chunk[0]
      const last = chunk[chunk.length - 1]
      const groupEndHour = String((Number(last.label.slice(0, 2)) + 1) % 24).padStart(2, '0')
      result.push({
        id: `${first.id}-${last.id}`,
        label: chunk.length === 1 ? first.label : `${first.label}-${groupEndHour}:00`,
        detail: chunk.length === 1 ? first.detail : `${first.detail} - ${last.detail}`,
        requests: chunk.reduce((sum, item) => sum + item.requests, 0),
        success: chunk.reduce((sum, item) => sum + item.success, 0),
        totalTokens: chunk.reduce((sum, item) => sum + item.totalTokens, 0),
      })
    }
    return result
  }, [groupSize, items])
  const dataMax = Math.max(...groups.map(item => item.totalTokens), 0)
  const axisStep = Math.max(1, niceAxisStep(dataMax))
  const axisMax = dataMax > 0 ? Math.ceil(dataMax / axisStep) * axisStep : 0
  const max = Math.max(axisMax, 1)
  const axisTicks = axisMax > 0
    ? Array.from({ length: axisMax / axisStep + 1 }, (_, index) => axisMax - index * axisStep)
    : [0]
  return (
    <div className={`bar-chart${fit ? ' fit' : ''}`}>
      <div className="bar-axis" aria-label="用量刻度">
        <div className={`bar-axis-ticks${axisTicks.length === 1 ? ' single' : ''}`}>
          {axisTicks.map(value => (
            <span key={value}>{formatAxisToken(value)}</span>
          ))}
        </div>
      </div>
      {groups.map(item => {
        const successRate = item.requests === 0 ? '-' : `${((item.success / item.requests) * 100).toFixed(1)}%`
        return (
          <div className="bar-col" key={item.id}>
            <div className="bar-tooltip" role="tooltip">
              <span className="bar-tooltip-title">
                {groupSize > 1 && groups.length > 1
                  ? `${item.detail.split(' - ')[0].slice(0, 10)} ${item.label}`
                  : item.detail}
              </span>
              <span className="bar-tooltip-row"><span>请求</span><strong>{formatNumber(item.requests)}</strong></span>
              <span className="bar-tooltip-row"><span>成功率</span><strong>{successRate}</strong></span>
              <span className="bar-tooltip-row"><span>Token</span><strong>{formatToken(item.totalTokens)}</strong></span>
            </div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  height: item.totalTokens <= 0
                    ? '0%'
                    : `${Math.max(4, (item.totalTokens / max) * 100)}%`,
                }}
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
    <Form.Item label={label} tooltip={hint}>
      {children}
    </Form.Item>
  )
}

/** 页面级操作区：统一放在顶部标题下方，避免重复渲染页面标题。 */
function PageActions({ children }: { children: React.ReactNode }) {
  return (
    <Flex justify="flex-end" align="center" gap={12} wrap="wrap" className="page-actions">
      {children}
    </Flex>
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
    <Switch
      checked={enabled}
      onChange={onChange}
      disabled={disabled}
    />
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
  return (
    <Flex align="center" justify="center" gap={12} className="spinner">
      <Spin />
      <Text type="secondary">{label}</Text>
    </Flex>
  )
}

/** 页面底部的 GitHub 仓库链接。 */
function GitHubLink({ className }: { className?: string }) {
  return (
    <a
      className={className === undefined ? 'github-link' : `github-link ${className}`}
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
    >
      <GithubOutlined />
      GitHub
    </a>
  )
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

/** 主题切换按钮：在明亮与黑夜之间切换，偏好由 useTheme 持久化。 */
function ThemeToggle({ theme, onToggle, floating = false }: {
  theme: Theme
  onToggle: () => void
  floating?: boolean
}) {
  const target = theme === 'dark' ? '明亮' : '黑夜'
  const label = `切换到${target}主题`
  return (
    <Tooltip title={label}>
      <Button
        type="text"
        shape="circle"
        className={floating ? 'theme-toggle floating' : 'theme-toggle'}
        onClick={onToggle}
        aria-label={label}
        icon={theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
      />
    </Tooltip>
  )
}

function AuthScreen({ onDone, theme, onToggleTheme }: {
  onDone: () => void
  theme: Theme
  onToggleTheme: () => void
}) {
  const [mode, setMode] = useState<'setup' | 'login'>('setup')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const switchMode = (next: 'setup' | 'login'): void => {
    setMode(next)
    setPassword('')
    setConfirm('')
    setError(undefined)
  }

  useEffect(() => {
    api.session()
      .then(session => {
        if (session.authed) onDone()
        else setMode(session.needsSetup ? 'setup' : 'login')
      })
      .catch(() => setMode('login'))
  }, [onDone])

  const submit = async (): Promise<void> => {
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
      <ThemeToggle theme={theme} onToggle={onToggleTheme} floating />
      <GitHubLink className="auth-github" />
      <Card className="auth-card">
        <img className="brand-mark" src="/logo.png" alt="Trae Proxy" />
        <Title level={3}>{mode === 'setup' ? '创建管理员' : '登录管理台'}</Title>
        <Paragraph type="secondary">
          {mode === 'setup' ? '首次启动需要初始化本地管理员账户。' : '使用管理员账户登录统一网关控制台。'}
        </Paragraph>
        <Form layout="vertical" onFinish={() => { void submit() }}>
          <Field label="用户名">
            <Input
              value={username}
              onChange={event => setUsername(event.target.value)}
              autoComplete="username"
              prefix={<UserOutlined />}
            />
          </Field>
          <Field label="密码">
            <Input.Password
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
              prefix={<LockOutlined />}
            />
          </Field>
          {mode === 'setup' && (
            <Field label="确认密码">
              <Input.Password
                value={confirm}
                onChange={event => setConfirm(event.target.value)}
                autoComplete="new-password"
                prefix={<LockOutlined />}
              />
            </Field>
          )}
          {error !== undefined && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
          <Button type="primary" htmlType="submit" loading={busy} block size="large">
            {mode === 'setup' ? '创建并进入' : '登录'}
          </Button>
          {mode === 'login' && (
            <Button type="link" htmlType="button" block onClick={() => switchMode('setup')}>
              未初始化？创建管理员
            </Button>
          )}
          {mode === 'setup' && (
            <Button type="link" htmlType="button" block onClick={() => switchMode('login')}>
              已有管理员，去登录
            </Button>
          )}
        </Form>
      </Card>
    </div>
  )
}

interface CallFormat {
  id: string
  name: string
  method: 'GET' | 'POST'
  path: string
  description: string
}

/**
 * 概览页调用格式说明。
 *
 * 复制按钮统一写入当前管理台域名与 HTTP 路径，不包含任何凭据。
 */
function CallFormatPanel() {
  const origin = window.location.origin
  const [copied, setCopied] = useState<string | undefined>(undefined)
  const formats: CallFormat[] = [
    {
      id: 'models',
      name: '模型列表',
      method: 'GET',
      path: '/v1/models',
      description: '获取当前 API Key 可访问的模型',
    },
    {
      id: 'chat',
      name: 'Chat Completions',
      method: 'POST',
      path: '/v1/chat/completions',
      description: 'OpenAI 对话格式，支持 SSE 流式返回',
    },
    {
      id: 'responses',
      name: 'Responses API',
      method: 'POST',
      path: '/v1/responses',
      description: 'OpenAI Responses 格式，适配 Codex',
    },
  ]

  const copyAddress = async (format: CallFormat): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${origin}${format.path}`)
      setCopied(format.id)
      window.setTimeout(() => {
        setCopied(current => (current === format.id ? undefined : current))
      }, 2000)
    } catch {
      setCopied(undefined)
    }
  }

  return (
    <Card
      className="page-card"
      title="支持的调用格式"
      extra={<Text code>{origin}/v1</Text>}
    >
      <Paragraph type="secondary" style={{ marginTop: -8 }}>
        OpenAI 兼容接口，认证头 Authorization: Bearer &lt;API_KEY&gt;
      </Paragraph>
      <Flex vertical>
        {formats.map(format => (
          <Flex
            key={format.id}
            align="center"
            justify="space-between"
            gap={12}
            wrap="wrap"
            className="call-format-row"
          >
            <Flex align="center" gap={12} wrap="wrap" style={{ minWidth: 0 }}>
              <Tag color={format.method === 'POST' ? 'blue' : 'default'}>{format.method}</Tag>
              <Text code>{format.path}</Text>
              <Text type="secondary">
                {format.name} · {format.description}
              </Text>
            </Flex>
            <Button
              type="link"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => { void copyAddress(format) }}
            >
              {copied === format.id ? '已复制' : '复制地址'}
            </Button>
          </Flex>
        ))}
      </Flex>
    </Card>
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
  const columns: TableColumnsType<Provider> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_value, provider) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{provider.name}</Text>
          <Text type="secondary" code>{provider.id}</Text>
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      render: value => TYPE_LABEL[value as Provider['type']],
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      render: enabled => (
        <Tag color={enabled ? 'success' : 'default'}>{enabled ? '启用' : '停用'}</Tag>
      ),
    },
    {
      title: '模型数',
      render: (_value, provider) => provider.modelCount ?? provider.models.length,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      render: value => formatDate(value as number),
    },
  ]

  return (
    <section>
      <Row gutter={[12, 12]} className="page-section">
        {cards.map(card => (
          <Col xs={24} sm={12} xl={6} key={card.label}>
            <Card>
              <Statistic title={card.label} value={card.value} />
            </Card>
          </Col>
        ))}
      </Row>
      <Flex justify="flex-end" className="page-section">
        <Button icon={<ReloadOutlined />} onClick={onRefresh}>刷新</Button>
      </Flex>
      <CallFormatPanel />
      <Row gutter={[16, 16]} className="page-section">
        <Col xs={24} xl={12}>
          <Card className="page-card" title="今日模型用量">
          {modelRows.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今日暂无模型请求" />
          ) : (
            <Flex vertical gap={16}>
              {modelRows.slice(0, 6).map(row => (
                <div key={row.model}>
                  <Flex justify="space-between" gap={12}>
                    <Text code ellipsis>{row.model}</Text>
                    <Text type="secondary">{formatToken(row.totalTokens)}</Text>
                  </Flex>
                  <Progress
                    percent={row.totalTokens <= 0 ? 0 : Math.max(2, (row.totalTokens / maxModelTokens) * 100)}
                    showInfo={false}
                    size="small"
                  />
                </div>
              ))}
            </Flex>
          )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card className="page-card" title="今日渠道用量">
          {providerRows.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今日暂无渠道请求" />
          ) : (
            <Flex vertical gap={16}>
              {providerRows.slice(0, 6).map(row => (
                <div key={row.providerId}>
                  <Flex justify="space-between" gap={12}>
                    <Text code ellipsis>{row.providerId}</Text>
                    <Text type="secondary">
                      {formatNumber(row.requests)} 次 · {formatToken(row.totalTokens)}
                    </Text>
                  </Flex>
                  <Progress
                    percent={row.totalTokens <= 0 ? 0 : Math.max(2, (row.totalTokens / maxProviderTokens) * 100)}
                    showInfo={false}
                    size="small"
                  />
                </div>
              ))}
            </Flex>
          )}
          </Card>
        </Col>
      </Row>
      <Card className="page-card" title="渠道状态">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={providers}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无渠道" /> }}
          scroll={{ x: 720 }}
        />
      </Card>
    </section>
  )
}

function ChannelsView({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const { data, error, loading, reload } = useAsync(() => api.providers(), [])
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
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

  const remove = async (provider: Provider): Promise<void> => {
    setActionError(undefined)
    try {
      await api.deleteProvider(provider.id)
      reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const columns: TableColumnsType<Provider> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_value, provider) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{provider.name}</Text>
          <Text type="secondary" code>{provider.id}</Text>
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      render: value => TYPE_LABEL[value as Provider['type']],
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      render: (enabled, provider) => (
        <ProviderToggle
          enabled={enabled}
          disabled={toggling[provider.id] === true}
          onChange={next => { void setEnabled(provider, next) }}
        />
      ),
    },
    {
      title: '模型',
      render: (_value, provider) => provider.modelCount !== undefined
        ? `${provider.modelCount}${provider.models.length > 0 ? ` / 映射 ${provider.models.length}` : ''}`
        : provider.models.length > 0 ? `${provider.models.length}（映射）` : '动态',
    },
    {
      title: '操作',
      width: 160,
      render: (_value, provider) => (
        <Space size={4} wrap>
          <Button size="small" onClick={() => onOpenDetail(provider.id)}>详情</Button>
          <Popconfirm
            title="删除渠道"
            description={`确定删除 ${provider.id}？此操作不可撤销。`}
            okText="删除"
            cancelText="取消"
            onConfirm={() => { void remove(provider) }}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <section>
      <PageActions>
        <Button type="primary" onClick={() => setCreating(true)}>
          新增渠道
        </Button>
      </PageActions>
      {actionError !== undefined && <Alert type="error" showIcon title={actionError} className="page-alert" />}
      {creating && (
        <ChannelForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false)
              reload()
            }}
        />
      )}
      <Card className="page-card">
        {loading && <Spinner label="加载中" />}
        {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
        {!loading && data !== undefined && (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={data.data}
            pagination={false}
            scroll={{ x: 860 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无渠道" /> }}
          />
        )}
      </Card>
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
  const selectedUnavailable = [...new Set(selected.filter(model => !models.includes(model)))]
  const modelOptions = [...models, ...selectedUnavailable]

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
    setSelected([])
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

  const submit = async (): Promise<void> => {
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
    <Card className="page-card page-form-card">
      <Form layout="vertical" onFinish={() => { void submit() }}>
        {!isEdit && (
          <div className="form-section">
            <Flex justify="space-between" gap={12} wrap="wrap" style={{ marginBottom: 12 }}>
              <Text strong>官方渠道</Text>
              <Text type="secondary">点击后自动填充渠道信息</Text>
            </Flex>
            <Row gutter={[12, 12]}>
              {OFFICIAL_PRESETS.map(preset => (
                <Col xs={24} sm={12} lg={8} xl={6} key={preset.id}>
                  <Card
                    size="small"
                    hoverable
                    className={presetId === preset.id ? 'preset-selected' : ''}
                    onClick={() => applyPreset(preset)}
                  >
                    <Space orientation="vertical" size={2}>
                      <Text strong>{preset.name}</Text>
                      <Text type="secondary">{preset.hint}</Text>
                    </Space>
                  </Card>
                </Col>
              ))}
            </Row>
          </div>
        )}
        <Row gutter={[24, 16]}>
          <Col xs={24} xl={14}>
            <Row gutter={16}>
              <Col xs={24} md={12}>
              <Field label="渠道 ID" hint="作为模型前缀，保存后不可变更">
                <Input
                  value={id}
                  onChange={event => setId(event.target.value.toLowerCase())}
                  placeholder="如 deepseek"
                  disabled={isEdit}
                />
              </Field>
              </Col>
              <Col xs={24} md={12}>
              <Field label="名称">
                <Input value={name} onChange={event => setName(event.target.value)} placeholder="如 DeepSeek 官方" />
              </Field>
              </Col>
              <Col xs={24} md={12}>
              <Field label="类型">
                <Select
                  value={type}
                  onChange={changeType}
                  disabled={isEdit}
                  options={(Object.keys(TYPE_LABEL) as Provider['type'][]).map(item => ({
                    value: item,
                    label: TYPE_LABEL[item],
                  }))}
                />
              </Field>
              </Col>
              <Col xs={24} md={12}>
              <Field label="状态">
                <ProviderToggle enabled={enabled} onChange={setEnabled} />
              </Field>
              </Col>
              {(type === 'openai' || type === 'anthropic' || type === 'gemini' || type === 'ollama') && (
                <>
                  <Col xs={24} md={12}>
                    <Field label="Base URL" hint={TYPE_HINT[type]}>
                      <Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://..." />
                    </Field>
                  </Col>
                  <Col xs={24} md={12}>
                    <Field label="API Key" hint={isEdit && initial?.apiKeySet ? '已保存，留空保持不变' : '明文保存在本地数据库'}>
                      <Input.Password
                        value={apiKey}
                        onChange={event => setApiKey(event.target.value)}
                        placeholder={isEdit && initial?.apiKeySet ? '••••••••' : 'sk-...'}
                        autoComplete="new-password"
                      />
                    </Field>
                  </Col>
                </>
              )}
              <Col xs={24} md={12}>
              <Field label="超时 (ms)">
                <InputNumber
                  min={1000}
                  step={1000}
                  value={timeoutMs}
                  onChange={value => setTimeoutMs(value ?? 120000)}
                  style={{ width: '100%' }}
                />
              </Field>
              </Col>
            </Row>
            <Space wrap>
              <Button
                htmlType="button"
                icon={<SyncOutlined />}
                onClick={() => { void testConnection() }}
                disabled={testing || busy}
                loading={testing}
              >
                获取全部模型
              </Button>
              <Button type="primary" htmlType="submit" loading={busy} disabled={testing}>保存并生效</Button>
              <Button htmlType="button" onClick={onCancel}>取消</Button>
            </Space>
          </Col>
          <Col xs={24} xl={10}>
            <Divider titlePlacement="start" style={{ marginTop: 0 }}>模型映射</Divider>
            <Flex justify="space-between" gap={12} wrap="wrap" style={{ marginBottom: 8 }}>
              <Text type="secondary">留空表示映射该渠道全部模型</Text>
              <Text type="secondary">
                {modelOptions.length === 0
                  ? '点击获取全部模型'
                  : selected.length === 0
                    ? '全部'
                    : selectedUnavailable.length > 0
                      ? `映射 ${selected.length} 个（含 ${selectedUnavailable.length} 个不在目录）`
                      : `映射 ${selected.length} / ${models.length}`}
              </Text>
            </Flex>
            {modelOptions.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="点击「获取全部模型」查看并选择要映射的模型"
              />
            ) : (
              <>
                {models.length > 0 && (
                  <Space size={8} style={{ marginBottom: 8 }}>
                    <Button htmlType="button" type="link" size="small" onClick={() => setSelected(models)}>全选</Button>
                    <Button htmlType="button" type="link" size="small" onClick={() => setSelected([])}>清空</Button>
                  </Space>
                )}
                {selectedUnavailable.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    title={`有 ${selectedUnavailable.length} 个已选模型不在当前目录，取消勾选并保存即可移除。`}
                    style={{ marginBottom: 12 }}
                  />
                )}
                <Flex vertical gap={6} className="model-checklist">
                  {modelOptions.map(model => {
                    const checked = selected.includes(model)
                    const unavailable = selectedUnavailable.includes(model)
                    return (
                      <Checkbox
                        key={model}
                        checked={checked}
                        onChange={event => {
                          setSelected(current => event.target.checked
                              ? [...current, model]
                              : current.filter(item => item !== model))
                        }}
                      >
                        <Space>
                          <Text code>{model}</Text>
                          {unavailable && <Tag color="warning">不在当前目录</Tag>}
                        </Space>
                      </Checkbox>
                    )
                  })}
                </Flex>
              </>
            )}
          </Col>
        </Row>
        {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
        {success !== undefined && <Alert type="success" showIcon title={success} className="page-alert" />}
      </Form>
    </Card>
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
      <PageActions>
        <Space wrap>
          {provider !== undefined && (
            <>
              <ProviderToggle
                enabled={provider.enabled}
                disabled={toggling}
                onChange={next => { void setEnabled(next) }}
              />
              <Button onClick={() => { void test() }} disabled={testing} loading={testing}>检测连通性</Button>
              <Button icon={<SyncOutlined />} onClick={() => { void refresh() }} disabled={refreshing} loading={refreshing}>
                刷新模型
              </Button>
            </>
          )}
          <Button onClick={() => { navigate('providers'); onBack() }}>返回</Button>
          <Popconfirm
            title="删除渠道"
            description={`确定删除 ${id}？此操作不可撤销。`}
            okText="删除"
            cancelText="取消"
            onConfirm={() => { void remove() }}
          >
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      </PageActions>
      {actionError !== undefined && <Alert type="error" showIcon title={actionError} className="page-alert" />}
      {testResult !== undefined && <Alert type="success" showIcon title={testResult} className="page-alert" />}
      {loading && <Spinner label="加载中" />}
      {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
      {!loading && provider !== undefined && (
        <>
          <ChannelForm
            initial={provider}
            catalog={refreshedModels}
            onCancel={() => { navigate('providers'); onBack() }}
            onSaved={() => { void refresh(); reload() }}
          />
          <Card className="page-card" title="已开启模型">
            {refreshing && previewModels.length === 0 ? (
              <Spinner label="正在获取全部模型" />
            ) : previewModels.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={refreshedModels.length > 0 ? '模型目录已拉取，当前映射全部模型' : '点击「刷新模型」拉取可用目录，当前映射全部模型'}
              />
            ) : (
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                <Flex gap={8} wrap="wrap">
                  {previewModels.map(model => (
                    <Tag key={model} style={{ fontFamily: 'Geist Mono, ui-monospace, monospace' }}>{model}</Tag>
                  ))}
                </Flex>
                <Text type="secondary">{previewLabel}</Text>
              </Space>
            )}
          </Card>
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
    <Modal
      open
      title={initial === undefined ? '新增密钥' : '编辑密钥'}
      onCancel={onClose}
      onOk={() => { void submit() }}
      okText={initial === undefined ? '创建密钥' : '保存'}
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: draft.name.trim() === '' }}
      width={760}
    >
      <Form layout="vertical">
        <Field label="名称">
          <Input
            value={draft.name}
            onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
            placeholder="如 opencode"
          />
        </Field>
      </Form>
      <Flex justify="space-between" gap={12} wrap="wrap" style={{ marginBottom: 12 }}>
        <Text strong>可访问范围</Text>
        <Text type="secondary">留空表示全部渠道；勾选渠道后可进一步限定模型</Text>
      </Flex>
      {providers.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可用渠道" />
      ) : (
        <Flex vertical className="permission-list">
          {providers.map(provider => {
            const enabled = draft.providers.includes(provider.id)
            const models = modelCache[provider.id] ?? provider.models
            const expandedHere = expanded === provider.id
            return (
              <div className="permission-item" key={provider.id}>
                <Flex vertical gap={12} style={{ width: '100%' }}>
                  <Flex justify="space-between" align="center" gap={12} wrap="wrap">
                    <Checkbox checked={enabled} onChange={() => toggleProvider(provider)}>
                      <Space>
                        <Text strong>{provider.name || provider.id}</Text>
                        <Text type="secondary" code>{provider.id}</Text>
                      </Space>
                    </Checkbox>
                    <Space>
                      {enabled && (
                        <Button
                          type="link"
                          size="small"
                          onClick={() => {
                            setExpanded(expandedHere ? undefined : provider.id)
                            if (!expandedHere) void loadModels(provider)
                          }}
                        >
                          {expandedHere ? '收起模型' : '选择模型'}
                        </Button>
                      )}
                      <Tag>{provider.modelCount ?? 0} 个模型</Tag>
                    </Space>
                  </Flex>
                  {expandedHere && enabled && (
                    <div className="permission-models">
                      {loadingModels[provider.id] && models.length === 0 ? (
                        <Spinner label="正在加载模型" />
                      ) : models.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可选模型" />
                      ) : (
                        <Space orientation="vertical" size={10} style={{ width: '100%' }}>
                          <Space size={8}>
                            <Button
                              type="link"
                              size="small"
                              onClick={() => setDraft(current => {
                                const without = current.models.filter(model => !model.startsWith(`${provider.id}/`))
                                return { ...current, models: [...without, ...models.map(model => `${provider.id}/${model}`)] }
                              })}
                            >
                              全选
                            </Button>
                            <Button
                              type="link"
                              size="small"
                              onClick={() => setDraft(current => ({
                                ...current,
                                models: current.models.filter(model => !model.startsWith(`${provider.id}/`)),
                              }))}
                            >
                              清空
                            </Button>
                          </Space>
                          <Flex vertical gap={6}>
                            {models.map(model => {
                              const full = `${provider.id}/${model}`
                              return (
                                <Checkbox
                                  key={full}
                                  checked={selectedModelIds.has(full)}
                                  onChange={() => toggleModel(provider.id, model)}
                                >
                                  <Text code>{model}</Text>
                                </Checkbox>
                              )
                            })}
                          </Flex>
                        </Space>
                      )}
                    </div>
                  )}
                </Flex>
              </div>
            )
          })}
        </Flex>
      )}
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 16 }}
        title={draft.providers.length === 0 && draft.models.length === 0
          ? '允许访问全部渠道与全部模型'
          : draft.models.length > 0
            ? `已限定 ${draft.models.length} 个模型`
            : `已限定 ${draft.providers.length} 个渠道`}
      />
      {error !== undefined && <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} />}
    </Modal>
  )
}

function KeysView() {
  const { data, error, loading, reload } = useAsync(() => api.apiKeys(), [])
  const { data: providers, reload: reloadProviders } = useAsync(() => api.providers(), [])
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; key: ApiKey } | undefined>(undefined)
  const [created, setCreated] = useState<ApiKey & { key: string } | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const [copiedKey, setCopiedKey] = useState<string | undefined>(undefined)
  const [actionSuccess, setActionSuccess] = useState<string | undefined>(undefined)

  const fillCcSwitch = async (key: ApiKey): Promise<void> => {
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

  const columns: TableColumnsType<ApiKey> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: value => <Text strong>{value as string}</Text>,
    },
    {
      title: '密钥',
      render: (_value, key) => (
        <Space size={4}>
          <Text code>{key.keyPrefix}...</Text>
          <Tooltip title={key.plaintextStored ? '复制密钥明文' : '旧版密钥未保留明文'}>
            <Button
              type="link"
              size="small"
              disabled={!key.plaintextStored}
              icon={<CopyOutlined />}
              onClick={() => { void copyKey(key) }}
            >
              {copiedKey === key.id ? '已复制' : '复制'}
            </Button>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '可访问',
      render: (_value, key) => permissionLabel(key.modelPrefixes, key.modelIds),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      render: value => formatDate(value as number),
    },
    {
      title: '状态',
      render: (_value, key) => (
        <Tag color={key.revokedAt === undefined ? 'success' : 'default'}>
          {key.revokedAt === undefined ? '有效' : '已吊销'}
        </Tag>
      ),
    },
    {
      title: '操作',
      width: 220,
      render: (_value, key) => (
        <Space size={4} wrap>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => setModal({ mode: 'edit', key })}
          >
            编辑
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'fill',
                  icon: <LinkOutlined />,
                  label: busyKey === key.id ? '唤起中...' : '填充到 CC-switch',
                  disabled: !key.plaintextStored || busyKey === key.id,
                },
              ],
              onClick: () => { void fillCcSwitch(key) },
            }}
          >
            <Button type="link" size="small" disabled={key.revokedAt !== undefined}>配置</Button>
          </Dropdown>
          <Popconfirm
            title="删除密钥"
            description={`确定删除 ${key.name}？`}
            okText="删除"
            cancelText="取消"
            onConfirm={() => { void remove(key) }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <section>
      <PageActions>
        <Button type="primary" onClick={() => setModal({ mode: 'create' })}>新增密钥</Button>
      </PageActions>
      {created !== undefined && (
        <Alert
          type="success"
          showIcon
          className="page-alert"
          title="请立即复制，明文只显示一次"
          description={(
            <Space wrap>
              <Text code style={{ wordBreak: 'break-all' }}>{created.key}</Text>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => { void navigator.clipboard.writeText(created.key) }}
              >
                复制
              </Button>
            </Space>
          )}
        />
      )}
      {actionSuccess !== undefined && <Alert type="success" showIcon title={actionSuccess} className="page-alert" />}
      {actionError !== undefined && <Alert type="error" showIcon title={actionError} className="page-alert" />}
      <Card className="page-card">
        {loading && <Spinner label="加载中" />}
        {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
        {!loading && data !== undefined && (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={data.data}
            pagination={false}
            scroll={{ x: 900 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无密钥" /> }}
          />
        )}
      </Card>
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
    </section>
  )
}

/** 加载 API key 列表，并把用量事件中的 key id 映射为可读名称。 */
function useApiKeyLabel(): (id: string | null | undefined) => string {
  const { data: keysData } = useAsync(() => api.apiKeys(), [])
  const keyMap = useMemo(
    () => new Map((keysData?.data ?? []).map(key => [key.id, key])),
    [keysData],
  )
  return (id: string | null | undefined): string => {
    if (id === null || id === undefined || id === '') return '-'
    const key = keyMap.get(id)
    return key === undefined ? `已删除密钥 (${id.slice(0, 8)})` : key.name
  }
}

interface UsageAggregate {
  key: string | null
  requests: number
  success: number
  requestTokens: number
  responseTokens: number
  totalTokens: number
}

function UsageView() {
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'all'>('7d')
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
  const { data, error, loading } = useAsync(() => api.usage(rangeParams), [rangeParams])
  const keyLabel = useApiKeyLabel()
  const summary = useMemo(() => data?.summary, [data])
  const successRate = summary === undefined || summary.requests === 0
    ? '-'
    : `${((summary.success / summary.requests) * 100).toFixed(1)}%`
  const aggregateColumns = (firstTitle: string, renderFirst: (item: UsageAggregate) => React.ReactNode): TableColumnsType<UsageAggregate> => [
    { title: firstTitle, render: (_value, item) => renderFirst(item) },
    { title: '请求', dataIndex: 'requests', render: value => formatNumber(value as number) },
    {
      title: '成功率',
      render: (_value, item) => item.requests === 0 ? '-' : `${((item.success / item.requests) * 100).toFixed(1)}%`,
    },
    { title: 'Token', dataIndex: 'totalTokens', render: value => formatToken(value as number) },
    { title: '输入 Token', dataIndex: 'requestTokens', render: value => formatToken(value as number) },
    { title: '输出 Token', dataIndex: 'responseTokens', render: value => formatToken(value as number) },
  ]

  return (
    <section>
      <PageActions>
        <Segmented
          value={range}
          onChange={value => setRange(value as typeof range)}
          options={[
            { label: '今天', value: 'today' },
            { label: '7 天', value: '7d' },
            { label: '30 天', value: '30d' },
            { label: '全部', value: 'all' },
          ]}
        />
      </PageActions>
      {loading && <Spinner label="加载中" />}
      {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
      {!loading && data !== undefined && (
        <>
          <Row gutter={[12, 12]} className="page-section">
            <Col xs={24} sm={12} xl={6}>
              <Card><Statistic title="请求" value={formatNumber(summary?.requests ?? 0)} /></Card>
            </Col>
            <Col xs={24} sm={12} xl={6}>
              <Card><Statistic title="成功率" value={successRate} /></Card>
            </Col>
            <Col xs={24} sm={12} xl={6}>
              <Card><Statistic title="Token" value={formatToken(summary?.totalTokens ?? 0)} /></Card>
            </Col>
            <Col xs={24} sm={12} xl={6}>
              <Card>
                <Statistic
                  title="平均耗时"
                  value={summary === undefined || summary.requests === 0 ? '-' : formatMs(summary.durationMs / summary.requests)}
                />
              </Card>
            </Col>
          </Row>
          <Card className="page-card" title="按天">
            {data.byDay.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
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
          </Card>
          <Card className="page-card" title="按小时" extra={<Text type="secondary">最近 24 小时</Text>}>
            {data.byHour.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
            ) : (
              <UsageBarChart
                fit
                groupSize={2}
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
          </Card>
          <Card className="page-card" title="密钥用量">
            {data.byKey.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
            ) : (
              <Table
                rowKey={item => item.key ?? '-'}
                columns={aggregateColumns('密钥', item => <span title={item.key ?? undefined}>{keyLabel(item.key)}</span>)}
                dataSource={data.byKey}
                pagination={false}
                scroll={{ x: 760 }}
              />
            )}
          </Card>
          <Card className="page-card" title="模型用量">
            {data.byModel.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
            ) : (
              <Table
                rowKey={item => item.key ?? '-'}
                columns={aggregateColumns('模型', item => <Text code>{item.key ?? '-'}</Text>)}
                dataSource={data.byModel}
                pagination={false}
                scroll={{ x: 760 }}
              />
            )}
          </Card>
        </>
      )}
    </section>
  )
}

/** 独立展示最近用量事件，支持日期、密钥、模型、状态筛选与分页。 */
function UsageLogsView() {
  const [page, setPage] = useState(1)
  const [dateRange, setDateRange] = useState<DateRange>({ from: '', to: '' })
  const [apiKeyId, setApiKeyId] = useState('')
  const [model, setModel] = useState('')
  const [status, setStatus] = useState<'' | 'success' | 'error'>('')
  const { from: fromDate, to: toDate } = dateRange
  const pageSize = 20
  const keyOptions = useAsync(() => api.usageLogOptions(), [])
  const filterParams = useMemo(() => {
    const from = localDateBoundary(fromDate)
    const to = localDateBoundary(toDate, true)
    return {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(apiKeyId === '' ? {} : { apiKeyId }),
      ...(model === '' ? {} : { model }),
      ...(status === '' ? {} : { status }),
    }
  }, [fromDate, toDate, apiKeyId, model, status])
  const { data, error, loading, reload } = useAsync(
    () => api.usageLogs({ ...filterParams, limit: pageSize, offset: (page - 1) * pageSize }),
    [page, filterParams],
  )
  const keyMap = useMemo(
    () => new Map((keyOptions.data?.apiKeys ?? []).map(key => [key.id, key.name])),
    [keyOptions.data],
  )
  const keyLabel = (id: string | null | undefined): string => {
    if (id === null || id === undefined || id === '') return '-'
    return keyMap.get(id) ?? `已删除密钥 (${id.slice(0, 8)})`
  }
  const total = data?.total ?? 0
  const hasFilters = fromDate !== '' || toDate !== '' || apiKeyId !== '' || model !== '' || status !== ''
  const resetFilters = (): void => {
    setDateRange({ from: '', to: '' })
    setApiKeyId('')
    setModel('')
    setStatus('')
    setPage(1)
  }

  const datePickerValue = fromDate !== '' && toDate !== ''
    ? [dayjs(fromDate), dayjs(toDate)] as [dayjs.Dayjs, dayjs.Dayjs]
    : undefined

  const columns: TableColumnsType<UsageRow> = [
    { title: '时间', dataIndex: 'ts', render: value => formatDate(value as number) },
    {
      title: '密钥',
      dataIndex: 'apiKeyId',
      render: (value: string | undefined) => (
        <span title={value}>{keyLabel(value)}</span>
      ),
    },
    {
      title: '模型',
      dataIndex: 'model',
      render: value => <Text code>{value ?? '-'}</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: value => (
        <Tag color={(value as number) >= 200 && (value as number) < 400 ? 'success' : 'error'}>
          {value as number}
        </Tag>
      ),
    },
    { title: 'Token', dataIndex: 'totalTokens', render: value => formatToken(value as number) },
    { title: '耗时', dataIndex: 'durationMs', render: value => formatMs(value as number) },
    { title: '流式', dataIndex: 'streamed', render: value => value === 1 ? '是' : '否' },
  ]

  return (
    <section>
      <PageActions>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => {
            reload()
            keyOptions.reload()
          }}
        >
          刷新
        </Button>
      </PageActions>
      <Card className="page-card">
        <Form layout="inline" className="log-filters">
          <Form.Item label="日期">
            <DatePicker.RangePicker
              value={datePickerValue}
              onChange={dates => {
                const next = dates?.[0] !== null && dates?.[0] !== undefined && dates[1] !== null && dates[1] !== undefined
                  ? { from: dates[0].format('YYYY-MM-DD'), to: dates[1].format('YYYY-MM-DD') }
                  : { from: '', to: '' }
                setDateRange(next)
                setPage(1)
              }}
            />
          </Form.Item>
          <Form.Item label="密钥">
            <Select
              value={apiKeyId}
              style={{ width: 180 }}
              onChange={value => {
                setApiKeyId(value)
                setPage(1)
              }}
              options={[
                { value: '', label: '全部密钥' },
                ...(keyOptions.data?.apiKeys ?? []).map(key => ({
                  value: key.id,
                  label: key.name ?? `已删除密钥 (${key.id.slice(0, 8)})`,
                })),
              ]}
            />
          </Form.Item>
          <Form.Item label="模型">
            <Select
              value={model}
              style={{ width: 220 }}
              onChange={value => {
                setModel(value)
                setPage(1)
              }}
              options={[
                { value: '', label: '全部模型' },
                ...(keyOptions.data?.models ?? []).map(item => ({ value: item, label: item })),
              ]}
            />
          </Form.Item>
          <Form.Item label="状态">
            <Select
              value={status}
              style={{ width: 140 }}
              onChange={value => {
                setStatus(value as '' | 'success' | 'error')
                setPage(1)
              }}
              options={[
                { value: '', label: '全部状态' },
                { value: 'success', label: '成功' },
                { value: 'error', label: '失败' },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Button htmlType="button" disabled={!hasFilters} onClick={resetFilters}>重置</Button>
          </Form.Item>
        </Form>
        {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
        <Table
          rowKey="id"
          columns={columns}
          dataSource={data?.rows ?? []}
          loading={loading}
          scroll={{ x: 860 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasFilters ? '没有符合条件的记录' : '暂无记录'} /> }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: false,
            showTotal: value => `共 ${formatNumber(value)} 条`,
            onChange: nextPage => {
              setPage(nextPage)
            },
          }}
        />
      </Card>
    </section>
  )
}

/** 固定显示当日用量汇总，独立于用量统计页的日期筛选。 */
function TodayUsageCard() {
  const dayKey = new Date().toLocaleDateString('en-CA')
  const todayParams = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return { from: start.getTime() }
  }, [dayKey])
  const today = useAsync(() => api.usage(todayParams), [todayParams])
  const todaySummary = today.data?.summary
  const todaySuccessRate = todaySummary === undefined || todaySummary.requests === 0
    ? '-'
    : `${((todaySummary.success / todaySummary.requests) * 100).toFixed(1)}%`
  return (
    <>
      <Card className="page-card" title="今日用量" extra={<Text type="secondary">固定显示当天数据</Text>}>
        {today.loading && <Spinner label="加载中" />}
        {today.error !== undefined && <Alert type="error" showIcon title={today.error} className="page-alert" />}
        {!today.loading && today.data !== undefined && (
          <Row gutter={[12, 12]}>
            <Col xs={24} sm={12} xl={6}>
              <Statistic title="请求" value={todaySummary === undefined ? '-' : formatNumber(todaySummary.requests)} />
            </Col>
            <Col xs={24} sm={12} xl={6}>
              <Statistic title="成功率" value={todaySuccessRate} />
            </Col>
            <Col xs={24} sm={12} xl={6}>
              <Statistic title="Token" value={todaySummary === undefined ? '-' : formatToken(todaySummary.totalTokens)} />
            </Col>
            <Col xs={24} sm={12} xl={6}>
              <Statistic
                title="平均耗时"
                value={todaySummary === undefined || todaySummary.requests === 0 ? '-' : formatMs(todaySummary.durationMs / todaySummary.requests)}
              />
            </Col>
          </Row>
        )}
      </Card>
      {!today.loading && today.data !== undefined && (
        <ContributionWall days={today.data.activityByDay ?? []} />
      )}
    </>
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

  const submit = async (): Promise<void> => {
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
      <Card className="page-card" title="管理员">
        <Form layout="vertical" onFinish={() => { void submit() }}>
          <Field label="用户名">
            <Input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" />
          </Field>
          <Field label="当前密码" hint="修改任何设置前需要验证">
            <Input.Password
              value={currentPassword}
              onChange={event => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label="新密码" hint="留空表示不修改">
            <Input.Password
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认新密码">
            <Input.Password
              value={confirm}
              onChange={event => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          {formError !== undefined && <Alert type="error" showIcon title={formError} className="page-alert" />}
          {result !== undefined && <Alert type="success" showIcon title={result} className="page-alert" />}
          <Button type="primary" htmlType="submit" loading={busy} disabled={currentPassword === ''}>
            保存管理员信息
          </Button>
        </Form>
      </Card>
    </section>
  )
}

function GatewaySettingsView() {
  const { data, error, loading, reload } = useAsync(() => api.settings(), [])
  return (
    <section>
      <Card
        className="page-card"
        title="网关信息"
        extra={<Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>}
      >
        {loading && <Spinner label="加载中" />}
        {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
        {!loading && data !== undefined && (
          <Descriptions
            bordered
            column={{ xs: 1, sm: 1, md: 2 }}
            items={[
              { key: 'base', label: 'API Base URL', children: <Text code>{data.apiBaseUrl}</Text> },
              { key: 'host', label: '监听地址', children: <Text code>{data.host}:{data.port}</Text> },
              { key: 'database', label: '数据库', children: <Text code>{data.databasePath}</Text> },
            ]}
          />
        )}
      </Card>
    </section>
  )
}

function Sidebar({ view, onView, onLogout, theme, onToggleTheme }: {
  view: View
  onView: (view: View) => void
  onLogout: () => void
  theme: Theme
  onToggleTheme: () => void
}) {
  const [modal, modalContextHolder] = Modal.useModal()
  const settingsActive = view === 'settings-password' || view === 'settings-gateway'
  const [openKeys, setOpenKeys] = useState<string[]>(settingsActive ? ['settings'] : [])
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    if (!settingsActive) return
    setOpenKeys(current => current.includes('settings') ? current : ['settings'])
  }, [settingsActive])
  const selectedKey = view === 'provider-detail' ? 'providers' : view
  const menuItems: MenuProps['items'] = [
    { key: 'overview', icon: <DashboardOutlined />, label: '控制台' },
    { key: 'providers', icon: <ApiOutlined />, label: '渠道模型' },
    { key: 'keys', icon: <KeyOutlined />, label: 'API Keys' },
    { key: 'usage', icon: <BarChartOutlined />, label: '用量统计' },
    { key: 'logs', icon: <FileTextOutlined />, label: '使用日志' },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '系统设置',
      children: SETTING_VIEWS.map(item => ({ key: item.id, label: item.label })),
    },
  ]
  return (
    <Layout.Sider
      width={220}
      className="sidebar"
      breakpoint="lg"
      collapsedWidth={64}
      collapsed={collapsed}
      collapsible
      trigger={null}
      onCollapse={setCollapsed}
    >
      <div className="sidebar-brand">
        <img className="brand-mark" src="/logo.png" alt="Trae Proxy" />
        <div className="brand-text">
          <div className="brand-name">Trae Proxy</div>
          <div className="brand-sub">统一模型网关</div>
        </div>
      </div>
      <Menu
        mode="inline"
        selectedKeys={[settingsActive ? view : selectedKey]}
        items={menuItems}
        openKeys={openKeys}
        onOpenChange={keys => setOpenKeys(keys as string[])}
        onClick={({ key }) => {
          const next = key as View
          navigate(next)
          onView(next)
        }}
        className="sidebar-menu"
      />
      <div className="sidebar-actions">
        <Tooltip title={collapsed ? '展开导航' : '收起导航'}>
          <Button
            type="text"
            shape="circle"
            aria-label={collapsed ? '展开导航' : '收起导航'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(value => !value)}
          />
        </Tooltip>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
      <div className="sidebar-foot">
        <span className="dot" />
        <span>{window.location.port || '39310'}</span>
        <Tooltip title="退出登录">
          <Button
            type="text"
            size="small"
            icon={<LogoutOutlined />}
            onClick={() => {
              modal.confirm({
                title: '确认退出登录',
                content: '退出后需要重新登录管理台。',
                okText: '退出登录',
                cancelText: '取消',
                okButtonProps: { danger: true },
                onOk: onLogout,
              })
            }}
          >
            退出登录
          </Button>
        </Tooltip>
      </div>
      {modalContextHolder}
    </Layout.Sider>
  )
}

function Shell({ theme, onToggleTheme }: {
  theme: Theme
  onToggleTheme: () => void
}) {
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
    : view === 'logs' ? '使用日志'
    : view === 'settings-password' ? '设置'
    : view === 'settings-gateway' ? '设置'
    : '渠道详情'
  const endpointUrl = `http://127.0.0.1:${window.location.port || '39310'}/v1`

  return (
    <Layout className="shell">
      <Sidebar
        view={view}
        onView={setView}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onLogout={() => { void logout() }}
      />
      <Layout>
        <Layout.Header className="topbar">
          <Title level={3} style={{ margin: 0 }}>{topbarTitle}</Title>
          <Text code>{endpointUrl}</Text>
        </Layout.Header>
        <Layout.Content className="content">
          {view === 'usage' && <TodayUsageCard />}
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
          {view === 'logs' && <UsageLogsView />}
          {view === 'settings-password' && <PasswordSettingsView />}
          {view === 'settings-gateway' && <GatewaySettingsView />}
        </Layout.Content>
      </Layout>
    </Layout>
  )
}

export function App() {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const { theme, toggleTheme } = useTheme()
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
  const content = checking
    ? <div className="app-loading"><Spinner label="正在连接网关" /></div>
    : !authed
      ? (
        <AuthScreen
          theme={theme}
          onToggleTheme={toggleTheme}
          onDone={() => {
            setAuthed(true)
            setChecking(false)
          }}
        />
      )
      : <Shell theme={theme} onToggleTheme={toggleTheme} />

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          borderRadius: 8,
          fontFamily: 'Geist, PingFang SC, Microsoft YaHei, system-ui, sans-serif',
        },
      }}
    >
      {content}
    </ConfigProvider>
  )
}
