/** 管理台通用数值与日期格式化。 */

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

/** 大数 Token 显示：不足 1 万显示原值，1 万以上以「万」为单位，1 亿以上以「亿」为单位。 */
export function formatToken(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(2).replace(/\.?0+$/, '')} 亿`
  }
  if (abs >= 10_000) {
    return `${(value / 10_000).toFixed(2).replace(/\.?0+$/, '')} 万`
  }
  return formatNumber(value)
}

/** 返回 1/2/5 序列中的整齐刻度步长。 */
export function niceAxisStep(range: number): number {
  if (range <= 0) return 1
  const roughStep = range / 4
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const normalized = roughStep / magnitude
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return niceNormalized * magnitude
}

/** Y 轴刻度使用整齐的万/亿单位，例如 500w、1000w、1.5亿。 */
export function formatAxisToken(value: number): string {
  const rounded = Math.round(value)
  const abs = Math.abs(rounded)
  if (abs >= 100_000_000) {
    const yi = rounded / 100_000_000
    return Number.isInteger(yi) ? `${yi}亿` : `${yi.toFixed(1)}亿`
  }
  if (abs >= 10_000) {
    return `${Math.round(rounded / 10_000)}万`
  }
  return formatNumber(rounded)
}

export function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(1)} s`
}

export function formatDate(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** 将日期输入值转换为本地时区时间戳；结束边界使用次日零点作为开区间上界。 */
export function localDateBoundary(value: string, endExclusive = false): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return undefined
  }
  if (endExclusive) date.setDate(date.getDate() + 1)
  return date.getTime()
}
