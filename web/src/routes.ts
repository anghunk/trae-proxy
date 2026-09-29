/** 管理台页面路由定义与地址解析。 */

export type View =
  | 'overview'
  | 'providers'
  | 'keys'
  | 'usage'
  | 'logs'
  | 'provider-detail'
  | 'settings-password'
  | 'settings-gateway'

export const SETTING_VIEWS: Array<{ id: View; label: string }> = [
  { id: 'settings-password', label: '修改密码' },
  { id: 'settings-gateway', label: '网关信息' },
]

/** 根据当前浏览器地址解析页面视图。 */
export function viewFromPath(): View {
  if (/^\/providers\/[^/]+\/?$/.test(window.location.pathname)) return 'provider-detail'
  const settingsMatch = /^\/settings\/(password|gateway)\/?$/.exec(window.location.pathname)
  if (settingsMatch !== null) return `settings-${settingsMatch[1]}` as View
  const match = /^\/(overview|providers|keys|usage|logs)\/?$/.exec(window.location.pathname)
  return match === null ? 'overview' : match[1] as View
}

/** 写入浏览器历史地址，由调用方同步更新当前视图。 */
export function navigate(view: View, id?: string): void {
  const path = view === 'provider-detail' && id !== undefined
    ? `/providers/${encodeURIComponent(id)}`
    : view === 'settings-password' ? '/settings/password'
    : view === 'settings-gateway' ? '/settings/gateway'
    : `/${view}`
  window.history.pushState(null, '', path)
}
