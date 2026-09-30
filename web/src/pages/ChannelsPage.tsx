/** 渠道模型列表页面。 */

import { useState } from 'react'
import { Alert, Button, Card, Empty, Popconfirm, Space, Table, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { api, type Provider } from '../api.ts'
import { ChannelForm } from '../components/ChannelForm.tsx'
import { PageActions, Spinner } from '../components/common.tsx'
import { ProviderToggle } from '../components/ProviderToggle.tsx'
import { providerEnabledPatch, TYPE_LABEL } from '../constants/providers.ts'
import { useAsync } from '../hooks/useAsync.ts'

const { Text } = Typography

export function ChannelsPage({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
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
          confirm
          confirmDescription={enabled
            ? `停用后「${provider.name}」将不再参与模型转发。`
            : `启用后「${provider.name}」将重新参与模型转发。`}
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
