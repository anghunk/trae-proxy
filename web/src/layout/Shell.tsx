/** 登录后的管理台布局与路由分发。 */

import { useEffect, useState } from 'react'
import { Layout, Typography } from 'antd'
import { api } from '../api.ts'
import { useAsync } from '../hooks/useAsync.ts'
import { ChannelDetailPage } from '../pages/ChannelDetailPage.tsx'
import { ChannelsPage } from '../pages/ChannelsPage.tsx'
import { GatewaySettingsPage } from '../pages/GatewaySettingsPage.tsx'
import { KeysPage } from '../pages/KeysPage.tsx'
import { OverviewPage } from '../pages/OverviewPage.tsx'
import { PasswordSettingsPage } from '../pages/PasswordSettingsPage.tsx'
import { UsageLogsPage } from '../pages/UsageLogsPage.tsx'
import { UsagePage } from '../pages/UsagePage.tsx'
import { navigate, viewFromPath, type View } from '../routes.ts'
import type { Theme } from '../theme.ts'
import { Sidebar } from './Sidebar.tsx'

const { Title, Text } = Typography

export function Shell({ theme, onToggleTheme }: {
  theme: Theme
  onToggleTheme: () => void
}) {
  const [view, setView] = useState<View>(viewFromPath)
  const providers = useAsync(() => api.providers(), [])
  const dashboard = useAsync(() => api.dashboard(), [])
  const logout = async (): Promise<void> => {
    await api.logout()
    window.location.reload()
  }
  useEffect(() => {
    const onPopState = (): void => setView(viewFromPath())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const openDetail = (id: string): void => {
    navigate('provider-detail', id)
    setView('provider-detail')
  }
  const backToProviders = (): void => {
    navigate('providers')
    setView('providers')
  }
  const providerId = view === 'provider-detail'
    ? decodeURIComponent(window.location.pathname.slice('/providers/'.length).replace(/\/$/, ''))
    : undefined

  const topbarTitle = view === 'overview' ? '概览'
    : view === 'providers' ? '渠道'
    : view === 'keys' ? 'API Keys'
    : view === 'usage' ? '用量'
    : view === 'logs' ? '使用日志'
    : view === 'settings-password' ? '设置'
    : view === 'settings-gateway' ? '设置'
    : '渠道详情'
  const endpointUrl = `http://127.0.0.1:${window.location.port || '39310'}/v1`

  return (
    <Layout className="shell">
      <Sidebar
        view={view}
        onView={setView}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onLogout={() => { void logout() }}
      />
      <Layout>
        <Layout.Header className="topbar">
          <Title level={4} style={{ margin: 0 }}>{topbarTitle}</Title>
          <Text code>{endpointUrl}</Text>
        </Layout.Header>
        <Layout.Content className="content">
          {view === 'overview' && (
            <OverviewPage
              providers={providers.data?.data ?? []}
              dashboard={dashboard.data}
              onRefresh={() => {
                providers.reload()
                dashboard.reload()
              }}
            />
          )}
          {view === 'providers' && <ChannelsPage onOpenDetail={openDetail} />}
          {view === 'provider-detail' && providerId !== undefined && (
            <ChannelDetailPage id={providerId} onBack={backToProviders} onDeleted={backToProviders} />
          )}
          {view === 'keys' && <KeysPage />}
          {view === 'usage' && <UsagePage />}
          {view === 'logs' && <UsageLogsPage />}
          {view === 'settings-password' && <PasswordSettingsPage />}
          {view === 'settings-gateway' && <GatewaySettingsPage />}
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
