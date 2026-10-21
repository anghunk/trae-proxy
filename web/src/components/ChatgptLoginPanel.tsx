/**
 * ChatGPT 订阅渠道登录面板。
 *
 * 用户通过浏览器完成 OpenAI OAuth，本代理只保存订阅授权 token，
 * 并使用 Plus / Pro / Business 套餐额度调用公开 Responses API。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Flex, Space, Tag, Typography } from 'antd'
import { LoginOutlined, LogoutOutlined, ReloadOutlined } from '@ant-design/icons'
import { api, type ChatgptSession } from '../api.ts'

const { Text } = Typography
const POLL_INTERVAL_MS = 1500
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export function ChatgptLoginPanel({ providerId, onSignedIn }: {
  providerId: string
  /** 授权成功后的回调，用于刷新模型目录。 */
  onSignedIn?: () => void
}) {
  const [session, setSession] = useState<ChatgptSession | undefined>(undefined)
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const deadline = useRef(0)

  const stopPolling = useCallback((): void => {
    if (timer.current !== undefined) {
      clearInterval(timer.current)
      timer.current = undefined
    }
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      setSession(await api.chatgptSession(providerId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [providerId])

  useEffect(() => {
    void reload()
    return stopPolling
  }, [reload, stopPolling])

  const start = async (): Promise<void> => {
    setError(undefined)
    setNotice(undefined)
    setBusy(true)
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    try {
      const started = await api.chatgptStartLogin(providerId)
      if (popup !== null && !popup.closed) popup.location.replace(started.url)
      else window.open(started.url, '_blank', 'noopener')
      setWaiting(true)
      setNotice('已打开 ChatGPT 授权页，请在浏览器中完成登录并允许使用套餐额度。')
      deadline.current = Date.now() + LOGIN_TIMEOUT_MS
      stopPolling()
      timer.current = setInterval(() => {
        if (Date.now() > deadline.current) {
          stopPolling()
          setWaiting(false)
          setError('授权超时，请重新发起登录')
          return
        }
        api.chatgptPollLogin(providerId)
          .then(result => {
            if (result.status === 'pending') return
            stopPolling()
            setWaiting(false)
            if (result.status === 'failed') {
              setError(result.error ?? '授权失败')
              return
            }
            setNotice(`已连接 ChatGPT：${result.accountId ?? '当前账号'}`)
            void reload()
            onSignedIn?.()
          })
          .catch((reason: unknown) => {
            stopPolling()
            setWaiting(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          })
      }, POLL_INTERVAL_MS)
    } catch (reason) {
      popup?.close()
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setError(undefined)
    setNotice(undefined)
    setBusy(true)
    try {
      const result = await api.chatgptSignOut(providerId)
      stopPolling()
      setWaiting(false)
      setNotice(result.remoteRevoked
        ? '已退出登录并撤销远端授权'
        : '已清除本地登录态；远端授权未能确认，可在 ChatGPT 设置中移除应用')
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const signedIn = session?.signedIn === true
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      {session !== undefined && (
        <Descriptions
          size="small"
          column={1}
          items={[
            {
              key: 'status',
              label: '登录状态',
              children: signedIn
                ? <Space size={6} wrap>
                    <Tag color="success">已连接</Tag>
                    {session.planUsage
                      ? <Tag color="processing">套餐额度已授权</Tag>
                      : <Tag color="warning">未授权套餐额度</Tag>}
                    {session.refreshable ? <Tag color="processing">可自动续期</Tag> : <Tag color="warning">不可续期</Tag>}
                    {session.expired && <Tag color="error">已过期</Tag>}
                  </Space>
                : <Tag>未连接</Tag>,
            },
            ...signedIn && session.accountId !== undefined
              ? [{ key: 'account', label: '账号', children: session.accountId }]
              : [],
            ...signedIn && session.expiresAt !== undefined
              ? [{
                  key: 'expires',
                  label: 'access token 到期',
                  children: new Date(session.expiresAt).toLocaleString('zh-CN'),
                }]
              : [],
          ]}
        />
      )}
      {error !== undefined && <Alert type="error" showIcon title={error} />}
      {notice !== undefined && <Alert type="success" showIcon title={notice} />}
      <Alert
        type="info"
        showIcon
        message="使用 ChatGPT 套餐额度"
        description="授权后请求会消耗当前账号的 ChatGPT 套餐额度。使用量可在 ChatGPT 设置的 Usage 页面查看和管理。"
      />
      <Flex gap={8} wrap="wrap">
        <Button
          type="primary"
          icon={<LoginOutlined />}
          loading={busy || waiting}
          onClick={() => { void start() }}
        >
          {signedIn ? '重新连接' : '继续使用 ChatGPT'}
        </Button>
        <Button icon={<ReloadOutlined />} disabled={busy || waiting} onClick={() => { void reload() }}>
          刷新状态
        </Button>
        {signedIn && (
          <Button danger icon={<LogoutOutlined />} disabled={busy || waiting} onClick={() => { void signOut() }}>
            退出登录
          </Button>
        )}
      </Flex>
      <Text type="secondary">
        凭据保存在本机 config 目录，权限 0600，仅用于调用 OpenAI 官方 Responses API。
      </Text>
    </Space>
  )
}
