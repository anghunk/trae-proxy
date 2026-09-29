/** API Keys 管理页面。 */

import { useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Dropdown,
  Empty,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import { api, type ApiKey } from '../api.ts'
import { PageActions, Spinner } from '../components/common.tsx'
import { KeyEditorModal } from '../components/KeyEditorModal.tsx'
import { useAsync } from '../hooks/useAsync.ts'
import { formatDate } from '../utils/format.ts'

const { Text } = Typography

function permissionLabel(modelPrefixes: string[], modelIds: string[]): string {
  if (modelPrefixes.length === 0 && modelIds.length === 0) return '全部'
  if (modelIds.length > 0) return `${modelIds.length} 个模型`
  return `${modelPrefixes.length} 个渠道`
}

export function KeysPage() {
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
