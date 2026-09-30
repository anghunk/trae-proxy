/** 用量统计页面。 */

import { useMemo, useState } from 'react'
import {
  Alert,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Spin,
  Statistic,
  Table,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { api } from '../api.ts'
import { ContributionWall, UsageTrendChart } from '../components/Charts.tsx'
import { PageActions, Spinner } from '../components/common.tsx'
import { useAsync } from '../hooks/useAsync.ts'
import { formatMs, formatNumber, formatToken } from '../utils/format.ts'

const { Text } = Typography

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

export function UsagePage() {
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
    <>
      <TodayUsageCard />
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
        {loading && data === undefined && <Spinner label="加载中" />}
        {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
        {data !== undefined && (
          <Spin spinning={loading} tip="更新中">
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
            <Card className="page-card chart-card" title="按天" extra={<span className="chart-caption">Token 趋势</span>}>
              {data.byDay.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
              ) : (
                <UsageTrendChart
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
            <Card className="page-card chart-card" title="按小时" extra={<span className="chart-caption">最近 24 小时</span>}>
              {data.byHour.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
              ) : (
                <UsageTrendChart
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
          </Spin>
        )}
      </section>
    </>
  )
}
