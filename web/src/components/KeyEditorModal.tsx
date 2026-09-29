/** API Key 新增与权限编辑弹窗。 */

import { useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
} from 'antd'
import { api, type ApiKey, type Provider } from '../api.ts'
import { Field, Spinner } from './common.tsx'

const { Text } = Typography

interface KeyDraft {
  name: string
  providers: string[]
  models: string[]
}

export function KeyEditorModal({
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
