/** 用量图表组件。 */

import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Card } from 'antd'
import { formatAxisToken, formatNumber, formatToken, niceAxisStep } from '../utils/format.ts'

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
export function ContributionWall({ days }: { days: ContributionDay[] }) {
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

interface UsageTrendItem {
  id: string
  label: string
  detail: string
  requests: number
  success: number
  totalTokens: number
}

interface HoveredTrendPoint {
  id: string
  item: UsageTrendItem
  x: number
  y: number
  below: boolean
}

const TREND_WIDTH = 1000
const TREND_HEIGHT = 220

/** 用三次贝塞尔曲线连接数据点，避免折线图出现生硬尖角。 */
function smoothSegments(points: Array<{ x: number; y: number }>): string {
  let path = ''
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index]
    const current = points[index]
    const next = points[index + 1]
    const afterNext = points[index + 2] ?? next
    const cp1x = current.x + (next.x - previous.x) / 6
    const cp1y = Math.min(TREND_HEIGHT, Math.max(0, current.y + (next.y - previous.y) / 6))
    const cp2x = next.x - (afterNext.x - current.x) / 6
    const cp2y = Math.min(TREND_HEIGHT, Math.max(0, next.y - (afterNext.y - current.y) / 6))
    path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`
  }
  return path
}

/**
 * 用量趋势图：用单色面积和折线展示 Token 走势，悬停时展示完整明细。
 *
 * groupSize 大于 1 时，相邻柱会合并成一格展示；同一格内的用量会求和，
 * 标签只取该组第一条记录，明细则用「起止时间」表示，便于一格容纳两个
 * 小时而不出现横向滚动条。
 */
export function UsageTrendChart({ items, groupSize = 1 }: {
  items: UsageTrendItem[]
  groupSize?: number
}) {
  const groups = useMemo<UsageTrendItem[]>(() => {
    if (groupSize <= 1) return items
    const result: UsageTrendItem[] = []
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
  const axisTicks = axisMax > 0
    ? Array.from({ length: axisMax / axisStep + 1 }, (_, index) => axisMax - index * axisStep)
    : [0]
  const points = useMemo(() => groups.map((item, index) => ({
    x: groups.length <= 1 ? TREND_WIDTH / 2 : (index / (groups.length - 1)) * TREND_WIDTH,
    y: TREND_HEIGHT - (axisMax <= 0 ? 0 : (item.totalTokens / axisMax) * TREND_HEIGHT),
    item,
    index,
  })), [axisMax, groups])
  const segments = smoothSegments(points)
  const linePath = points.length === 0
    ? ''
    : `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}${segments}`
  const areaPath = points.length === 0
    ? ''
    : `M ${points[0].x.toFixed(2)} ${TREND_HEIGHT} L ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}${segments} L ${points[points.length - 1].x.toFixed(2)} ${TREND_HEIGHT} Z`
  const dense = groups.length > 14
  const labelEvery = Math.max(1, Math.ceil(groups.length / 8))
  const [hovered, setHovered] = useState<HoveredTrendPoint | undefined>(undefined)

  const showTooltip = (event: ReactMouseEvent<HTMLDivElement>, point: (typeof points)[number]): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const markerY = rect.top + (point.y / TREND_HEIGHT) * rect.height
    const margin = 112
    setHovered({
      id: point.item.id,
      item: point.item,
      x: Math.min(Math.max(centerX, margin), window.innerWidth - margin),
      y: markerY,
      below: point.y < 64,
    })
  }

  return (
    <>
      <div className="trend-scroll" onScroll={() => setHovered(undefined)}>
        <div
          className={`trend-chart${dense ? ' dense' : ''}`}
          aria-label={`Token 用量趋势，共 ${groups.length} 个时间点`}
        >
          <div className="trend-y-axis" aria-hidden="true">
            {axisTicks.map(value => (
              <span key={value}>{formatAxisToken(value)}</span>
            ))}
          </div>
          <div className="trend-main">
            <div className="trend-plot">
              <svg viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                {axisTicks.map((_value, index) => {
                  const y = axisTicks.length <= 1 ? TREND_HEIGHT : (index / (axisTicks.length - 1)) * TREND_HEIGHT
                  return <line key={`grid-${index}`} className="trend-grid-line" x1="0" x2={TREND_WIDTH} y1={y} y2={y} />
                })}
                {areaPath !== '' && <path className="trend-area" d={areaPath} />}
                {linePath !== '' && <path className="trend-line" d={linePath} vectorEffect="non-scaling-stroke" />}
              </svg>
              {points.map(point => {
                const top = (point.y / TREND_HEIGHT) * 100
                return (
                  <div
                    key={point.item.id}
                    className="trend-hit"
                    style={{
                      left: `${groups.length <= 1 ? 50 : (point.index / (groups.length - 1)) * 100}%`,
                      width: `${100 / Math.max(groups.length, 1)}%`,
                    }}
                    onMouseEnter={event => showTooltip(event, point)}
                    onMouseLeave={() => setHovered(undefined)}
                  >
                    <span className="trend-marker" style={{ top: `${top}%` }} />
                  </div>
                )
              })}
            </div>
            <div className="trend-x-axis" aria-hidden="true">
              {groups.map((item, index) => (
                <span
                  key={item.id}
                  style={{
                    left: `${groups.length <= 1 ? 50 : (index / (groups.length - 1)) * 100}%`,
                    visibility: index % labelEvery === 0 || index === groups.length - 1 ? 'visible' : 'hidden',
                  }}
                >
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      {hovered !== undefined && (() => {
        const successRate = hovered.item.requests === 0
          ? '-'
          : `${((hovered.item.success / hovered.item.requests) * 100).toFixed(1)}%`
        return (
          <div
            className={`trend-tooltip${hovered.below ? ' below' : ''}`}
            role="tooltip"
            style={{ left: `${hovered.x}px`, top: `${hovered.y}px` }}
          >
            <span className="trend-tooltip-title">{hovered.item.detail}</span>
            <span className="trend-tooltip-row"><span>请求</span><strong>{formatNumber(hovered.item.requests)}</strong></span>
            <span className="trend-tooltip-row"><span>成功率</span><strong>{successRate}</strong></span>
            <span className="trend-tooltip-row"><span>Token</span><strong>{formatToken(hovered.item.totalTokens)}</strong></span>
          </div>
        )
      })()}
    </>
  )
}
