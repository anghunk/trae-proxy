/** 使用日志页面。 */

import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
  Select,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import dayjs from 'dayjs'
import { api, type UsageRow } from '../api.ts'
import { useAsync } from '../hooks/useAsync.ts'
import {
  formatDate,
  formatMs,
  formatNumber,
  formatToken,
  localDateBoundary,
} from '../utils/format.ts'

const { Text } = Typography

interface DateRange {
  from: string
  to: string
}

/** 独立展示最近用量事件，支持日期、密钥、模型、状态筛选与分页。 */
export function UsageLogsPage() {
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
  const { data, error, loading } = useAsync(
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
