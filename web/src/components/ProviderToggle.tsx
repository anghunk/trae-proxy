/** 渠道启停开关。 */

import { Switch } from 'antd'

/**
 * 渠道启停滑块。
 *
 * 开启状态下显示「启用」，关闭状态下显示「停用」，可直接点击切换。
 */
export function ProviderToggle({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <Switch
      checked={enabled}
      onChange={onChange}
      disabled={disabled}
    />
  )
}
