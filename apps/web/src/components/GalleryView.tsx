// 阶段 8：项目图库视图。
// 按项目聚合所有任务产出的图表，网格展示；支持按任务 / 图表类型筛选、按时间排序、
// 点击放大（Lightbox 内左右箭头切换同筛选条件下的其他图表）。
import { useEffect, useMemo, useState, useRef, memo } from 'react'
import { useStore } from '../state/store'
import { Badge, Button, EmptyState, Modal, Tooltip } from './common'
import { Icon } from './icons'
import { ChartPreview } from './ChartPreview'
import { RealSvgPreview } from './SvgPreview'
import type { GalleryChart } from '../types'

// 图表类型中文标签（与 LayerKind 对齐），未知类型原样显示。
const CHART_TYPE_LABEL: Record<string, string> = {
  bar: '柱状图',
  line: '折线图',
  scatter: '散点图',
  box: '箱线图',
  heatmap: '热力图'
}
function chartTypeLabel(t: string): string {
  return CHART_TYPE_LABEL[t] ?? t
}

// 生成时间格式化：YYYY-MM-DD HH:mm
function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 单张图表卡片：memo 化避免筛选/排序时全量重渲染 SVG。 */
const ChartCard = memo(function ChartCard({
  chart,
  onZoom,
  onOpenTask
}: {
  chart: GalleryChart
  onZoom: () => void
  onOpenTask: () => void
}) {
  return (
    <article
      className="gallery-card"
      onClick={onZoom}
      role="button"
      tabIndex={0}
      title="点击放大查看"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onZoom()
        }
      }}
    >
      <div className="gallery-card__thumb">
        {chart.svg ? (
          <div className="gallery-card__svg"><RealSvgPreview svg={chart.svg} /></div>
        ) : chart.plan ? (
          <ChartPreview plan={chart.plan} />
        ) : (
          <div className="gallery-card__placeholder">暂无预览</div>
        )}
        {/* hover 浮层：放大 / 打开任务 */}
        <div className="gallery-card__overlay">
          <Button
            size="sm"
            variant="glass"
            icon="maximize"
            onClick={(e) => { e.stopPropagation(); onZoom() }}
          >
            放大
          </Button>
          <Button
            size="sm"
            variant="glass"
            icon="eye"
            onClick={(e) => { e.stopPropagation(); onOpenTask() }}
          >
            打开任务
          </Button>
        </div>
      </div>
      <div className="gallery-card__meta">
        <div className="gallery-card__title" title={chart.taskTitle}>{chart.taskTitle}</div>
        <div className="gallery-card__tags">
          <Badge tone="brand">{chartTypeLabel(chart.chartType)}</Badge>
          <span className="gallery-card__time">
            <Icon name="clock" size={11} />
            {formatTime(chart.createdAt)}
          </span>
        </div>
      </div>
    </article>
  )
})

/** 放大灯箱：在当前筛选结果列表内支持左右箭头切换。 */
function GalleryLightbox({
  charts,
  index,
  onClose,
  onNavigate,
  onOpenTask
}: {
  charts: GalleryChart[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
  onOpenTask: (taskId: string) => void
}) {
  const chart = charts[index]
  const hasPrev = index > 0
  const hasNext = index < charts.length - 1

  // 左右方向键切换；Modal 已处理 ESC 关闭与焦点陷阱。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) onNavigate(index - 1)
      else if (e.key === 'ArrowRight' && hasNext) onNavigate(index + 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [index, hasPrev, hasNext, onNavigate])

  if (!chart) return null
  return (
    <Modal open title={chart.taskTitle} onClose={onClose} width={1080}>
      <div className="lightbox__card">
        <div className="lightbox__head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <strong>{chart.taskTitle}</strong>
            <Badge tone="brand">{chartTypeLabel(chart.chartType)}</Badge>
            <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>
              {index + 1} / {charts.length}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Button size="sm" variant="ghost" icon="chevronR" onClick={() => onNavigate(index - 1)} disabled={!hasPrev} title="上一张" style={{ transform: 'scaleX(-1)' }} />
            <Button size="sm" variant="ghost" icon="chevronR" onClick={() => onNavigate(index + 1)} disabled={!hasNext} title="下一张" />
            <Button size="sm" variant="ghost" icon="close" onClick={onClose}>关闭</Button>
          </div>
        </div>
        <div className="lightbox__body">
          {chart.svg ? (
            <RealSvgPreview svg={chart.svg} />
          ) : chart.plan ? (
            <ChartPreview plan={chart.plan} large />
          ) : (
            <EmptyState icon="image" title="暂无预览" desc="该图表尚未生成可渲染产物。" />
          )}
        </div>
        <div style={{ padding: '10px 16px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--line)' }}>
          <Button size="sm" variant="primary" icon="eye" onClick={() => onOpenTask(chart.taskId)}>
            打开所属任务
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function GalleryView() {
  const {
    state,
    loadGalleryCharts,
    setGalleryFilter,
    openTask
  } = useStore()
  const { currentProjectId, galleryCharts, galleryLoading, galleryFilter, galleryError } = state
  const [zoomIndex, setZoomIndex] = useState<number | null>(null)

  const loadGalleryRef = useRef(loadGalleryCharts)
  loadGalleryRef.current = loadGalleryCharts

  // 切换到图库视图（组件挂载）或项目变化时，懒加载聚合图表；不阻塞 UI。
  useEffect(() => {
    if (!currentProjectId) return
    void loadGalleryRef.current(currentProjectId).catch(() => {})
  }, [currentProjectId, state.gate.status])

  // 任务下拉选项（去重）
  const taskOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of galleryCharts) {
      if (!map.has(c.taskId)) map.set(c.taskId, c.taskTitle)
    }
    return Array.from(map, ([taskId, title]) => ({ taskId, title }))
  }, [galleryCharts])

  // 图表类型下拉选项（去重）
  const typeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const c of galleryCharts) set.add(c.chartType)
    return Array.from(set).sort()
  }, [galleryCharts])

  // 应用筛选 + 排序
  const visibleCharts = useMemo(() => {
    let list = galleryCharts.slice()
    if (galleryFilter.taskId) list = list.filter((c) => c.taskId === galleryFilter.taskId)
    if (galleryFilter.chartType) list = list.filter((c) => c.chartType === galleryFilter.chartType)
    list.sort((a, b) => (galleryFilter.sort === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt))
    return list
  }, [galleryCharts, galleryFilter])

  // 灯箱关闭后若列表变化，避免 index 越界
  useEffect(() => {
    if (zoomIndex !== null && zoomIndex >= visibleCharts.length) setZoomIndex(null)
  }, [visibleCharts.length, zoomIndex])

  const openZoom = (index: number) => setZoomIndex(index)
  const handleOpenTask = (taskId: string) => {
    void openTask(taskId).catch(() => {})
  }

  return (
    <div className="gallery">
      {/* 顶部筛选栏 */}
      <div className="gallery__filterbar">
        <label className="gallery__field">
          <span>任务</span>
          <select
            value={galleryFilter.taskId ?? ''}
            onChange={(e) => setGalleryFilter({ ...galleryFilter, taskId: e.target.value || undefined })}
          >
            <option value="">全部任务</option>
            {taskOptions.map((t) => (
              <option key={t.taskId} value={t.taskId}>{t.title}</option>
            ))}
          </select>
        </label>
        <label className="gallery__field">
          <span>图表类型</span>
          <select
            value={galleryFilter.chartType ?? ''}
            onChange={(e) => setGalleryFilter({ ...galleryFilter, chartType: e.target.value || undefined })}
          >
            <option value="">全部类型</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>{chartTypeLabel(t)}</option>
            ))}
          </select>
        </label>
        <label className="gallery__field">
          <span>排序</span>
          <select
            value={galleryFilter.sort}
            onChange={(e) => setGalleryFilter({ ...galleryFilter, sort: e.target.value as 'newest' | 'oldest' })}
          >
            <option value="newest">最新优先</option>
            <option value="oldest">最旧优先</option>
          </select>
        </label>
        <Tooltip content="本项目所有任务已生成图表的总数。" placement="top">
          <span className="gallery__count" style={{ cursor: 'help' }}>共 {visibleCharts.length} 张</span>
        </Tooltip>
        {galleryLoading && <span className="gallery__loading">加载中…</span>}
      </div>

      {/* 主体：网格 / 空状态 / 错误 */}
      <div className="gallery__body">
        {galleryError ? (
          <EmptyState icon="warn" title="图库加载失败" desc={galleryError} />
        ) : galleryLoading && galleryCharts.length === 0 ? (
          <EmptyState icon="refresh" title="正在聚合项目图表…" />
        ) : visibleCharts.length === 0 ? (
          <EmptyState
            icon="image"
            title="项目内暂无图表"
            desc="开始分析后自动收集"
          />
        ) : (
          <div className="gallery__grid">
            {visibleCharts.map((chart, i) => (
              <ChartCard
                key={chart.id}
                chart={chart}
                onZoom={() => openZoom(i)}
                onOpenTask={() => handleOpenTask(chart.taskId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 放大灯箱（同筛选条件下左右切换） */}
      {zoomIndex !== null && visibleCharts[zoomIndex] && (
        <GalleryLightbox
          charts={visibleCharts}
          index={zoomIndex}
          onClose={() => setZoomIndex(null)}
          onNavigate={setZoomIndex}
          onOpenTask={handleOpenTask}
        />
      )}
    </div>
  )
}
