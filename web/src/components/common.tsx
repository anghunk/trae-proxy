/** 管理台通用展示组件。 */

import type { ReactNode } from 'react'
import { Button, Flex, Form, Spin, Tooltip, Typography } from 'antd'
import { GithubOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons'
import type { Theme } from '../theme.ts'

const { Text } = Typography
const GITHUB_URL = 'https://github.com/anghunk/trae-proxy'

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <Form.Item label={label} tooltip={hint}>
      {children}
    </Form.Item>
  )
}

/** 页面级操作区：统一放在顶部标题下方，避免重复渲染页面标题。 */
export function PageActions({ children }: { children: ReactNode }) {
  return (
    <Flex justify="flex-end" align="center" gap={12} wrap="wrap" className="page-actions">
      {children}
    </Flex>
  )
}

export function Spinner({ label }: { label: string }) {
  return (
    <Flex align="center" justify="center" gap={12} className="spinner">
      <Spin />
      <Text type="secondary">{label}</Text>
    </Flex>
  )
}

/** 页面底部的 GitHub 仓库链接。 */
export function GitHubLink({ className }: { className?: string }) {
  return (
    <a
      className={className === undefined ? 'github-link' : `github-link ${className}`}
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
    >
      <GithubOutlined />
      GitHub
    </a>
  )
}

/** 主题切换按钮：在明亮与黑夜之间切换，偏好由 useTheme 持久化。 */
export function ThemeToggle({ theme, onToggle, floating = false }: {
  theme: Theme
  onToggle: () => void
  floating?: boolean
}) {
  const target = theme === 'dark' ? '明亮' : '黑夜'
  const label = `切换到${target}主题`
  return (
    <Tooltip title={label}>
      <Button
        type="text"
        shape="circle"
        className={floating ? 'theme-toggle floating' : 'theme-toggle'}
        onClick={onToggle}
        aria-label={label}
        icon={theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
      />
    </Tooltip>
  )
}
