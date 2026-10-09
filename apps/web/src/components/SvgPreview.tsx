import { useEffect, useRef, useState } from 'react'
import { collectRenderedSvgTextCollisions, sanitizeSvg, type SvgTextCollision } from '../lib/svgCollision'

export function SvgCollisionBadge({ collisions }: { collisions: SvgTextCollision[] | null }) {
  if (collisions === null) return <span className="svg-quality svg-quality--pending">正在检查文字布局…</span>
  // 合规状态不占用画布空间；只有风险或检查中的状态才打扰主预览。
  if (collisions.length === 0) return null
  const overlapCount = collisions.filter((item) => item.kind === 'overlap').length
  const clippedCount = collisions.filter((item) => item.kind === 'out_of_bounds').length
  const firstSuggestion = collisions.find((item) => item.suggestion)?.suggestion
  return <span className="svg-quality svg-quality--warn" title={firstSuggestion}>⚠ {overlapCount ? `${overlapCount} 处文字重叠` : ''}{overlapCount && clippedCount ? ' · ' : ''}{clippedCount ? `${clippedCount} 处越界` : ''}</span>
}

export function RealSvgPreview({ svg, className = '' }: { svg: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [collisions, setCollisions] = useState<SvgTextCollision[] | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let frame = 0
    const measure = () => setCollisions(collectRenderedSvgTextCollisions(host))
    const schedule = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(measure)
    }
    schedule()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    observer?.observe(host)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [svg])

  const safeSvg = sanitizeSvg(svg)
  return (
    <div className={`svg-preview ${className}`}>
      <div ref={hostRef} className="chart-preview__real" dangerouslySetInnerHTML={{ __html: safeSvg }} />
      <div className="svg-preview__quality" aria-live="polite">
        <SvgCollisionBadge collisions={collisions} />
        {collisions && collisions.length > 0 && <details className="svg-preview__fixes">
          <summary>查看修复建议</summary>
          <ul>{collisions.slice(0, 3).map((item, index) => <li key={index}>{item.suggestion}</li>)}</ul>
        </details>}
      </div>
    </div>
  )
}
