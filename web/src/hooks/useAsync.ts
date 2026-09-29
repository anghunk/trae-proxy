/** 统一处理页面异步加载、错误和手动刷新。 */

import { useEffect, useState } from 'react'

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fn()
      .then(value => {
        if (cancelled) return
        setData(value)
        setError(undefined)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [...deps, tick])
  return { data, error, loading, reload: () => setTick(value => value + 1) }
}
