import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react'
import { cx } from '../lib/format'
import { Icon, type IconProps } from './icons'

export function Panel({
  title,
  icon,
  right,
  children,
  className,
  bodyClassName,
  transparent
}: {
  title?: ReactNode
  icon?: IconProps['name']
  right?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  transparent?: boolean
}) {
  return (
    <section className={cx('panel', transparent && 'panel--transparent', className)}>
      {title && (
        <header className="panel__head">
          <div className="panel__title">
            {icon && <Icon name={icon} size={15} />}
            <span>{title}</span>
          </div>
          {right && <div className="panel__right">{right}</div>}
        </header>
      )}
      <div className={cx('panel__body', bodyClassName)}>{children}</div>
    </section>
  )
}

type BtnVariant = 'primary' | 'glass' | 'ghost' | 'danger' | 'soft'
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  icon?: IconProps['name']
  iconRight?: IconProps['name']
  active?: boolean
  size?: 'xs' | 'sm' | 'md'
}

export function Button({
  variant = 'glass',
  icon,
  iconRight,
  active,
  size = 'md',
  className,
  children,
  ...rest
}: BtnProps) {
  return (
    <button
      className={cx('btn', `btn--${variant}`, size === 'sm' && 'btn--sm', size === 'xs' && 'btn--xs', active && 'is-active', className)}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : size === 'xs' ? 12 : 15} />}
      {children && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 14 : size === 'xs' ? 12 : 15} />}
    </button>
  )
}

export function IconButton({
  name,
  size = 16,
  className,
  active,
  title,
  ...rest
}: { name: IconProps['name']; size?: number; active?: boolean; title?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cx('icon-btn', active && 'is-active', className)} title={title} {...rest}>
      <Icon name={name} size={size} />
    </button>
  )
}

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'brand' | 'muted'
const toneClass: Record<Tone, string> = {
  ok: 'badge--ok',
  warn: 'badge--warn',
  danger: 'badge--danger',
  info: 'badge--info',
  brand: 'badge--brand',
  muted: 'badge--muted'
}

export function Badge({ tone = 'muted', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('badge', toneClass[tone], className)}>{children}</span>
}

export function Dot({ tone = 'ok', pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span className={cx('dot', `dot--${tone}`, pulse && 'dot--pulse')} />
}

export function Tabs({
  tabs,
  active,
  onChange
}: {
  tabs: { id: string; label: ReactNode; icon?: IconProps['name']; badge?: ReactNode }[]
  active: string
  onChange: (id: string) => void
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={cx('tab', active === t.id && 'is-active')} onClick={() => onChange(t.id)}>
          {t.icon && <Icon name={t.icon} size={14} />}
          <span>{t.label}</span>
          {t.badge}
        </button>
      ))}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  desc,
  children
}: {
  icon: IconProps['name']
  title: string
  desc?: string
  children?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {children}
    </div>
  )
}

export function Meter({ value, tone = 'brand' }: { value: number; tone?: Tone }) {
  return (
    <span className="meter">
      <span className="meter__track">
        <span className={cx('meter__fill', `meter__fill--${tone}`)} style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
    </span>
  )
}

export function KeyVal({ k, v, mono }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="kv__k">{k}</span>
      <span className={cx('kv__v', mono && 'mono')}>{v}</span>
    </div>
  )
}

interface TooltipProps {
  /** tooltip 文本 */
  content: string
  /** 被包裹的控件 */
  children: ReactNode
  /** 弹出方向，默认 top */
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** 显示延迟 ms，默认 200 */
  delay?: number
}

/**
 * 轻量 Tooltip：hover（mouseenter/leave）与键盘 focus/blur 均触发，
 * 纯 CSS 定位，不遮挡、不拦截点击；气泡 pointer-events:none，
 * 带 role="tooltip" 与 aria-describedby 关联，平时不可见、不占布局。
 */
export function Tooltip({ content, children, placement = 'top', delay = 200 }: TooltipProps) {
  const id = useId()
  const [show, setShow] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const open = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setShow(true), delay)
  }
  const close = () => {
    window.clearTimeout(timer.current)
    setShow(false)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <span
      className={cx('tooltip', `tooltip--${placement}`, show && 'is-show')}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      aria-describedby={show ? id : undefined}
    >
      {children}
      <span role="tooltip" id={id} className="tooltip__bubble">
        {content}
      </span>
    </span>
  )
}

/**
 * 对话框 a11y 行为 Hook（P2-5/6/7 共性项）：
 * - 打开时记录触发元素，关闭后把焦点返回触发元素；
 * - ESC 关闭；
 * - Tab / Shift+Tab 在对话框内循环（焦点陷阱）。
 * 供居中遮罩 Modal 与无遮罩浮层（如 PatchModal）复用。
 */
export function useDialogA11y(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  // 打开瞬间记录当前焦点元素，关闭后交还
  const prevFocused = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) prevFocused.current = document.activeElement as HTMLElement | null
  }, [open])

  // ESC 关闭 + 焦点陷阱；cleanup 中返回焦点（覆盖 open=false 与组件卸载两条路径）
  useEffect(() => {
    if (!open) return
    const node = ref.current
    if (!node) return
    const getFocusable = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      )
    // 打开时聚焦对话框内第一个可聚焦元素
    const items = getFocusable()
    ;(items[0] ?? node).focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const list = getFocusable()
        if (list.length === 0) {
          e.preventDefault()
          return
        }
        const first = list[0]
        const last = list[list.length - 1]
        const active = document.activeElement
        // 在首尾之间循环，阻止焦点逃逸到对话框外
        if (e.shiftKey && (active === first || !node.contains(active))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // 关闭/卸载时把焦点交还给触发元素
      prevFocused.current?.focus?.()
    }
  }, [open, onClose, ref])
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: number
}

/**
 * 统一对话框基础组件：遮罩 + role="dialog" + aria-modal + aria-labelledby，
 * 内置 ESC 关闭、焦点陷阱与焦点返回；点击遮罩关闭。open=false 时不渲染。
 * 标题对屏幕阅读器可见；可视化标题由业务卡片自行渲染，避免视觉重复。
 */
export function Modal({ open, onClose, title, children, width }: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useDialogA11y(open, onClose, panelRef)
  if (!open) return null
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(20, 36, 27, 0.42)',
        backdropFilter: 'blur(6px)',
        display: 'grid',
        placeItems: 'center',
        padding: 40
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          outline: 'none',
          width: width ? `min(${width}px, 92vw)` : undefined,
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <span
          id={titleId}
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
        >
          {title}
        </span>
        {children}
      </div>
    </div>
  )
}
