// 项目切换器（Sidebar 顶部）：下拉选择当前项目、新建项目、重命名当前项目。
// 与后端 /api/projects 系列端点对接；切换项目由 store.selectProject 统一处理（重置任务视图）。
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { Button } from './common'
import { Icon } from './icons'
import { cx } from '../lib/format'

interface ContextMenuState {
  x: number
  y: number
  projectId: string
  projectName: string
  clouded: boolean
}

export function ProjectSwitcher() {
  const { state, createProject, renameProject, selectProject, cloudSyncProject } = useStore()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [cloudBusy, setCloudBusy] = useState(false)
  const [cloudNotice, setCloudNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const current = state.projects.find((p) => p.projectId === state.currentProjectId)

  // 点击组件外部时收起下拉。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 右键菜单：点击任意处 / Esc / 窗口尺寸变化时关闭。
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  // 项目上云：含 300 MB 配额校验与数据镜像；成功后刷新列表并提示。
  const cloudSync = async (menuState: ContextMenuState) => {
    if (cloudBusy) return
    setMenu(null)
    setCloudBusy(true)
    setCloudNotice(null)
    try {
      await cloudSyncProject(menuState.projectId)
      setCloudNotice({ kind: 'ok', text: `「${menuState.projectName}」已上云：数据多端共享，并豁免 7 天保留清除。` })
    } catch (e) {
      setCloudNotice({ kind: 'error', text: e instanceof Error ? e.message : '上云失败，请稍后重试' })
    } finally { setCloudBusy(false) }
  }

  const submitCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError('')
    try {
      await createProject(trimmed, desc.trim() || undefined)
      setCreating(false)
      setName('')
      setDesc('')
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitRename = async () => {
    const trimmed = name.trim()
    if (!trimmed || !current || busy) return
    setBusy(true)
    setError('')
    try {
      await renameProject(current.projectId, trimmed)
      setRenaming(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="project-switch" style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        className="project-switch__trigger"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 11px',
          background: 'var(--glass-bg-strong)',
          border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius)',
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 650,
          color: 'var(--ink-800)',
          textAlign: 'left'
        }}
        onClick={() => setOpen((v) => !v)}
        title="切换项目"
      >
        <Icon name="layers" size={15} style={{ color: 'var(--brand-600)' }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current ? current.name : '选择项目…'}
        </span>
        <Icon name={open ? 'chevronD' : 'chevronR'} size={13} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 30,
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'var(--blur)',
            border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--glass-shadow)',
            padding: 6,
            maxHeight: 320,
            overflowY: 'auto'
          }}
        >
          {state.projects.length === 0 && !creating && (
            <div style={{ padding: '10px 8px', fontSize: 11.5, color: 'var(--ink-500)' }}>
              暂无项目，点击下方“新建项目”开始。
            </div>
          )}

          {state.projects.map((p) => {
            const active = p.projectId === state.currentProjectId
            const clouded = p.cloudEnabled === true || p.cloud?.status === 'synced'
            return (
              <div
                key={p.projectId}
                className={cx('project-item', active && 'is-active')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 9px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  background: active ? 'var(--brand-50, rgba(37,99,235,0.08))' : 'transparent'
                }}
                onClick={() => { if (!active) void selectProject(p.projectId); setOpen(false) }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setOpen(false)
                  setMenu({
                    x: Math.min(e.clientX, window.innerWidth - 190),
                    y: Math.min(e.clientY, window.innerHeight - 130),
                    projectId: p.projectId,
                    projectName: p.name,
                    clouded
                  })
                }}
                title="右键可上云"
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, color: 'var(--ink-800)' }} title={p.name}>
                  {p.name}
                </span>
                {clouded && (
                  <span
                    title="已上云：数据多端共享，豁免 7 天保留清除"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--brand-600, #0a5d5a)', fontWeight: 650 }}
                  >
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ok, #16a34a)', boxShadow: '0 0 5px var(--ok, #16a34a)' }} />
                    云
                  </span>
                )}
                <span className="badge badge--muted" style={{ fontSize: 10 }}>
                  {p.taskCount ?? p.taskIds?.length ?? 0} 任务
                </span>
                {active && (
                  <button
                    type="button"
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-500)', fontSize: 11, padding: 0 }}
                    title="重命名当前项目"
                    onClick={(e) => { e.stopPropagation(); setName(p.name); setRenaming(true); setCreating(false) }}
                  >
                    重命名
                  </button>
                )}
              </div>
            )
          })}

          {renaming && current && (
            <div style={{ padding: '8px 4px', borderTop: '1px solid var(--line)', marginTop: 4 }}>
              <input
                autoFocus
                className="form-control"
                style={{ width: '100%', padding: '5px 8px', fontSize: 12 }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitRename(); if (e.key === 'Escape') setRenaming(false) }}
                placeholder="项目名称"
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <Button size="sm" variant="primary" onClick={() => void submitRename()} disabled={busy}>保存</Button>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>取消</Button>
              </div>
            </div>
          )}

          {creating ? (
            <div style={{ padding: '8px 4px', borderTop: '1px solid var(--line)', marginTop: 4 }}>
              <input
                autoFocus
                className="form-control"
                style={{ width: '100%', padding: '5px 8px', fontSize: 12, marginBottom: 6 }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate() }}
                placeholder="项目名称（必填）"
              />
              <input
                className="form-control"
                style={{ width: '100%', padding: '5px 8px', fontSize: 12, marginBottom: 6 }}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="描述（可选）"
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <Button size="sm" variant="primary" icon="check" onClick={() => void submitCreate()} disabled={busy || !name.trim()}>
                  创建
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setName(''); setDesc(''); setError('') }}>取消</Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              style={{
                width: '100%',
                marginTop: 6,
                padding: '7px 9px',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                border: '1px dashed var(--line)',
                borderRadius: 7,
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--ink-600)'
              }}
              onClick={() => { setCreating(true); setRenaming(false); setName(''); setDesc(''); setError('') }}
            >
              <Icon name="plus" size={13} /> 新建项目
            </button>
          )}

          {error && (
            <div className="inline-alert inline-alert--danger" style={{ marginTop: 6, padding: '6px 8px', fontSize: 11.5 }} role="alert">
              <Icon name="warn" size={12} /> <span>{error}</span>
            </div>
          )}
        </div>
      )}

      {/* 项目右键菜单：上云 / 重命名 */}
      {menu && (
        <div
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: 80,
            minWidth: 176,
            background: 'var(--glass-bg-strong, #fff)',
            backdropFilter: 'var(--blur)',
            border: '1px solid var(--glass-border)',
            borderRadius: 10,
            boxShadow: 'var(--glass-shadow, 0 10px 30px rgba(0,0,0,0.14))',
            padding: 5,
            fontSize: 12.5
          }}
          role="menu"
        >
          <div style={{ padding: '5px 9px 6px', color: 'var(--ink-500)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {menu.projectName}
          </div>
          <button
            type="button"
            role="menuitem"
            disabled={cloudBusy}
            onClick={() => void cloudSync(menu)}
            style={{ width: '100%', textAlign: 'left', padding: '7px 9px', border: 'none', borderRadius: 7, background: 'transparent', cursor: cloudBusy ? 'wait' : 'pointer', fontSize: 12.5, color: 'var(--ink-800)' }}
            title="将项目数据镜像到云端（享 300 MB 独立空间，多端共享，豁免 7 天保留清除）"
          >
            ☁ {menu.clouded ? '重新同步上云' : '上云'}
          </button>
          {current?.projectId === menu.projectId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setMenu(null); setOpen(true); setName(menu.projectName); setRenaming(true) }}
              style={{ width: '100%', textAlign: 'left', padding: '7px 9px', border: 'none', borderRadius: 7, background: 'transparent', cursor: 'pointer', fontSize: 12.5, color: 'var(--ink-800)' }}
            >
              ✎ 重命名
            </button>
          )}
        </div>
      )}

      {/* 上云结果提示 */}
      {cloudNotice && (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 44,
            transform: 'translateX(-50%)',
            zIndex: 90,
            maxWidth: 420,
            padding: '10px 16px',
            borderRadius: 10,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: cloudNotice.kind === 'ok' ? '#063d26' : '#7f1d1d',
            background: cloudNotice.kind === 'ok' ? 'rgba(209,250,229,0.96)' : 'rgba(254,226,226,0.96)',
            border: `1px solid ${cloudNotice.kind === 'ok' ? 'rgba(22,163,74,0.35)' : 'rgba(220,38,38,0.35)'}`,
            boxShadow: '0 12px 32px rgba(0,0,0,0.16)'
          }}
        >
          {cloudNotice.text}
          <button
            type="button"
            onClick={() => setCloudNotice(null)}
            style={{ marginLeft: 10, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 12.5 }}
          >
            知道了
          </button>
        </div>
      )}
    </div>
  )
}
