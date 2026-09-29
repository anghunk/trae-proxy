/** 渠道详情页面。 */

import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Flex, Popconfirm, Space, Tag, Typography } from 'antd'
import { DeleteOutlined, SyncOutlined } from '@ant-design/icons'
import { api } from '../api.ts'
import { ChannelForm } from '../components/ChannelForm.tsx'
import { PageActions, Spinner } from '../components/common.tsx'
import { ProviderToggle } from '../components/ProviderToggle.tsx'
import { providerEnabledPatch } from '../constants/providers.ts'
import { useAsync } from '../hooks/useAsync.ts'
import { navigate } from '../routes.ts'

const { Text } = Typography

export function ChannelDetailPage({ id, onBack, onDeleted }: {
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
