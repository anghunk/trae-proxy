/** 登录与首次初始化页面。 */

import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input, Typography } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { api } from '../api.ts'
import { Field, GitHubLink, ThemeToggle } from '../components/common.tsx'
import type { Theme } from '../theme.ts'

const { Title, Paragraph } = Typography

export function AuthPage({ onDone, theme, onToggleTheme }: {
  onDone: () => void
  theme: Theme
  onToggleTheme: () => void
}) {
  const [mode, setMode] = useState<'setup' | 'login'>('setup')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const switchMode = (next: 'setup' | 'login'): void => {
    setMode(next)
    setPassword('')
    setConfirm('')
    setError(undefined)
  }

  useEffect(() => {
    api.session()
      .then(session => {
        if (session.authed) onDone()
        else setMode(session.needsSetup ? 'setup' : 'login')
      })
      .catch(() => setMode('login'))
  }, [onDone])

  const submit = async (): Promise<void> => {
    setError(undefined)
    if (mode === 'setup' && password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      if (mode === 'setup') {
        await api.bootstrap(username, password)
      } else {
        await api.login(username, password)
      }
      onDone()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <ThemeToggle theme={theme} onToggle={onToggleTheme} floating />
      <GitHubLink className="auth-github" />
      <Card className="auth-card">
        <img className="brand-mark" src="/logo.png" alt="Trae Proxy" />
        <Title level={3}>{mode === 'setup' ? '创建管理员' : '登录管理台'}</Title>
        <Paragraph type="secondary">
          {mode === 'setup' ? '首次启动需要初始化本地管理员账户。' : '使用管理员账户登录统一网关控制台。'}
        </Paragraph>
        <Form layout="vertical" onFinish={() => { void submit() }}>
          <Field label="用户名">
            <Input
              value={username}
              onChange={event => setUsername(event.target.value)}
              autoComplete="username"
              prefix={<UserOutlined />}
            />
          </Field>
          <Field label="密码">
            <Input.Password
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
              prefix={<LockOutlined />}
            />
          </Field>
          {mode === 'setup' && (
            <Field label="确认密码">
              <Input.Password
                value={confirm}
                onChange={event => setConfirm(event.target.value)}
                autoComplete="new-password"
                prefix={<LockOutlined />}
              />
            </Field>
          )}
          {error !== undefined && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
          <Button type="primary" htmlType="submit" loading={busy} block size="large">
            {mode === 'setup' ? '创建并进入' : '登录'}
          </Button>
          {mode === 'login' && (
            <Button type="link" htmlType="button" block onClick={() => switchMode('setup')}>
              未初始化？创建管理员
            </Button>
          )}
          {mode === 'setup' && (
            <Button type="link" htmlType="button" block onClick={() => switchMode('login')}>
              已有管理员，去登录
            </Button>
          )}
        </Form>
      </Card>
    </div>
  )
}
