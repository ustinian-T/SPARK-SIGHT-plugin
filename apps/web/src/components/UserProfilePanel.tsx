import { useEffect, useState } from 'react'
import { loadSession, siteApi } from '../site/session'
import { Button } from './common'

type Profile = Record<string, string>
type ProfileResponse = { profile: Profile; revision: number; updatedAt?: number }
const FIELDS = [
  { key: 'experienceLevel', label: '绘图经验', options: [['beginner', '刚开始科研绘图'], ['intermediate', '有一定经验'], ['advanced', '熟悉统计与排版']] },
  { key: 'outputPurpose', label: '常用用途', options: [['paper', '期刊论文'], ['presentation', '汇报展示'], ['exploration', '探索分析'], ['report', '研究报告']] },
  { key: 'labelLanguage', label: '标注语言', options: [['auto', '保留原始字段语言'], ['zh', '中文'], ['en', '英文'], ['bilingual', '中英双语']] },
  { key: 'legendPosition', label: '图例位置', options: [['auto', '自动避让'], ['right', '图外右侧'], ['top', '图外顶部'], ['bottom', '图外底部'], ['inside', '图内右上角']] },
  { key: 'paletteId', label: '常用配色', options: [['nature_lowsat', '科研低饱和（推荐）'], ['okabe_ito', '色盲安全'], ['user_ocean', '青蓝递进（连续量）'], ['brewer_diverging', '蓝红发散（正负变化）'], ['user_garden', '柔和分类（组间比较）'], ['user_nature', '自然低饱和']] },
  { key: 'clarificationMode', label: 'Agent 提问方式', options: [['guided', '逐步引导（推荐）'], ['minimal', '只问关键不确定项'], ['off', '按默认直接分析']] }
]

export function UserProfilePanel({ early = false, onLoaded }: { early?: boolean; onLoaded?: (profile: Profile) => void }) {
  const [profile, setProfile] = useState<Profile>({})
  const [revision, setRevision] = useState<number>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [dirty, setDirty] = useState(false)
  const [reload, setReload] = useState(0)
  const session = loadSession()
  const userId = session?.user.userId
  useEffect(() => {
    const current = loadSession()
    if (!current) { setLoading(false); return }
    let active = true
    setLoading(true)
    siteApi<ProfileResponse>(current.baseUrl, '/api/user-profile', { token: current.token })
      .then(value => {
        if (!active) return
        setProfile(value.profile ?? {}); setRevision(value.revision); setDirty(false); setStatus('')
        onLoaded?.(value.profile ?? {})
      })
      .catch(error => { if (active) setStatus(`偏好加载失败：${error.message}。可继续本次分析，或点击重试。`) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [userId, reload])
  const edit = (key: string, value: string) => { setProfile(current => ({ ...current, [key]: value })); setDirty(true); setStatus('') }
  const save = async () => {
    const current = loadSession()
    if (!current) return
    setSaving(true); setStatus('')
    try {
      const value = await siteApi<ProfileResponse>(current.baseUrl, '/api/user-profile', { token: current.token, method: 'PUT', body: JSON.stringify({ profile, expectedRevision: revision }) })
      setProfile(value.profile); setRevision(value.revision); setDirty(false)
      setStatus('已保存到账号，网页、桌面和 VS Code 使用同一偏好。'); onLoaded?.(value.profile)
    } catch (error) { setStatus(error instanceof Error ? error.message : '保存失败，请重试。') }
    finally { setSaving(false) }
  }
  if (!session) return null
  return <details open={early} style={{ border: '1px solid var(--glass-border)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{early ? '先了解你的偏好（可跳过）' : '账号绘图偏好'}</summary>
    <p style={{ fontSize: 12, color: 'var(--ink-500)' }}>仅在点击保存后同步到账号；本次任务回答独立保存。你可以随时修改或清除偏好。</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
      <label>研究领域<input className="form-control" maxLength={120} placeholder="如：农学、材料、生物" value={profile.researchField ?? ''} disabled={loading || saving} onChange={event => edit('researchField', event.target.value)} /></label>
      {FIELDS.map(field => <label key={field.key}>{field.label}<select className="form-control" aria-label={field.label} disabled={loading || saving} value={profile[field.key] ?? ''} onChange={event => edit(field.key, event.target.value)}>
        <option value="">未指定 / 清除此偏好</option>
        {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>)}
    </div>
    <p style={{ fontSize: 11, color: 'var(--ink-500)' }}>中英文选择只影响显示文字；未知专业术语保留原文，可在任务中提供准确标题与轴标签。</p>
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <Button size="sm" variant="primary" disabled={!dirty || loading || saving || revision === undefined} onClick={() => void save()}>{saving ? '正在保存…' : '保存跨端偏好'}</Button>
      <Button size="sm" variant="ghost" disabled={loading || saving} onClick={() => setReload(value => value + 1)}>重新加载</Button>
      <Button size="sm" variant="ghost" disabled={loading || saving || revision === undefined} onClick={() => { setProfile(Object.fromEntries([...FIELDS.map(field => field.key), 'researchField'].map(key => [key, '']))); setDirty(true); setStatus('点击保存以确认清除账号偏好。') }}>清除偏好</Button>
    </div>
    {loading && <p role="status">正在加载账号偏好…</p>}
    {status && <p role="status" style={{ fontSize: 12 }}>{status}</p>}
  </details>
}
