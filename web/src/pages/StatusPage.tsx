/**
 * 渠道状态页面。
 *
 * 以「每小时一个色块」的时间轴展示每个渠道的健康度。数据来自网关的主动
 * 探活（定时向上游发一次最小对话请求），不依赖真实请求，也不回填历史。
 */

import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Alert, Button, Card, Empty, Flex, Tag, Typography } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { api, type ChannelStatus, type ChannelStatusHour, type ChannelStatusLevel } from '../api.ts'
import { PageActions, Spinner } from '../components/common.tsx'
import { TYPE_LABEL } from '../constants/providers.ts'
import { useAsync } from '../hooks/useAsync.ts'
import { formatMs, formatNumber } from '../utils/format.ts'

const { Text } = Typography

/** 色块的四种状态文案，与参考图的图例一致。 */
const LEVEL_LABEL: Record<ChannelStatusLevel, string> = {
  operational: '正常',
  degraded: '波动',
  outage: '故障',
  idle: '无数据',
}

const LEGEND_LEVELS: ChannelStatusLevel[] = ['operational', 'degraded', 'outage', 'idle']

/** 状态时间轴固定展示最近 7 天（每小时一格）。 */
const STATUS_HOURS = 168

interface HoveredCell {
  provider: ChannelStatus
  hour: ChannelStatusHour
  x: number
  y: number
  below: boolean
}

/** 把时间戳格式化成 HH:mm。 */
function formatClock(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts))
}

/** 图例：正常 / 波动 / 故障 / 无数据。 */
function Legend() {
  return (
    <Flex className="status-legend" gap={16} wrap align="center">
      {LEGEND_LEVELS.map(level => (
        <span className="status-legend-item" key={level}>
          <i className={`status-swatch ${level}`} />
          {LEVEL_LABEL[level]}
        </span>
      ))}
    </Flex>
  )
}

/** 单个渠道的状态行：标题 + 可用性 + 逐小时色块。 */
function StatusRow({ provider, buckets, onHover, onLeave }: {
  provider: ChannelStatus
  buckets: number
  onHover: (event: ReactMouseEvent<HTMLDivElement>, provider: ChannelStatus, hour: ChannelStatusHour) => void
  onLeave: () => void
}) {
  const availability = provider.availability === null ? '—' : `${provider.availability.toFixed(2)}%`
  return (
    <div className={`status-row${provider.enabled ? '' : ' disabled'}`}>
      <div className="status-row-head">
        <Flex align="center" gap={8} wrap style={{ minWidth: 0 }}>
          <Text strong>{provider.name}</Text>
          <Text type="secondary" className="status-provider-type">{TYPE_LABEL[provider.type]}</Text>
          {!provider.enabled && <Tag bordered={false}>已停用</Tag>}
        </Flex>
        <Flex align="baseline" gap={6} wrap>
          <Text strong>{availability}</Text>
          <Text type="secondary" className="status-provider-type">
            可用性 · {formatNumber(provider.samples)} 次探活
            {provider.lastProbe !== null && ` · 最后 ${formatClock(provider.lastProbe.ts)}`}
          </Text>
        </Flex>
      </div>
      <div
        className="status-bars"
        style={{ gridTemplateColumns: `repeat(${buckets}, minmax(0, 1fr))` }}
        role="img"
        aria-label={`${provider.name} 最近 7 天探活状态`}
      >
        {provider.hours.map(hour => (
          <div
            key={hour.hour}
            className={`status-bar ${hour.status}`}
            onMouseEnter={event => onHover(event, provider, hour)}
            onMouseLeave={onLeave}
          />
        ))}
      </div>
    </div>
  )
}

export function StatusPage() {
  const { data, error, loading, reload } = useAsync(() => api.status(STATUS_HOURS), [])
  const [hovered, setHovered] = useState<HoveredCell | undefined>(undefined)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | undefined>(undefined)

  const axis = useMemo(() => {
    if (data === undefined) return undefined
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    return {
      start: formatter.format(new Date(data.from)),
      middle: formatter.format(new Date(Math.round(((data.from + data.to) / 2) / 3600000) * 3600000)),
      end: formatter.format(new Date(data.to)),
    }
  }, [data])

  const caption = data === undefined || data.probe.intervalMs === 0
    ? '主动探测渠道可用性'
    : `每 ${Math.round(data.probe.intervalMs / 60000)} 分钟主动探测`

  /** 手动触发一轮探活，结束后刷新状态数据。 */
  const runProbe = async (): Promise<void> => {
    setProbing(true)
    setProbeError(undefined)
    try {
      await api.probeStatus()
      reload()
    } catch (reason: unknown) {
      setProbeError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setProbing(false)
    }
  }

  /** 悬停色块时把提示定位到色块上方，并限制在视口内。 */
  const showTooltip = (
    event: ReactMouseEvent<HTMLDivElement>,
    provider: ChannelStatus,
    hour: ChannelStatusHour,
  ): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const margin = 132
    setHovered({
      provider,
      hour,
      x: Math.min(Math.max(rect.left + rect.width / 2, margin), Math.max(window.innerWidth - margin, margin)),
      y: rect.top,
      below: rect.top < 170,
    })
  }

  const buckets = data?.hours ?? STATUS_HOURS
  const trackWidth = buckets * 4 + (buckets - 1)
  const showMiddleAxis = trackWidth >= 420
  const lastError = hovered?.provider.lastProbe?.error
  return (
    <section>
      <PageActions>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          loading={probing}
          onClick={() => { void runProbe() }}
        >
          立即探测
        </Button>
        <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
      </PageActions>
      {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
      {probeError !== undefined && <Alert type="error" showIcon title={probeError} className="page-alert" />}
      <Card
        className="page-card"
        title={(
          <Flex align="baseline" gap={12} wrap>
            <span>渠道状态</span>
            <Text type="secondary" className="status-card-sub">
              最近 7 天 · {caption}
            </Text>
          </Flex>
        )}
      >
        {loading && data === undefined && <Spinner label="加载中" />}
        {!loading && data !== undefined && data.data.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无渠道" />
        )}
        {data !== undefined && data.data.length > 0 && (
          <>
            <div className="status-toolbar">
              <Legend />
            </div>
            <div className="status-scroll">
              <div className="status-track" style={{ minWidth: `${trackWidth}px` }}>
                {data.data.map(provider => (
                  <StatusRow
                    key={provider.id}
                    provider={provider}
                    buckets={buckets}
                    onHover={showTooltip}
                    onLeave={() => setHovered(undefined)}
                  />
                ))}
                {axis !== undefined && (
                  <div className="status-axis" aria-hidden="true">
                    <span>{axis.start}</span>
                    {showMiddleAxis && <span>{axis.middle}</span>}
                    <span>{axis.end}</span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </Card>
      {hovered !== undefined && (
        <div
          className={`chart-tooltip${hovered.below ? ' below' : ''}`}
          style={{ left: hovered.x, top: hovered.y }}
          role="tooltip"
        >
          <span className="chart-tooltip-title">{hovered.provider.name}</span>
          <span className="chart-tooltip-row">
            <span>时间</span>
            <strong>{`${hovered.hour.hour.slice(5, 10)} ${hovered.hour.hour.slice(11)}`}</strong>
          </span>
          <span className="chart-tooltip-row">
            <span>状态</span>
            <strong>{LEVEL_LABEL[hovered.hour.status]}</strong>
          </span>
          {hovered.hour.latestTs !== null && (
            <span className="chart-tooltip-row">
              <span>最新一次</span>
              <strong>{formatClock(hovered.hour.latestTs)}</strong>
            </span>
          )}
          <span className="chart-tooltip-row">
            <span>探活</span>
            <strong>{hovered.hour.samples === 0 ? '—' : `${hovered.hour.samples} 次`}</strong>
          </span>
          <span className="chart-tooltip-row">
            <span>正常 / 波动 / 故障</span>
            <strong>{`${hovered.hour.up} / ${hovered.hour.degraded} / ${hovered.hour.down}`}</strong>
          </span>
          {hovered.provider.lastProbe !== null && (
            <span className="chart-tooltip-row">
              <span>最近耗时</span>
              <strong>{formatMs(hovered.provider.lastProbe.durationMs)}</strong>
            </span>
          )}
          {lastError !== undefined && (
            <span className="chart-tooltip-error">{lastError}</span>
          )}
        </div>
      )}
    </section>
  )
}
