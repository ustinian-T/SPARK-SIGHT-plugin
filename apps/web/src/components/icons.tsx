// 线性图标集（内联 SVG，无第三方依赖、无 emoji）。
import type { CSSProperties } from 'react'

const P: Record<string, string> = {
  chart: 'M3 3v18h18 M7 15l4-5 3 3 5-7',
  chat: 'M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12z',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  // 三方案对比：三块并排面板（区别于四宫格 grid 与表格 table）
  columns: 'M4 4h4.5v16H4zM10.25 4h4.5v16h-4.5zM16.5 4H21v16h-4.5z',
  // 项目与协作：两人（一个完整、一个在侧），区别于对比/网格类图标
  users: 'M9.5 11.2a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.8 20c0-3.1 2.6-5 5.7-5s5.7 1.9 5.7 5 M16.2 4.4a3 3 0 0 1 0 5.6 M17.4 15.2c2.3.6 3.8 2.3 3.8 4.8',
  code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6 M13 4l-2 16',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  sliders: 'M4 6h10 M18 6h2 M4 12h2 M10 12h10 M4 18h12 M20 18h0 M14 4v4 M6 10v4 M16 16v4',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  shield: 'M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3z M9 12l2 2 4-4',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 17v3h16v-3',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z M14 3v5h5',
  play: 'M7 5l12 7-12 7V5z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4 M21 4v5h-5',
  download: 'M12 4v11 M7 11l5 5 5-5 M4 20h16',
  share: 'M8.5 13.5l7-4 M8.5 10.5l7 4 M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  close: 'M6 6l12 12 M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  chevronR: 'M9 6l6 6-6 6',
  chevronD: 'M6 9l6 6 6-6',
  terminal: 'M4 5h16v14H4zM4 5l0 14 M8 10l3 2.5L8 15 M13 15h3',
  plus: 'M12 5v14 M5 12h14',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18 M12 3c2.5 2.6 2.5 15.4 0 18 M12 3c-2.5 2.6-2.5 15.4 0 18',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9z M9 2v3 M15 2v3 M9 19v3 M15 19v3 M2 9h3 M2 15h3 M19 9h3 M19 15h3',
  undo: 'M9 7L4 12l5 5 M4 12h11a5 5 0 0 1 0 10h-3',
  layers: 'M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5 M3 17l9 5 9-5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  warn: 'M12 3l10 18H2L12 3z M12 10v4 M12 17h0',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5 M12 8h0',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6 M15 9l-6 6',
  send: 'M4 12l16-8-6 16-3-7-7-1z',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4 M9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  table: 'M4 4h16v16H4zM4 9h16 M4 14h16 M9 4v16 M15 4v16',
  branch: 'M6 4v16 M6 8a12 12 0 0 0 12 4 M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  lock: 'M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3 M12 15v2',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z',
  filter: 'M3 5h18l-7 8v6l-4-2v-4L3 5z',
  maximize: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  doc: 'M7 4h7l5 5v11H7zM14 4v5h5 M9 13h6 M9 17h6'
}

export interface IconProps {
  name: keyof typeof P | string
  size?: number
  className?: string
  strokeWidth?: number
  style?: CSSProperties
}

export function Icon({ name, size = 16, className, strokeWidth = 1.8, style }: IconProps) {
  const d = P[name] ?? P.info
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: 'block', flex: 'none', ...style }}
      aria-hidden
    >
      <path d={d} />
    </svg>
  )
}
