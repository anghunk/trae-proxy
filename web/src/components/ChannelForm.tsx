/** 渠道新增与编辑表单。 */

import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import { api, type Provider } from '../api.ts'
import {
  OFFICIAL_PRESETS,
  TYPE_DEFAULT,
  TYPE_HINT,
  TYPE_LABEL,
  type OfficialPreset,
} from '../constants/providers.ts'
import { Field } from './common.tsx'
import { ProviderToggle } from './ProviderToggle.tsx'

const { Text } = Typography

export function ChannelForm({
  initial,
  catalog,
  onCancel,
  onSaved,
}: {
  initial?: Provider
  catalog?: string[]
  onCancel: () => void
  onSaved: () => void
}) {
  const template = TYPE_DEFAULT[initial?.type ?? 'openai']
  const [id, setId] = useState(initial?.id ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<Provider['type']>(initial?.type ?? 'openai')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? template.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 120000)
  const [selected, setSelected] = useState<string[]>([])
  const [discovered, setDiscovered] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [success, setSuccess] = useState<string | undefined>(undefined)
  const [presetId, setPresetId] = useState<string | undefined>(undefined)

  const needsKey = TYPE_DEFAULT[type].needsKey
  const models = discovered.length > 0
    ? discovered
    : catalog !== undefined ? catalog : template.models
  const selectedUnavailable = [...new Set(selected.filter(model => !models.includes(model)))]
  const modelOptions = [...models, ...selectedUnavailable]

  const isEdit = initial !== undefined

  useEffect(() => {
    if (initial === undefined) return
    setSelected(initial.models)
    if (initial.models.length === 0 && catalog === undefined) {
      api.refreshProvider(initial.id)
        .then(result => setDiscovered(result.models))
        .catch(() => setDiscovered([]))
    }
  }, [initial])

  useEffect(() => {
    if (catalog !== undefined && catalog.length > 0) setDiscovered(catalog)
  }, [catalog])

  const changeType = (next: Provider['type']): void => {
    setType(next)
    const nextTemplate = TYPE_DEFAULT[next]
    if (isEdit || baseUrl === template.baseUrl || baseUrl === '') setBaseUrl(nextTemplate.baseUrl)
    setApiKey('')
    setSelected([])
    setDiscovered([])
    setSuccess(undefined)
  }

  const applyPreset = (preset: OfficialPreset): void => {
    setPresetId(preset.id)
    setId(preset.id)
    setName(preset.name)
    setType(preset.type)
    setBaseUrl(preset.baseUrl)
    setApiKey('')
    setSelected([])
    setDiscovered([])
    setSuccess(undefined)
    setError(undefined)
  }

  const validate = (): string | undefined => {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id)) return '渠道 ID 仅允许小写字母、数字和连字符（1-32 位）'
    if (name.trim() === '') return '请填写渠道名称'
    if (type !== 'trae-cn' && type !== 'trae-ai') {
      if (baseUrl.trim() === '') return '请填写 Base URL'
      if (!/^https?:\/\//.test(baseUrl.trim())) return 'Base URL 需要以 http:// 或 https:// 开头'
      if (needsKey && apiKey.trim() === '' && !(isEdit && initial?.apiKeySet)) return '请填写 API Key'
    }
    return undefined
  }

  const testConnection = async (): Promise<void> => {
    setError(undefined)
    setSuccess(undefined)
    const invalid = validate()
    if (invalid !== undefined) {
      setError(invalid)
      return
    }
    setTesting(true)
    try {
      const result = await api.testProvider({
        id,
        name: name.trim(),
        type,
        enabled,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
        timeoutMs,
      })
      setDiscovered(result.models)
      setSuccess(`连接成功，发现 ${result.models.length} 个模型`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setTesting(false)
    }
  }

  const submit = async (): Promise<void> => {
    setError(undefined)
    setSuccess(undefined)
    const invalid = validate()
    if (invalid !== undefined) {
      setError(invalid)
      return
    }
    setBusy(true)
    try {
      await api.saveProvider({
        id,
        name: name.trim(),
        type,
        enabled,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
        timeoutMs,
        models: selected,
      })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="page-card page-form-card">
      <Form layout="vertical" onFinish={() => { void submit() }}>
        {!isEdit && (
          <div className="form-section">
            <Flex justify="space-between" gap={12} wrap="wrap" style={{ marginBottom: 12 }}>
              <Text strong>官方渠道</Text>
              <Text type="secondary">点击后自动填充渠道信息</Text>
            </Flex>
            <Row gutter={[12, 12]}>
              {OFFICIAL_PRESETS.map(preset => (
                <Col xs={24} sm={12} lg={8} xl={6} key={preset.id}>
                  <Card
                    size="small"
                    hoverable
                    className={presetId === preset.id ? 'preset-selected' : ''}
                    onClick={() => applyPreset(preset)}
                  >
                    <Space orientation="vertical" size={2}>
                      <Text strong>{preset.name}</Text>
                      <Text type="secondary">{preset.hint}</Text>
                    </Space>
                  </Card>
                </Col>
              ))}
            </Row>
          </div>
        )}
        <Row gutter={[24, 16]}>
          <Col xs={24} xl={14}>
            <Row gutter={16}>
              <Col xs={24} md={12}>
              <Field label="渠道 ID" hint="作为模型前缀，保存后不可变更">
                <Input
                  value={id}
                  onChange={event => setId(event.target.value.toLowerCase())}
                  placeholder="如 deepseek"
                  disabled={isEdit}
                />
              </Field>
              </Col>
              <Col xs={24} md={12}>
              <Field label="名称">
                <Input value={name} onChange={event => setName(event.target.value)} placeholder="如 DeepSeek 官方" />
              </Field>
              </Col>
              <Col xs={24} md={12}>
              <Field label="类型">
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
              </Col>
              <Col xs={24} md={12}>
              <Field label="状态">
                <ProviderToggle enabled={enabled} onChange={setEnabled} />
              </Field>
              </Col>
              {(type === 'openai' || type === 'anthropic' || type === 'gemini' || type === 'ollama') && (
                <>
                  <Col xs={24} md={12}>
                    <Field label="Base URL" hint={TYPE_HINT[type]}>
                      <Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://..." />
                    </Field>
                  </Col>
                  <Col xs={24} md={12}>
                    <Field label="API Key" hint={isEdit && initial?.apiKeySet ? '已保存，留空保持不变' : '明文保存在本地数据库'}>
                      <Input.Password
                        value={apiKey}
                        onChange={event => setApiKey(event.target.value)}
                        placeholder={isEdit && initial?.apiKeySet ? '••••••••' : 'sk-...'}
                        autoComplete="new-password"
                      />
                    </Field>
                  </Col>
                </>
              )}
              <Col xs={24} md={12}>
              <Field label="超时 (ms)">
                <InputNumber
                  min={1000}
                  step={1000}
                  value={timeoutMs}
                  onChange={value => setTimeoutMs(value ?? 120000)}
                  style={{ width: '100%' }}
                />
              </Field>
              </Col>
            </Row>
            <Space wrap>
              <Button
                htmlType="button"
                icon={<SyncOutlined />}
                onClick={() => { void testConnection() }}
                disabled={testing || busy}
                loading={testing}
              >
                获取全部模型
              </Button>
              <Button type="primary" htmlType="submit" loading={busy} disabled={testing}>保存并生效</Button>
              <Button htmlType="button" onClick={onCancel}>取消</Button>
            </Space>
          </Col>
          <Col xs={24} xl={10}>
            <Divider titlePlacement="start" style={{ marginTop: 0 }}>模型映射</Divider>
            <Flex justify="space-between" gap={12} wrap="wrap" style={{ marginBottom: 8 }}>
              <Text type="secondary">留空表示映射该渠道全部模型</Text>
              <Text type="secondary">
                {modelOptions.length === 0
                  ? '点击获取全部模型'
                  : selected.length === 0
                    ? '全部'
                    : selectedUnavailable.length > 0
                      ? `映射 ${selected.length} 个（含 ${selectedUnavailable.length} 个不在目录）`
                      : `映射 ${selected.length} / ${models.length}`}
              </Text>
            </Flex>
            {modelOptions.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="点击「获取全部模型」查看并选择要映射的模型"
              />
            ) : (
              <>
                {models.length > 0 && (
                  <Space size={8} style={{ marginBottom: 8 }}>
                    <Button htmlType="button" type="link" size="small" onClick={() => setSelected(models)}>全选</Button>
                    <Button htmlType="button" type="link" size="small" onClick={() => setSelected([])}>清空</Button>
                  </Space>
                )}
                {selectedUnavailable.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    title={`有 ${selectedUnavailable.length} 个已选模型不在当前目录，取消勾选并保存即可移除。`}
                    style={{ marginBottom: 12 }}
                  />
                )}
                <Flex vertical gap={6} className="model-checklist">
                  {modelOptions.map(model => {
                    const checked = selected.includes(model)
                    const unavailable = selectedUnavailable.includes(model)
                    return (
                      <Checkbox
                        key={model}
                        checked={checked}
                        onChange={event => {
                          setSelected(current => event.target.checked
                              ? [...current, model]
                              : current.filter(item => item !== model))
                        }}
                      >
                        <Space>
                          <Text code>{model}</Text>
                          {unavailable && <Tag color="warning">不在当前目录</Tag>}
                        </Space>
                      </Checkbox>
                    )
                  })}
                </Flex>
              </>
            )}
          </Col>
        </Row>
        {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
        {success !== undefined && <Alert type="success" showIcon title={success} className="page-alert" />}
      </Form>
    </Card>
  )
}
