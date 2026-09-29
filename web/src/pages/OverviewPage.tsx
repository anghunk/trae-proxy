/** 控制台概览页面。 */

import { useState } from 'react'
import {
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons'
import type { Dashboard, Provider } from '../api.ts'
import { TYPE_LABEL } from '../constants/providers.ts'
import { formatDate, formatNumber, formatToken } from '../utils/format.ts'

const { Text, Paragraph } = Typography

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

export function OverviewPage({ providers, dashboard, onRefresh }: {
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
