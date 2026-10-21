/**
 * 渠道配置编辑器。
 *
 * 配置与模型范围拆成两个页签，保存动作固定在底部。模型范围使用
 * “全部模型 / 指定模型”明确表达，避免空数组与全选之间的歧义。
 */

import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import {
  CheckCircleOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import { api, type Provider } from '../api.ts'
import {
  OFFICIAL_PRESETS,
  TYPE_DEFAULT,
  TYPE_HINT,
  TYPE_LABEL,
} from '../constants/providers.ts'
import { ChatgptLoginPanel } from './ChatgptLoginPanel.tsx'
import { Field } from './common.tsx'
import { ProviderToggle } from './ProviderToggle.tsx'

const { Text } = Typography

type EditorTab = 'connection' | 'models'
type ModelMode = 'all' | 'custom'

/** 判断渠道是否需要填写 Base URL 和 API Key。 */
function usesEndpoint(type: Provider['type']): boolean {
  return type === 'openai'
    || type === 'anthropic'
    || type === 'gemini'
    || type === 'ollama'
}

/** 判断渠道是否通过浏览器 OAuth 建立连接。 */
function usesBrowserLogin(type: Provider['type']): boolean {
  return type === 'chatgpt-oauth'
}

export function ChannelEditor({
  initial,
  onCancel,
  onSaved,
  onChanged,
}: {
  initial?: Provider
  onCancel: () => void
  onSaved: (provider: Provider) => void
  onChanged?: () => void
}) {
  const isEdit = initial !== undefined
  const template = TYPE_DEFAULT[initial?.type ?? 'openai']
  const [tab, setTab] = useState<EditorTab>('connection')
  const [id, setId] = useState(initial?.id ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<Provider['type']>(initial?.type ?? 'openai')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? template.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 120000)
  const [presetId, setPresetId] = useState<string | undefined>(undefined)
  const [modelMode, setModelMode] = useState<ModelMode>(
    initial !== undefined && initial.models.length > 0 ? 'custom' : 'all',
  )
  const [selected, setSelected] = useState<string[]>(initial?.models ?? [])
  const [discovered, setDiscovered] = useState<string[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [success, setSuccess] = useState<string | undefined>(undefined)
  const autoLoaded = useRef(false)

  const needsKey = TYPE_DEFAULT[type].needsKey
  const endpointVisible = usesEndpoint(type)
  const browserLoginVisible = usesBrowserLogin(type)
  const models = discovered.length > 0 ? discovered : template.models
  const selectedUnavailable = [...new Set(selected.filter(model => !models.includes(model)))]
  const modelOptions = [...models, ...selectedUnavailable]
  const filteredModels = modelOptions.filter(model =>
    modelSearch.trim() === '' || model.toLowerCase().includes(modelSearch.trim().toLowerCase()))
  const selectedCount = modelMode === 'all' ? modelOptions.length : selected.length

  const validateConnection = (): string | undefined => {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id)) {
      return '渠道 ID 仅允许小写字母、数字和连字符（1-32 位）'
    }
    if (name.trim() === '') return '请填写渠道名称'
    if (endpointVisible) {
      if (baseUrl.trim() === '') return '请填写 Base URL'
      if (!/^https?:\/\//.test(baseUrl.trim())) return 'Base URL 需要以 http:// 或 https:// 开头'
      if (needsKey && apiKey.trim() === '' && !(isEdit && initial?.apiKeySet)) return '请填写 API Key'
    }
    return undefined
  }

  const validate = (): string | undefined => {
    const connectionError = validateConnection()
    if (connectionError !== undefined) return connectionError
    if (modelMode === 'custom' && selected.length === 0) {
      return '指定模型模式下至少需要选择一个模型，或切换为全部模型'
    }
    return undefined
  }

  const requestBody = (): Parameters<typeof api.saveProvider>[0] => ({
    id,
    name: name.trim(),
    type,
    enabled,
    ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
    timeoutMs,
    models: modelMode === 'all' ? [] : selected,
    ...(initial === undefined
      ? {}
      : {
          extraHeaders: initial.extraHeaders,
          settings: initial.settings,
        }),
  })

  const loadModels = async (): Promise<void> => {
    setError(undefined)
    setSuccess(undefined)
    const invalid = validateConnection()
    if (invalid !== undefined) {
      setError(invalid)
      return
    }
    setTesting(true)
    try {
      const result = await api.testProvider(requestBody())
      setDiscovered(result.models)
      setSuccess(`连接成功，发现 ${result.count} 个模型`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setTesting(false)
    }
  }

  useEffect(() => {
    if (initial === undefined || autoLoaded.current) return
    autoLoaded.current = true
    if (usesBrowserLogin(initial.type)) return
    void loadModels()
  }, [initial])

  const changeType = (next: Provider['type']): void => {
    const nextTemplate = TYPE_DEFAULT[next]
    setType(next)
    if (!isEdit) setBaseUrl(nextTemplate.baseUrl)
    setApiKey('')
    setDiscovered([])
    setSelected([])
    setModelMode('all')
    setSuccess(undefined)
    setError(undefined)
  }

  const applyPreset = (nextId: string): void => {
    const preset = OFFICIAL_PRESETS.find(item => item.id === nextId)
    if (preset === undefined) return
    setPresetId(preset.id)
    setId(preset.id)
    setName(preset.name)
    setType(preset.type)
    setBaseUrl(preset.baseUrl)
    setApiKey('')
    setDiscovered([])
    setSelected([])
    setModelMode('all')
    setError(undefined)
    setSuccess(undefined)
  }

  const switchModelMode = (next: ModelMode): void => {
    setModelMode(next)
    if (next === 'custom' && selected.length === 0) setSelected(modelOptions)
    setError(undefined)
  }

  const submit = async (): Promise<void> => {
    setError(undefined)
    setSuccess(undefined)
    const invalid = validate()
    if (invalid !== undefined) {
      setError(invalid)
      return
    }
    setSaving(true)
    try {
      const result = await api.saveProvider(requestBody())
      onSaved(result.provider)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const connectionHint = browserLoginVisible
    ? '保存后通过官方浏览器授权建立连接。'
    : type === 'trae-cn' || type === 'trae-ai'
      ? '读取本机 Trae 桌面端登录态，不需要填写 API Key。'
      : TYPE_HINT[type]

  return (
    <Form layout="vertical" className="channel-editor" onFinish={() => { void submit() }}>
      <div className="channel-editor-tabs" role="tablist" aria-label="渠道配置区域">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'connection'}
          className={tab === 'connection' ? 'channel-editor-tab active' : 'channel-editor-tab'}
          onClick={() => setTab('connection')}
        >
          连接配置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'models'}
          className={tab === 'models' ? 'channel-editor-tab active' : 'channel-editor-tab'}
          onClick={() => setTab('models')}
        >
          模型范围
          <span className="channel-tab-count">{selectedCount}</span>
        </button>
      </div>

      <div className="channel-editor-canvas">
        {error !== undefined && <Alert type="error" showIcon title={error} />}
        {success !== undefined && <Alert type="success" showIcon title={success} />}

        {tab === 'connection' ? (
          <>
            {!isEdit && (
              <section className="channel-editor-section channel-preset-section">
                <div className="channel-section-heading">
                  <div>
                    <Text strong>从官方预设开始</Text>
                    <Text type="secondary">选择常用服务可自动填入地址和默认模型。</Text>
                  </div>
                  <Select
                    value={presetId}
                    placeholder="选择预设"
                    options={OFFICIAL_PRESETS.map(preset => ({
                      value: preset.id,
                      label: `${preset.name} · ${preset.hint}`,
                    }))}
                    onChange={applyPreset}
                    showSearch
                    optionFilterProp="label"
                    style={{ width: 300, maxWidth: '100%' }}
                  />
                </div>
              </section>
            )}

            <section className="channel-editor-section">
              <div className="channel-section-heading">
                <div>
                  <Text strong>基础信息</Text>
                  <Text type="secondary">渠道 ID 会成为模型名前缀，创建后不可修改。</Text>
                </div>
                <Tag bordered={false}>{TYPE_LABEL[type]}</Tag>
              </div>
              <div className="channel-form-grid">
                <Field label="渠道 ID" hint="保存后不可变更">
                  <Input
                    value={id}
                    onChange={event => setId(event.target.value.toLowerCase())}
                    placeholder="例如 deepseek"
                    disabled={isEdit}
                  />
                </Field>
                <Field label="显示名称">
                  <Input value={name} onChange={event => setName(event.target.value)} placeholder="例如 DeepSeek 官方" />
                </Field>
                <Field label="渠道类型">
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
                {!isEdit && (
                  <Field label="创建后状态">
                    <div className="channel-inline-control">
                      <ProviderToggle enabled={enabled} onChange={setEnabled} />
                      <Text type="secondary">{enabled ? '创建后立即参与转发' : '仅保存配置，稍后启用'}</Text>
                    </div>
                  </Field>
                )}
                {endpointVisible && (
                  <Field label="Base URL" hint={TYPE_HINT[type]}>
                    <Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://..." />
                  </Field>
                )}
                {endpointVisible && needsKey && (
                  <Field
                    label="API Key"
                    hint={isEdit && initial?.apiKeySet ? '已保存，留空保持不变' : '明文保存在本地数据库'}
                  >
                    <Input.Password
                      value={apiKey}
                      onChange={event => setApiKey(event.target.value)}
                      placeholder={isEdit && initial?.apiKeySet ? '已保存，留空保持不变' : 'sk-...'}
                      autoComplete="new-password"
                    />
                  </Field>
                )}
                <Field label="请求超时">
                  <InputNumber
                    min={1000}
                    step={1000}
                    value={timeoutMs}
                    onChange={value => setTimeoutMs(value ?? 120000)}
                    addonAfter="ms"
                    style={{ width: '100%' }}
                  />
                </Field>
              </div>
              <div className="channel-connection-note">
                <InfoCircleOutlined />
                <Text type="secondary">{connectionHint}</Text>
              </div>
              {endpointVisible && (
                <Flex gap={8} wrap="wrap">
                  <Button
                    htmlType="button"
                    icon={<SyncOutlined />}
                    onClick={() => { void loadModels() }}
                    loading={testing}
                    disabled={saving}
                  >
                    检测并获取模型
                  </Button>
                </Flex>
              )}
            </section>

            {browserLoginVisible && (
              <section className="channel-editor-section">
                <div className="channel-section-heading">
                  <div>
                    <Text strong>ChatGPT 订阅授权</Text>
                    <Text type="secondary">
                      {isEdit ? '连接状态可以单独刷新，不影响其他渠道。' : '先保存渠道，再在这里完成浏览器授权。'}
                    </Text>
                  </div>
                  <Tag color={isEdit ? 'processing' : 'default'} bordered={false}>
                    {isEdit ? '可配置' : '等待保存'}
                  </Tag>
                </div>
                {isEdit && type === 'chatgpt-oauth' && (
                  <ChatgptLoginPanel
                    providerId={initial.id}
                    onSignedIn={() => {
                      onChanged?.()
                      void loadModels()
                    }}
                  />
                )}
              </section>
            )}
          </>
        ) : (
          <section className="channel-editor-section channel-model-section">
            <div className="channel-section-heading">
              <div>
                <Text strong>开放哪些模型</Text>
                <Text type="secondary">控制客户端通过这个渠道可以访问的模型范围。</Text>
              </div>
              <Button
                htmlType="button"
                icon={<ReloadOutlined />}
                onClick={() => { void loadModels() }}
                loading={testing}
                disabled={saving}
              >
                刷新模型目录
              </Button>
            </div>

            <div className="channel-model-mode">
              <Segmented<ModelMode>
                value={modelMode}
                onChange={switchModelMode}
                options={[
                  { value: 'all', label: '全部模型' },
                  { value: 'custom', label: '指定模型' },
                ]}
              />
              <span className="channel-model-summary">
                {modelMode === 'all'
                  ? '当前渠道所有可用模型都会开放'
                  : `已选择 ${selected.length} / ${modelOptions.length} 个模型`}
              </span>
            </div>

            {modelMode === 'custom' && selectedUnavailable.length > 0 && (
              <Alert
                type="warning"
                showIcon
                title={`有 ${selectedUnavailable.length} 个已选模型不在当前目录中`}
                description="取消勾选并保存即可移除；保留时仍会尝试继续映射。"
              />
            )}

            {testing && modelOptions.length === 0 ? (
              <div className="channel-model-loading">
                <Spin />
                <Text type="secondary">正在获取模型目录</Text>
              </div>
            ) : modelOptions.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="尚未获取到模型目录"
              >
                <Button htmlType="button" icon={<SyncOutlined />} onClick={() => { void loadModels() }}>
                  立即获取
                </Button>
              </Empty>
            ) : (
              <>
                <div className="channel-model-toolbar">
                  <Input
                    allowClear
                    prefix={<SearchOutlined />}
                    value={modelSearch}
                    onChange={event => setModelSearch(event.target.value)}
                    placeholder="搜索模型 ID"
                  />
                  <Space size={4}>
                    <Button
                      htmlType="button"
                      type="link"
                      size="small"
                      disabled={modelMode === 'all'}
                      onClick={() => setSelected(current => [...new Set([...current, ...filteredModels])])}
                    >
                      全选结果
                    </Button>
                    <Button
                      htmlType="button"
                      type="link"
                      size="small"
                      disabled={modelMode === 'all'}
                      onClick={() => setSelected(current => current.filter(model => !filteredModels.includes(model)))}
                    >
                      取消结果
                    </Button>
                  </Space>
                </div>
                <div className="channel-model-list">
                  {filteredModels.map(model => {
                    const checked = modelMode === 'all' || selected.includes(model)
                    const unavailable = selectedUnavailable.includes(model)
                    return (
                      <label className="channel-model-row" key={model}>
                        <Checkbox
                          checked={checked}
                          disabled={modelMode === 'all'}
                          onChange={event => {
                            setSelected(current => event.target.checked
                              ? [...current, model]
                              : current.filter(item => item !== model))
                          }}
                        />
                        <span className="channel-model-id">{model}</span>
                        {unavailable && <Tag color="warning">不在当前目录</Tag>}
                      </label>
                    )
                  })}
                </div>
              </>
            )}
          </section>
        )}
      </div>

      <div className="channel-editor-footer">
        <span className="channel-save-state">
          <CheckCircleOutlined />
          {isEdit ? '修改保存后立即生效' : '创建后可在工作台中继续配置'}
        </span>
        <Space>
          <Button htmlType="button" onClick={onCancel} disabled={saving}>取消</Button>
          <Button type="primary" htmlType="submit" loading={saving} disabled={testing}>
            {isEdit ? '保存更改' : '创建渠道'}
          </Button>
        </Space>
      </div>
    </Form>
  )
}
