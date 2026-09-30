/** 渠道启停开关。 */

import { useState } from 'react'
import { Popconfirm, Switch } from 'antd'

/**
 * 渠道启停滑块。
 *
 * 默认点击后立即触发切换回调；传入 `confirm` 后先弹出二次确认，确认后才触发回调。
 *
 * @param enabled 当前是否启用
 * @param onChange 状态切换回调，参数为切换后的目标状态
 * @param disabled 是否禁用交互
 * @param confirm 是否在切换前二次确认
 * @param confirmDescription 二次确认弹层中的说明文字
 */
export function ProviderToggle({
  enabled,
  onChange,
  disabled,
  confirm = false,
  confirmDescription,
}: {
  enabled: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  confirm?: boolean
  confirmDescription?: string
}) {
  const [open, setOpen] = useState(false)

  const switchNode = (
    <Switch
      checked={enabled}
      disabled={disabled}
      onChange={confirm ? () => setOpen(true) : onChange}
    />
  )

  if (!confirm) return switchNode

  const action = enabled ? '停用' : '启用'
  return (
    <Popconfirm
      open={open}
      title={`${action}渠道`}
      {...(confirmDescription === undefined ? {} : { description: confirmDescription })}
      okText={action}
      cancelText="取消"
      onOpenChange={next => { if (!disabled) setOpen(next) }}
      onConfirm={() => {
        setOpen(false)
        onChange(!enabled)
      }}
      onCancel={() => setOpen(false)}
    >
      {switchNode}
    </Popconfirm>
  )
}
