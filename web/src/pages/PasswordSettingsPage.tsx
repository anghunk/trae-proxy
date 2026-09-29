/** 管理员信息设置页面。 */

import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input } from 'antd'
import { api } from '../api.ts'
import { Field } from '../components/common.tsx'
import { useAsync } from '../hooks/useAsync.ts'

export function PasswordSettingsPage() {
  const { data } = useAsync(() => api.settings(), [])
  const [username, setUsername] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | undefined>(undefined)
  const [formError, setFormError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (data !== undefined) setUsername(data.username)
  }, [data])

  const submit = async (): Promise<void> => {
    setFormError(undefined)
    setResult(undefined)
    if (newPassword !== confirm) {
      setFormError('两次输入的新密码不一致')
      return
    }
    if (username.trim() === '') {
      setFormError('用户名不能为空')
      return
    }
    setBusy(true)
    try {
      const saved = await api.updateAdmin(username.trim(), currentPassword, newPassword)
      setUsername(saved.username)
      setCurrentPassword('')
      setNewPassword('')
      setConfirm('')
      setResult('管理员信息已更新')
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <Card className="page-card" title="管理员">
        <Form className="settings-form" layout="vertical" onFinish={() => { void submit() }}>
          <Field label="用户名">
            <Input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" />
          </Field>
          <Field label="当前密码" hint="修改任何设置前需要验证">
            <Input.Password
              value={currentPassword}
              onChange={event => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label="新密码" hint="留空表示不修改">
            <Input.Password
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认新密码">
            <Input.Password
              value={confirm}
              onChange={event => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          {formError !== undefined && <Alert type="error" showIcon title={formError} className="page-alert" />}
          {result !== undefined && <Alert type="success" showIcon title={result} className="page-alert" />}
          <Button type="primary" htmlType="submit" loading={busy} disabled={currentPassword === ''}>
            保存管理员信息
          </Button>
        </Form>
      </Card>
    </section>
  )
}
