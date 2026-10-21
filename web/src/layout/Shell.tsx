/** 登录后的管理台布局与路由分发。 */

import { useEffect, useState } from 'react'
import { Layout, Typography } from 'antd'
import { api } from '../api.ts'
import { useAsync } from '../hooks/useAsync.ts'
import { ChannelsWorkspacePage } from '../pages/ChannelsWorkspacePage.tsx'
import { GatewaySettingsPage } from '../pages/GatewaySettingsPage.tsx'
import { KeysPage } from '../pages/KeysPage.tsx'
import { OverviewPage } from '../pages/OverviewPage.tsx'
import { PasswordSettingsPage } from '../pages/PasswordSettingsPage.tsx'
import { StatusPage } from '../pages/StatusPage.tsx'
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
  const [route, setRoute] = useState<{ view: View; pathname: string }>(() => ({
    view: viewFromPath(),
    pathname: window.location.pathname,
  }))
  const view = route.view
  const providers = useAsync(() => api.providers(), [])
  const dashboard = useAsync(() => api.dashboard(), [])
  const logout = async (): Promise<void> => {
    await api.logout()
    window.location.reload()
  }
  useEffect(() => {
    const onPopState = (): void => {
      setRoute({ view: viewFromPath(), pathname: window.location.pathname })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const openDetail = (id: string): void => {
    navigate('provider-detail', id)
    setRoute({ view: 'provider-detail', pathname: window.location.pathname })
  }
  const showProviders = (): void => {
    navigate('providers')
    setRoute({ view: 'providers', pathname: window.location.pathname })
  }
  const providerId = view === 'provider-detail'
    ? decodeURIComponent(route.pathname.slice('/providers/'.length).replace(/\/$/, ''))
    : undefined

  const topbarTitle = view === 'overview' ? '概览'
    : view === 'providers' ? '渠道工作台'
    : view === 'status' ? '渠道状态'
    : view === 'keys' ? 'API Keys'
    : view === 'usage' ? '用量'
    : view === 'logs' ? '使用日志'
    : view === 'settings-password' ? '设置'
    : view === 'settings-gateway' ? '设置'
    : '渠道工作台'
  const endpointUrl = `http://127.0.0.1:${window.location.port || '39310'}/v1`

  return (
    <Layout className="shell">
      <Sidebar
        view={view}
        onView={next => {
          setRoute({ view: next, pathname: window.location.pathname })
        }}
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
          {(view === 'providers' || view === 'provider-detail') && (
            <ChannelsWorkspacePage
              selectedId={providerId}
              onSelect={openDetail}
              onClear={showProviders}
            />
          )}
          {view === 'status' && <StatusPage />}
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
