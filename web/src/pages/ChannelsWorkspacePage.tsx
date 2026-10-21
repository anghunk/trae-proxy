/**
 * 渠道工作台。
 *
 * 左侧浏览与筛选渠道，右侧直接配置当前渠道，避免列表与详情之间反复跳转。
 * 窄屏下自动切换为「列表 → 详情」单栏流程。
 */

import { useEffect, useState, type CSSProperties } from 'react'
import {
  Alert,
  Button,
  Empty,
  Flex,
  Input,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ApiOutlined,
  ArrowLeftOutlined,
  DeleteOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg?url'
import deepSeekIcon from '@lobehub/icons-static-svg/icons/deepseek.svg?url'
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini.svg?url'
import kimiIcon from '@lobehub/icons-static-svg/icons/kimi.svg?url'
import llmApiIcon from '@lobehub/icons-static-svg/icons/llmapi.svg?url'
import ollamaIcon from '@lobehub/icons-static-svg/icons/ollama.svg?url'
import openAiIcon from '@lobehub/icons-static-svg/icons/openai.svg?url'
import openRouterIcon from '@lobehub/icons-static-svg/icons/openrouter.svg?url'
import qwenIcon from '@lobehub/icons-static-svg/icons/qwen.svg?url'
import siliconCloudIcon from '@lobehub/icons-static-svg/icons/siliconcloud.svg?url'
import traeIcon from '@lobehub/icons-static-svg/icons/trae.svg?url'
import zhipuIcon from '@lobehub/icons-static-svg/icons/zhipu.svg?url'
import { api, type Provider } from '../api.ts'
import { ChannelEditor } from '../components/ChannelEditor.tsx'
import { Spinner } from '../components/common.tsx'
import { ProviderToggle } from '../components/ProviderToggle.tsx'
import { providerEnabledPatch, TYPE_LABEL } from '../constants/providers.ts'
import { useAsync } from '../hooks/useAsync.ts'

const { Text } = Typography

type ChannelFilter = 'all' | 'enabled' | 'disabled'
type ProviderBrand =
  | 'trae'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'deepseek'
  | 'openrouter'
  | 'zhipu'
  | 'kimi'
  | 'qwen'
  | 'siliconcloud'
  | 'generic'

const BRAND_TONE: Record<ProviderBrand, string> = {
  trae: '#2563eb',
  openai: '#10a37f',
  anthropic: '#c15f3c',
  gemini: '#4285f4',
  ollama: '#4b5563',
  deepseek: '#4d6bfe',
  openrouter: '#7aa600',
  zhipu: '#3859ff',
  kimi: '#16191e',
  qwen: '#615ced',
  siliconcloud: '#6e29f6',
  generic: '#3f35ff',
}

const BRAND_ICON: Record<ProviderBrand, string> = {
  trae: traeIcon,
  openai: openAiIcon,
  anthropic: anthropicIcon,
  gemini: geminiIcon,
  ollama: ollamaIcon,
  deepseek: deepSeekIcon,
  openrouter: openRouterIcon,
  zhipu: zhipuIcon,
  kimi: kimiIcon,
  qwen: qwenIcon,
  siliconcloud: siliconCloudIcon,
  generic: llmApiIcon,
}

/**
 * 从渠道类型和身份信息推断实际 AI 品牌。
 *
 * `openai` 只是兼容协议，官方预设中的 DeepSeek、Kimi、Qwen 等也使用该
 * 类型，因此需要结合渠道 ID、名称与 Base URL 选择正确品牌图标。
 */
function providerBrand(provider?: Pick<Provider, 'type' | 'id' | 'name' | 'baseUrl'>, fallbackType?: Provider['type']): ProviderBrand {
  const type = provider?.type ?? fallbackType
  if (type === 'trae-cn' || type === 'trae-ai') return 'trae'
  if (type === 'anthropic') return 'anthropic'
  if (type === 'gemini') return 'gemini'
  if (type === 'ollama') return 'ollama'
  if (type === 'chatgpt-oauth') return 'openai'
  if (type !== 'openai') return 'generic'

  const identity = [
    provider?.id ?? '',
    provider?.name ?? '',
    provider?.baseUrl ?? '',
  ].join(' ').toLowerCase()
  if (identity.includes('deepseek')) return 'deepseek'
  if (identity.includes('openrouter')) return 'openrouter'
  if (identity.includes('zhipu') || identity.includes('bigmodel') || identity.includes('glm')) return 'zhipu'
  if (identity.includes('kimi') || identity.includes('moonshot')) return 'kimi'
  if (identity.includes('qwen') || identity.includes('dashscope') || identity.includes('alibaba')) return 'qwen'
  if (identity.includes('siliconflow')) return 'siliconcloud'
  return identity.includes('openai') || identity.trim() === '' ? 'openai' : 'generic'
}

function ProviderGlyph({ provider, type, size = 'normal' }: {
  provider?: Pick<Provider, 'type' | 'id' | 'name' | 'baseUrl'>
  type?: Provider['type']
  size?: 'normal' | 'large'
}) {
  const brand = providerBrand(provider, type)
  const style = {
    '--provider-tone': BRAND_TONE[brand],
    '--provider-icon': `url("${BRAND_ICON[brand]}")`,
  } as CSSProperties
  return (
    <span className={`channel-provider-glyph ${size}`} style={style}>
      <span className="channel-provider-icon" aria-hidden="true" />
    </span>
  )
}

function modelCount(provider: Provider): string {
  if (provider.modelCount !== undefined && provider.modelCount > 0) {
    return provider.models.length > 0
      ? `${provider.modelCount} 个可用 · 限制 ${provider.models.length} 个`
      : `${provider.modelCount} 个可用`
  }
  return provider.models.length > 0 ? `限制 ${provider.models.length} 个` : '动态目录'
}

export function ChannelsWorkspacePage({
  selectedId,
  onSelect,
  onClear,
}: {
  selectedId?: string
  onSelect: (id: string) => void
  onClear: () => void
}) {
  const { data, error, loading, reload } = useAsync(() => api.providers(), [])
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ChannelFilter>('all')
  const [mobileDetail, setMobileDetail] = useState(selectedId !== undefined)
  const [toggling, setToggling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)

  const providers = data?.data ?? []
  const selected = selectedId === undefined ? undefined : providers.find(provider => provider.id === selectedId)
  const enabledCount = providers.filter(provider => provider.enabled).length
  const totalModels = providers.reduce((sum, provider) =>
    sum + Math.max(provider.modelCount ?? 0, provider.models.length), 0)
  const normalizedSearch = search.trim().toLowerCase()
  const filtered = providers.filter(provider => {
    if (filter === 'enabled' && !provider.enabled) return false
    if (filter === 'disabled' && provider.enabled) return false
    if (normalizedSearch === '') return true
    return [
      provider.name,
      provider.id,
      TYPE_LABEL[provider.type],
    ].some(value => value.toLowerCase().includes(normalizedSearch))
  })

  useEffect(() => {
    if (selectedId !== undefined) {
      setCreating(false)
      setMobileDetail(true)
    }
  }, [selectedId])

  const selectProvider = (id: string): void => {
    setActionError(undefined)
    setCreating(false)
    setMobileDetail(true)
    onSelect(id)
  }

  const startCreating = (): void => {
    setActionError(undefined)
    setCreating(true)
    setMobileDetail(true)
  }

  const closeCreate = (): void => {
    setCreating(false)
    setMobileDetail(false)
    onClear()
  }

  const saved = (provider: Provider): void => {
    setCreating(false)
    setMobileDetail(true)
    reload()
    onSelect(provider.id)
  }

  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (selected === undefined) return
    setActionError(undefined)
    setToggling(true)
    try {
      await api.saveProvider(providerEnabledPatch(selected, enabled))
      reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setToggling(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (selected === undefined) return
    setActionError(undefined)
    setDeleting(true)
    try {
      await api.deleteProvider(selected.id)
      reload()
      setMobileDetail(false)
      onClear()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeleting(false)
    }
  }

  const detailVisible = creating || selected !== undefined

  return (
    <section className="channel-workspace">
      <div className="channel-workspace-command">
        <div>
          <Text strong>统一管理连接方式、授权与模型范围</Text>
          <Text type="secondary">选择左侧渠道即可直接编辑，保存后立即生效。</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={startCreating}>
          新建渠道
        </Button>
      </div>

      <div className="channel-workspace-stats">
        <span><strong>{providers.length}</strong> 个渠道</span>
        <span><i className="status-dot online" />{enabledCount} 个已启用</span>
        <span><strong>{totalModels}</strong> 个可用模型</span>
      </div>

      <div className={`channel-workspace-body ${mobileDetail ? 'show-detail' : 'show-list'}`}>
        <aside className="channel-directory" aria-label="渠道列表">
          <div className="channel-directory-tools">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="搜索名称、ID 或类型"
            />
            <div className="channel-filter-row">
              {([
                ['all', '全部'],
                ['enabled', '已启用'],
                ['disabled', '已停用'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? 'channel-filter active' : 'channel-filter'}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
              <span className="channel-filter-count">{filtered.length}</span>
            </div>
          </div>

          <div className="channel-directory-list">
            {loading && providers.length === 0 && <Spinner label="加载渠道" />}
            {!loading && filtered.length === 0 && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={providers.length === 0 ? '还没有渠道' : '没有匹配的渠道'}
              >
                {providers.length === 0 && (
                  <Button type="primary" icon={<PlusOutlined />} onClick={startCreating}>新建渠道</Button>
                )}
              </Empty>
            )}
            {filtered.map(provider => (
              <button
                type="button"
                key={provider.id}
                className={selectedId === provider.id && !creating ? 'channel-list-item active' : 'channel-list-item'}
                onClick={() => selectProvider(provider.id)}
              >
                <ProviderGlyph provider={provider} />
                <span className="channel-list-copy">
                  <span className="channel-list-name">{provider.name}</span>
                  <span className="channel-list-meta">{TYPE_LABEL[provider.type]} · {provider.id}</span>
                  <span className="channel-list-models">{modelCount(provider)}</span>
                </span>
                <span className={provider.enabled ? 'channel-state online' : 'channel-state'}>
                  <i />
                  {provider.enabled ? '启用' : '停用'}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="channel-workbench-detail">
          <div className="channel-mobile-back">
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={() => {
                setCreating(false)
                setMobileDetail(false)
                if (selectedId !== undefined) onClear()
              }}
            >
              返回渠道列表
            </Button>
          </div>

          {error !== undefined && <Alert type="error" showIcon title={error} className="channel-detail-alert" />}
          {actionError !== undefined && <Alert type="error" showIcon title={actionError} className="channel-detail-alert" />}
          {loading && providers.length === 0 && <Spinner label="加载渠道详情" />}

          {creating && (
            <div className="channel-detail-frame">
              <header className="channel-detail-heading">
                <div className="channel-detail-identity">
                  <span className="channel-create-glyph"><PlusOutlined /></span>
                  <div>
                    <h2>新建渠道</h2>
                    <Text type="secondary">配置连接信息并选择要开放的模型。</Text>
                  </div>
                </div>
              </header>
              <ChannelEditor
                onCancel={closeCreate}
                onSaved={saved}
              />
            </div>
          )}

          {!creating && selected !== undefined && (
            <div className="channel-detail-frame">
              <header className="channel-detail-heading">
                <div className="channel-detail-identity">
                  <ProviderGlyph provider={selected} size="large" />
                  <div>
                    <Flex align="center" gap={8} wrap="wrap">
                      <h2>{selected.name}</h2>
                      <Tag bordered={false}>{TYPE_LABEL[selected.type]}</Tag>
                    </Flex>
                    <Text type="secondary" code>{selected.id}</Text>
                  </div>
                </div>
                <Space wrap>
                  <Tooltip title="停用后不参与模型转发">
                    <span className="channel-status-control">
                      <ProviderToggle
                        enabled={selected.enabled}
                        disabled={toggling || deleting}
                        confirm
                        confirmDescription={selected.enabled
                          ? `停用后「${selected.name}」将不再参与模型转发。`
                          : `启用后「${selected.name}」将重新参与模型转发。`}
                        onChange={next => { void setEnabled(next) }}
                      />
                      <Text type="secondary">{selected.enabled ? '已启用' : '已停用'}</Text>
                    </span>
                  </Tooltip>
                  <Popconfirm
                    title="删除渠道"
                    description={`确定删除「${selected.name}」？此操作不可撤销。`}
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => { void remove() }}
                  >
                    <Button danger type="text" icon={<DeleteOutlined />} loading={deleting}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              </header>
              <ChannelEditor
                key={`${selected.id}:${selected.updatedAt}`}
                initial={selected}
                onCancel={() => onClear()}
                onChanged={reload}
                onSaved={saved}
              />
            </div>
          )}

          {!creating && selectedId === undefined && selected === undefined && !loading && providers.length > 0 && (
            <div className="channel-detail-empty">
              <ApiOutlined />
              <h3>选择一个渠道开始配置</h3>
              <Text type="secondary">连接信息、登录授权和模型范围会在这里集中显示。</Text>
            </div>
          )}

          {!creating && selected === undefined && !loading && providers.length === 0 && (
            <div className="channel-detail-empty">
              <ApiOutlined />
              <h3>创建第一个渠道</h3>
              <Text type="secondary">接入 Trae、OpenAI、Anthropic、Gemini 或本地模型。</Text>
              <Button type="primary" icon={<PlusOutlined />} onClick={startCreating}>新建渠道</Button>
            </div>
          )}

          {!creating && selectedId !== undefined && selected === undefined && !loading && providers.length > 0 && (
            <div className="channel-detail-empty">
              <ApiOutlined />
              <h3>渠道不存在</h3>
              <Text type="secondary">它可能已经被删除，请从左侧重新选择。</Text>
              <Button onClick={onClear}>返回列表</Button>
            </div>
          )}

          {!detailVisible && providers.length === 0 && !loading && (
            <div className="channel-detail-empty">
              <ApiOutlined />
              <h3>还没有渠道</h3>
              <Text type="secondary">创建渠道后即可统一转发和切换模型。</Text>
              <Button type="primary" icon={<PlusOutlined />} onClick={startCreating}>新建渠道</Button>
            </div>
          )}
        </main>
      </div>
    </section>
  )
}
