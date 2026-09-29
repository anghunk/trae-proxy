import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface DateRange {
  from: string
  to: string
}

interface DateRangePickerProps {
  value: DateRange
  onChange: (value: DateRange) => void
}

interface CalendarMonthProps {
  month: Date
  selectedFrom: string
  selectedTo: string
  hoveredDay: string
  onMonthChange: (month: Date) => void
  onSelectDay: (day: string) => void
  onHoverDay: (day: string) => void
}

interface PanelPosition {
  left: number
  top: number
}

interface QuickRange {
  key: string
  label: string
  range: DateRange
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const DATE_VALUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
})

/** 将 YYYY-MM-DD 解析为本地日期，避免 Date 字符串按 UTC 解析造成日期偏移。 */
function parseDateValue(value: string): Date | undefined {
  const match = DATE_VALUE_PATTERN.exec(value)
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
  return date
}

/** 将本地日期格式化为组件和接口统一使用的 YYYY-MM-DD。 */
function formatDateValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 返回本地时区的今天零点。 */
function startOfToday(): Date {
  const today = new Date()
  return new Date(today.getFullYear(), today.getMonth(), today.getDate())
}

/** 返回指定月份的第一天，用于稳定切换日历视图。 */
function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

/** 按月偏移日期，自动处理跨年。 */
function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1)
}

/** 按天偏移日期，自动处理跨月和跨年。 */
function addDays(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount)
}

/** 将日期值格式化为筛选器中的简短展示。 */
function displayDateValue(value: string): string {
  return value === '' ? '未选择' : value.replaceAll('-', '/')
}

/** 返回触发按钮上展示的日期范围文案。 */
function rangeLabel(value: DateRange): string {
  if (value.from === '' && value.to === '') return '选择日期范围'
  if (value.from === value.to) return displayDateValue(value.from)
  return `${displayDateValue(value.from)} 至 ${displayDateValue(value.to)}`
}

/** 渲染单个日历月份，并处理范围高亮与悬停预览。 */
function CalendarMonth({
  month,
  selectedFrom,
  selectedTo,
  hoveredDay,
  onMonthChange,
  onSelectDay,
  onHoverDay,
}: CalendarMonthProps) {
  const days = useMemo(() => {
    const year = month.getFullYear()
    const monthIndex = month.getMonth()
    const firstWeekday = (new Date(year, monthIndex, 1).getDay() + 6) % 7
    const dayCount = new Date(year, monthIndex + 1, 0).getDate()
    const cells: Array<string | undefined> = Array.from({ length: firstWeekday }, () => undefined)

    for (let day = 1; day <= dayCount; day += 1) {
      cells.push(formatDateValue(new Date(year, monthIndex, day)))
    }
    while (cells.length < 42) cells.push(undefined)
    return cells
  }, [month])

  const previewEnd = selectedTo === '' && selectedFrom !== '' ? hoveredDay : selectedTo
  const rangeStart = selectedFrom !== ''
    && previewEnd !== ''
    && previewEnd < selectedFrom
    ? previewEnd
    : selectedFrom
  const rangeEnd = selectedFrom !== ''
    && previewEnd !== ''
    && previewEnd < selectedFrom
    ? selectedFrom
    : previewEnd

  return (
    <div className="date-range-calendar">
      <div className="date-range-calendar-head">
        <button
          type="button"
          className="date-range-nav"
          aria-label="上一个月"
          onClick={() => onMonthChange(addMonths(month, -1))}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <strong>{MONTH_LABEL_FORMAT.format(month)}</strong>
        <button
          type="button"
          className="date-range-nav"
          aria-label="下一个月"
          onClick={() => onMonthChange(addMonths(month, 1))}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
      <div className="date-range-weekdays" aria-hidden="true">
        {WEEKDAYS.map(weekday => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="date-range-days">
        {days.map((day, index) => {
          if (day === undefined) {
            return <span key={`blank-${index}`} className="date-range-day-blank" />
          }

          const isStart = day === selectedFrom
          const isEnd = day === selectedTo
          const isInRange = rangeStart !== ''
            && rangeEnd !== ''
            && day > rangeStart
            && day < rangeEnd
          const isToday = day === formatDateValue(startOfToday())

          return (
            <button
              key={day}
              type="button"
              className={[
                'date-range-day',
                isStart ? 'is-start' : '',
                isEnd ? 'is-end' : '',
                isInRange ? 'is-in-range' : '',
                isToday ? 'is-today' : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={isStart || isEnd}
              onClick={() => onSelectDay(day)}
              onMouseEnter={() => onHoverDay(day)}
            >
              {Number(day.slice(-2))}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 可复用的日期范围选择器。
 *
 * 日期值统一为本地 YYYY-MM-DD；用户可通过快捷区间或双月日历选择范围。
 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange>(value)
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(startOfToday()))
  const [hoveredDay, setHoveredDay] = useState('')
  const [position, setPosition] = useState<PanelPosition>()

  const quickRanges = useMemo<QuickRange[]>(() => {
    const today = startOfToday()
    const todayValue = formatDateValue(today)
    return [
      { key: 'today', label: '今天', range: { from: todayValue, to: todayValue } },
      {
        key: 'last-7-days',
        label: '近 7 天',
        range: { from: formatDateValue(addDays(today, -6)), to: todayValue },
      },
      {
        key: 'last-30-days',
        label: '近 30 天',
        range: { from: formatDateValue(addDays(today, -29)), to: todayValue },
      },
      {
        key: 'this-month',
        label: '本月',
        range: { from: formatDateValue(startOfMonth(today)), to: todayValue },
      },
    ]
  }, [])

  useEffect(() => {
    if (!open) return

    const updatePosition = (): void => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (trigger === null || panel === null) return

      const rect = trigger.getBoundingClientRect()
      const viewportPadding = 12
      const panelWidth = panel.offsetWidth
      const panelHeight = panel.offsetHeight
      const left = Math.max(
        viewportPadding,
        Math.min(rect.left, window.innerWidth - panelWidth - viewportPadding),
      )
      const below = rect.bottom + 8
      const above = rect.top - panelHeight - 8
      const top = below + panelHeight <= window.innerHeight - viewportPadding
        ? below
        : above >= viewportPadding
          ? above
          : Math.max(viewportPadding, window.innerHeight - panelHeight - viewportPadding)

      setPosition({ left, top })
    }

    const frame = window.requestAnimationFrame(updatePosition)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    const closeOnOutsideClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const openPicker = (): void => {
    if (open) {
      setOpen(false)
      return
    }

    const initialDate = parseDateValue(value.from) ?? parseDateValue(value.to) ?? startOfToday()
    setDraft({ ...value })
    setViewMonth(startOfMonth(initialDate))
    setHoveredDay('')
    setPosition(undefined)
    setOpen(true)
  }

  const selectDay = (day: string): void => {
    if (draft.from === '' || draft.to !== '') {
      setDraft({ from: day, to: '' })
      setHoveredDay('')
      return
    }

    if (day < draft.from) {
      setDraft({ from: day, to: '' })
      return
    }
    setDraft({ from: draft.from, to: day })
    setHoveredDay('')
  }

  const commitRange = (range: DateRange): void => {
    setDraft(range)
    onChange(range)
    setOpen(false)
  }

  const hasValue = value.from !== '' || value.to !== ''
  const canApply = draft.from !== '' || draft.to !== ''

  return (
    <div className="date-range-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`date-range-trigger${hasValue ? ' has-value' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openPicker}
      >
        <svg className="date-range-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M16 3v4M8 3v4M3 10h18" />
        </svg>
        <span className="date-range-trigger-text">{rangeLabel(value)}</span>
        <svg className="date-range-trigger-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          className="date-range-panel"
          role="dialog"
          aria-label="选择日期范围"
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            visibility: position === undefined ? 'hidden' : 'visible',
          }}
        >
          <div className="date-range-shortcuts" aria-label="快捷日期范围">
            {quickRanges.map(item => {
              const active = draft.from === item.range.from && draft.to === item.range.to
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`date-range-shortcut${active ? ' active' : ''}`}
                  onClick={() => commitRange(item.range)}
                >
                  {item.label}
                </button>
              )
            })}
          </div>

          <div className="date-range-main">
            <div className="date-range-calendars" onMouseLeave={() => setHoveredDay('')}>
              <CalendarMonth
                month={viewMonth}
                selectedFrom={draft.from}
                selectedTo={draft.to}
                hoveredDay={hoveredDay}
                onMonthChange={setViewMonth}
                onSelectDay={selectDay}
                onHoverDay={setHoveredDay}
              />
              <CalendarMonth
                month={addMonths(viewMonth, 1)}
                selectedFrom={draft.from}
                selectedTo={draft.to}
                hoveredDay={hoveredDay}
                onMonthChange={setViewMonth}
                onSelectDay={selectDay}
                onHoverDay={setHoveredDay}
              />
            </div>

            <div className="date-range-foot">
              <span className="date-range-foot-summary">
                {rangeLabel({ from: draft.from, to: draft.to })}
              </span>
              <button
                type="button"
                className="date-range-clear"
                onClick={() => commitRange({ from: '', to: '' })}
              >
                清除
              </button>
              <button
                type="button"
                className="date-range-apply"
                disabled={!canApply}
                onClick={() => commitRange(draft)}
              >
                应用
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
