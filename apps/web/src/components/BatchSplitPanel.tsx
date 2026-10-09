// 阶段 3：批量上传拆分预览面板（模态）。
// 多文件上传后由后端给出分组建议，用户可拖拽文件在组间移动、编辑组标题、
// 拆分组或删除组，确认后调用 batch/confirm 批量创建任务。
import { useMemo, useRef, useState, type DragEvent } from 'react'
import { useStore } from '../state/store'
import { Button, Badge, Modal, Tooltip } from './common'
import { Icon } from './icons'
import { uid } from '../lib/format'
import type { BatchConfirmGroup, BatchFileItem, BatchGroup } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  files: File[]
}

const DECISION_LABEL: Record<BatchGroup['decision'], string> = {
  auto_merge: '自动合并',
  independent: '独立任务',
  suggest_merge: '建议合并'
}

const DECISION_TONE: Record<BatchGroup['decision'], 'brand' | 'muted' | 'warn'> = {
  auto_merge: 'brand',
  independent: 'muted',
  suggest_merge: 'warn'
}

/** 由 File 对象本地估算行列（后端未返回时兜底展示，不阻塞流程）。 */
async function localProfile(file: File): Promise<{ rows: number; cols: number }> {
  try {
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const cols = lines[0] ? lines[0].split(/[,，\t]/).length : 0
    return { rows: Math.max(0, lines.length - 1), cols }
  } catch {
    return { rows: 0, cols: 0 }
  }
}

export function BatchSplitPanel({ open, onClose, files }: Props) {
  const { requestBatchSplit, confirmBatchSplit } = useStore()
  const [groups, setGroups] = useState<BatchGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  // 拖拽源：{ groupIndex, fileIndex }
  const dragSrc = useRef<{ g: number; f: number } | null>(null)

  // 文件总数（用于底部“将创建 N 个任务”）
  const groupCount = groups.length

  // 打开面板时向后端请求分组建议；本地 Mock 模式下生成模拟分组。
  const loadSuggestion = async () => {
    setLoading(true)
    setError('')
    try {
      let result: { groups: BatchGroup[] }
      try {
        result = await requestBatchSplit(files)
      } catch (e) {
        // 后端不可用：本地模拟分组（每 2 个文件建议合并，其余独立），保证 UI 可走查。
        result = {
          groups: files.map((f, i) => {
            const prof = { rows: 0, cols: 0 }
            return {
              groupId: uid('g'),
              files: [{ fileName: f.name, ...prof }],
              title: f.name.replace(/\.[^.]+$/, ''),
              decision: 'independent' as const,
              suggestMerge: false,
              confidence: 0.8,
              reasons: ['演示模式：本地模拟分组']
            }
          })
        }
      }
      // 对后端未返回 rows/cols 的文件做本地补全展示。
      const enriched: BatchGroup[] = await Promise.all(result.groups.map(async (g) => ({
        ...g,
        files: await Promise.all(g.files.map(async (item) => {
          if (item.rows && item.cols) return item
          const f = files.find((x) => x.name === item.fileName)
          const prof = f ? await localProfile(f) : { rows: 0, cols: 0 }
          return { ...item, ...prof }
        }))
      })))
      setGroups(enriched)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // 面板打开时触发一次建议加载。
  useMemo(() => {
    if (open && files.length > 0 && groups.length === 0 && !loading) void loadSuggestion()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, files])

  // ---- 拖拽逻辑：HTML5 DnD，文件卡片在组间移动 ----
  const onDragStart = (g: number, f: number) => (e: DragEvent) => {
    dragSrc.current = { g, f }
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (e: DragEvent) => e.preventDefault()
  const onDrop = (targetG: number) => (e: DragEvent) => {
    e.preventDefault()
    const src = dragSrc.current
    if (!src || src.g === targetG) return
    setGroups((prev) => {
      const next = prev.map((grp) => ({ ...grp, files: [...grp.files] }))
      const [moved] = next[src.g].files.splice(src.f, 1)
      next[targetG].files.push(moved)
      // 移动后若源组变空则删除该组
      return next.filter((grp) => grp.files.length > 0)
    })
    dragSrc.current = null
  }

  // ---- 组操作：拆分为独立任务 / 删除组 ----
  const splitGroup = (g: number) => {
    setGroups((prev) => {
      const group = prev[g]
      if (group.files.length <= 1) return prev
      const rest: BatchGroup[] = group.files.slice(1).map((file, i) => ({
        ...group,
        groupId: uid('g'),
        files: [file],
        title: file.fileName.replace(/\.[^.]+$/, ''),
        decision: 'independent'
      }))
      const updated = { ...group, files: [group.files[0]], title: group.files[0].fileName.replace(/\.[^.]+$/, ''), decision: 'independent' as const }
      return [...prev.slice(0, g), updated, ...rest, ...prev.slice(g + 1)]
    })
  }

  const removeGroup = (g: number) => {
    setGroups((prev) => prev.filter((_, i) => i !== g))
  }

  const setGroupTitle = (g: number, title: string) => {
    setGroups((prev) => prev.map((grp, i) => (i === g ? { ...grp, title } : grp)))
  }

  // ---- 确认创建 ----
  const handleConfirm = async () => {
    setConfirming(true)
    setError('')
    try {
      const payload: BatchConfirmGroup[] = groups.map((g) => ({
        groupId: g.groupId,
        files: g.files,
        ...(g.title ? { title: g.title } : {})
      }))
      await confirmBatchSplit(payload)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="批量拆分预览" width={720}>
      <div style={{
        background: 'var(--panel-bg, #fff)', borderRadius: 12, display: 'flex',
        flexDirection: 'column', maxHeight: '80vh', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)'
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>批量拆分预览</h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--ink-400)' }}>
            可拖拽文件到组间、编辑组标题，确认后创建任务。
          </p>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {error && (
            <div className="inline-alert inline-alert--danger" role="alert" style={{ marginBottom: 12 }}>
              <Icon name="shield" size={14} /><span>{error}</span>
            </div>
          )}
          {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--ink-400)' }}>正在分析文件结构…</div>}

          {!loading && groups.map((group, gIdx) => (
            <div
              key={group.groupId}
              onDragOver={onDragOver}
              onDrop={onDrop(gIdx)}
              style={{
                border: '1.5px dashed var(--line)', borderRadius: 10,
                padding: 12, marginBottom: 12, background: 'var(--bg-subtle, #fafafa)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <input
                  className="form-control"
                  style={{ flex: 1, fontWeight: 600 }}
                  value={group.title ?? ''}
                  onChange={(e) => setGroupTitle(gIdx, e.target.value)}
                  placeholder="组标题（将作为任务名）"
                />
                <Tooltip content={{ auto_merge: '结构相似，建议合并为一个任务。', independent: '结构独立，分别成任务。', suggest_merge: '建议合并，请确认。' }[group.decision]} placement="top">
                  <Badge tone={DECISION_TONE[group.decision]}>{DECISION_LABEL[group.decision]}</Badge>
                </Tooltip>
                <span style={{ fontSize: 11, color: 'var(--ink-400)' }}>置信度 {Math.round(group.confidence * 100)}%</span>
                <Button size="sm" variant="ghost" onClick={() => splitGroup(gIdx)} title="将组内每个文件拆为独立任务">
                  拆分
                </Button>
                <Button size="sm" variant="ghost" onClick={() => removeGroup(gIdx)} title="删除此组">
                  <Icon name="trash" size={13} />
                </Button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {group.files.map((file: BatchFileItem, fIdx: number) => (
                  <div
                    key={file.fileName}
                    draggable
                    onDragStart={onDragStart(gIdx, fIdx)}
                    style={{
                      background: '#fff', border: '1px solid var(--line)', borderRadius: 8,
                      padding: '6px 10px', cursor: 'grab', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6
                    }}
                  >
                    <Icon name="file" size={12} />
                    <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.fileName}>
                      {file.fileName}
                    </span>
                    {(file.rows && file.cols) ? (
                      <span style={{ color: 'var(--ink-400)' }}>{file.rows}×{file.cols}</span>
                    ) : null}
                  </div>
                ))}
              </div>
              {group.reasons.length > 0 && (
                <div style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--ink-400)' }}>
                  <div>{group.reasons[0]}</div>
                  {group.reasons.length > 1 && (
                    <details style={{ marginTop: 2 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--ink-500)' }}>
                        其余 {group.reasons.length - 1} 条理由
                      </summary>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                        {group.reasons.slice(1).map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{
          padding: '12px 20px', borderTop: '1px solid var(--line)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        }}>
          <span style={{ fontSize: 13, color: 'var(--ink-400)' }}>
            将创建 <b style={{ color: 'var(--ink-700)' }}>{groupCount}</b> 个任务（共 {files.length} 个文件）
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="soft" onClick={onClose} disabled={confirming}>取消</Button>
            <Button variant="primary" icon="check" onClick={() => void handleConfirm()} disabled={confirming || groupCount === 0}>
              {confirming ? '创建中…' : '确认创建'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
