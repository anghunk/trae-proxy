/**
 * 管理台主题（明亮 / 黑夜）。
 *
 * 主题通过 `<html data-theme="...">` 生效，颜色全部由 styles.css 中的 CSS 变量控制。
 * 用户选择写入 localStorage；未选择时跟随系统 `prefers-color-scheme`。
 * 首屏由 index.html 中的内联脚本提前应用同一份偏好，避免刷新时闪白。
 */

import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

/** 与 index.html 内联脚本共用的存储键，修改时需同步两处。 */
export const THEME_STORAGE_KEY = 'trae-proxy-theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 读取用户显式选择的主题；未选择或存储不可用时返回 undefined。 */
export function readStoredTheme(): Theme | undefined {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : undefined
  } catch {
    // 隐私模式等场景下 localStorage 不可用，按跟随系统处理。
    return undefined
  }
}

/** 当前系统偏好的主题。 */
export function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/** 当前生效的主题：用户选择优先，否则跟随系统。 */
export function currentTheme(): Theme {
  return readStoredTheme() ?? systemTheme()
}

/** 把主题写入 `<html>`，同时同步浏览器原生控件（滚动条、下拉框）的配色。 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
  document.documentElement.style.colorScheme = theme
}

export interface ThemeController {
  theme: Theme
  toggleTheme: () => void
}

/** 主题状态：返回当前主题与切换函数，切换结果立即生效并持久化。 */
export function useTheme(): ThemeController {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    // 仅在用户尚未显式选择时跟随系统外观变化。
    if (readStoredTheme() !== undefined) return
    const media = window.matchMedia(DARK_QUERY)
    const onChange = (): void => setTheme(systemTheme())
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  useEffect(() => {
    // 其他标签页切换主题时同步（storage 事件只在其他标签页触发）。
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return
      setTheme(currentTheme())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const toggleTheme = useCallback((): void => {
    setTheme(previous => {
      const next: Theme = previous === 'dark' ? 'light' : 'dark'
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next)
      } catch {
        // 存储失败只影响下次访问的默认值，不影响本次切换。
      }
      return next
    })
  }, [])

  return { theme, toggleTheme }
}
