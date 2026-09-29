/**
 * Trae Proxy 管理台入口。
 *
 * 认证状态在入口层统一判断，登录后的页面由 Shell 按路由分发。
 */

import { useEffect, useState } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { api } from './api.ts'
import { Spinner } from './components/common.tsx'
import { Shell } from './layout/Shell.tsx'
import { AuthPage } from './pages/AuthPage.tsx'
import { useTheme } from './theme.ts'

export function App() {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const { theme, toggleTheme } = useTheme()
  useEffect(() => {
    api.session()
      .then(session => {
        setAuthed(session.authed)
        setChecking(false)
      })
      .catch(() => {
        setAuthed(false)
        setChecking(false)
      })
  }, [])
  const content = checking
    ? <div className="app-loading"><Spinner label="正在连接网关" /></div>
    : !authed
      ? (
        <AuthPage
          theme={theme}
          onToggleTheme={toggleTheme}
          onDone={() => {
            setAuthed(true)
            setChecking(false)
          }}
        />
      )
      : <Shell theme={theme} onToggleTheme={toggleTheme} />

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          borderRadius: 8,
          fontFamily: 'Geist, PingFang SC, Microsoft YaHei, system-ui, sans-serif',
        },
      }}
    >
      {content}
    </ConfigProvider>
  )
}
