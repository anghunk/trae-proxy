/**
 * WorkBuddy 渠道登录面板。
 *
 * WorkBuddy 桌面端 5.6 起把登录凭据加密落盘，外部进程读不出来；桌面端 daemon
 * 的本地转发通道又有 50 秒硬超时，长回答必断。因此这里走官方浏览器 OAuth：
 * 用户在浏览器完成一次授权，本代理保存 token 后直连上游做流式转发。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Flex, Space, Tag, Typography } from 'antd'
import { LoginOutlined, LogoutOutlined, ReloadOutlined } from '@ant-design/icons'
import { api, type WorkbuddySession } from '../api.ts'

const { Text } = Typography

/** 轮询间隔与总时长上限，与上游登录态有效期匹配。 */
const POLL_INTERVAL_MS = 1500
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export function WorkbuddyLoginPanel({ providerId, onSignedIn }: {
  providerId: string
  /** 登录成功后的回调，用于刷新模型目录。 */
  onSignedIn?: () => void
}) {
  const [session, setSession] = useState<WorkbuddySession | undefined>(undefined)
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
      setSession(await api.workbuddySession(providerId))
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
    try {
      const started = await api.workbuddyStartLogin(providerId)
      window.open(started.url, '_blank', 'noopener')
      setWaiting(true)
      setNotice('已打开 WorkBuddy 登录页，请在浏览器中完成授权。')
      deadline.current = Date.now() + LOGIN_TIMEOUT_MS
      stopPolling()
      timer.current = setInterval(() => {
        if (Date.now() > deadline.current) {
          stopPolling()
          setWaiting(false)
          setError('登录超时，请重新发起登录')
          return
        }
        api.workbuddyPollLogin(providerId)
          .then(result => {
            if (result.status === 'pending') return
            stopPolling()
            setWaiting(false)
            if (result.status === 'failed') {
              setError(result.error ?? '登录失败')
              return
            }
            setNotice(`已登录：${result.accountId ?? 'WorkBuddy'}`)
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
      await api.workbuddySignOut(providerId)
      stopPolling()
      setWaiting(false)
      setNotice('已退出登录')
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
                ? <Space size={6}>
                    <Tag color="success">已登录</Tag>
                    {session.source === 'imported' && <Tag>导入自本机客户端</Tag>}
                    {session.refreshable ? <Tag color="processing">可自动续期</Tag> : <Tag color="warning">不可续期</Tag>}
                    {session.expired && <Tag color="error">已过期</Tag>}
                  </Space>
                : <Tag>未登录</Tag>,
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
      {session?.source === 'imported' && (
        <Alert
          type="warning"
          showIcon
          message="当前使用的是从本机其它客户端导入的登录态"
          description="导入只取了 access token，无法自动续期；过期后请点「登录 WorkBuddy」在本代理里完成一次授权。"
        />
      )}
      {error !== undefined && <Alert type="error" showIcon title={error} />}
      {notice !== undefined && <Alert type="success" showIcon title={notice} />}
      <Flex gap={8} wrap="wrap">
        <Button
          type="primary"
          icon={<LoginOutlined />}
          loading={busy || waiting}
          onClick={() => { void start() }}
        >
          {signedIn ? '重新登录' : '登录 WorkBuddy'}
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
        登录态保存在本机 config 目录，仅用于访问 WorkBuddy 官方接口。
      </Text>
    </Space>
  )
}
