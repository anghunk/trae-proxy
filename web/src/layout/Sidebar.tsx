/** 管理台侧边导航。 */

import { useEffect, useState } from 'react'
import { Button, Layout, Menu, Modal, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import {
  ApiOutlined,
  BarChartOutlined,
  DashboardOutlined,
  FileTextOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { ThemeToggle } from '../components/common.tsx'
import { navigate, SETTING_VIEWS, type View } from '../routes.ts'
import type { Theme } from '../theme.ts'

export function Sidebar({ view, onView, onLogout, theme, onToggleTheme }: {
  view: View
  onView: (view: View) => void
  onLogout: () => void
  theme: Theme
  onToggleTheme: () => void
}) {
  const [modal, modalContextHolder] = Modal.useModal()
  const settingsActive = view === 'settings-password' || view === 'settings-gateway'
  const [openKeys, setOpenKeys] = useState<string[]>(settingsActive ? ['settings'] : [])
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    if (!settingsActive) return
    setOpenKeys(current => current.includes('settings') ? current : ['settings'])
  }, [settingsActive])
  const selectedKey = view === 'provider-detail' ? 'providers' : view
  const menuItems: MenuProps['items'] = [
    { key: 'overview', icon: <DashboardOutlined />, label: '控制台' },
    { key: 'providers', icon: <ApiOutlined />, label: '渠道模型' },
    { key: 'keys', icon: <KeyOutlined />, label: 'API Keys' },
    { key: 'usage', icon: <BarChartOutlined />, label: '用量统计' },
    { key: 'logs', icon: <FileTextOutlined />, label: '使用日志' },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '系统设置',
      children: SETTING_VIEWS.map(item => ({ key: item.id, label: item.label })),
    },
  ]
  return (
    <Layout.Sider
      width={220}
      className="sidebar"
      breakpoint="lg"
      collapsedWidth={64}
      collapsed={collapsed}
      collapsible
      trigger={null}
      onCollapse={setCollapsed}
    >
      <div className="sidebar-brand">
        <img className="brand-mark" src="/logo.png" alt="Trae Proxy" />
        <div className="brand-text">
          <div className="brand-name">Trae Proxy</div>
          <div className="brand-sub">统一模型网关</div>
        </div>
      </div>
      <Menu
        mode="inline"
        inlineIndent={0}
        selectedKeys={[settingsActive ? view : selectedKey]}
        items={menuItems}
        openKeys={openKeys}
        onOpenChange={keys => setOpenKeys(keys as string[])}
        onClick={({ key }) => {
          const next = key as View
          navigate(next)
          onView(next)
        }}
        className="sidebar-menu"
      />
      <div className="sidebar-actions">
        <Tooltip title={collapsed ? '展开导航' : '收起导航'}>
          <Button
            type="text"
            shape="circle"
            aria-label={collapsed ? '展开导航' : '收起导航'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(value => !value)}
          />
        </Tooltip>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
      <div className="sidebar-foot">
        <span className="dot" />
        <span>{window.location.port || '39310'}</span>
        <Tooltip title="退出登录">
          <Button
            type="text"
            size="small"
            icon={<LogoutOutlined />}
            onClick={() => {
              modal.confirm({
                title: '确认退出登录',
                content: '退出后需要重新登录管理台。',
                okText: '退出登录',
                cancelText: '取消',
                okButtonProps: { danger: true },
                onOk: onLogout,
              })
            }}
          >
            退出登录
          </Button>
        </Tooltip>
      </div>
      {modalContextHolder}
    </Layout.Sider>
  )
}
