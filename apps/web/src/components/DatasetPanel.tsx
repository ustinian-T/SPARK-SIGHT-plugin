import { useRef, useState } from 'react'
import { useStore } from '../state/store'
import { Badge, Button, Panel, Tooltip } from './common'
import { Icon } from './icons'
import { fmtBytes, fmtNum, pct, shortHash } from '../lib/format'
import type { ColumnType } from '../types'

const TYPE_LABEL: Record<ColumnType, string> = {
  numeric: '数值',
  categorical: '分类',
  datetime: '时间',
  boolean: '布尔',
  unknown: '未知'
}
const TYPE_TONE: Record<ColumnType, 'brand' | 'info' | 'ok' | 'muted' | 'warn'> = {
  numeric: 'brand',
  categorical: 'info',
  datetime: 'ok',
  boolean: 'muted',
  unknown: 'warn'
}

/** 数据保留说明：与 ChatPanel 的 retentionText 对齐，按真实门禁/部署模式动态展示，不再写死“网页端 24 小时”。 */
function retentionNote(gate: { mode: string; persist: boolean }): string {
  if (gate.persist) return '本地保存，可手动删除。'
  // 远程/网页后端：数据仅在任务期临时处理，删除任务后立即不可达。
  return '任务期在服务端临时处理，删除任务后立即不可达。'
}

function ColumnRow({ index, name, type, inferred, missingRate, unique, min, max, mean, topValues, onType }: {
  index: number
  name: string
  type: ColumnType
  inferred: ColumnType
  missingRate: number
  unique: number
  min?: number
  max?: number
  mean?: number
  topValues?: { value: string; count: number }[]
  onType: (i: number, t: ColumnType) => void
}) {
  const overridden = type !== inferred
  return (
    <div className="colrow">
      <div className="colrow__head">
        <span className="colrow__name" title={name}>{name}</span>
        <select
          className="form-control"
          style={{ width: 78, padding: '2px 4px', fontSize: 10.5 }}
          value={type}
          onChange={(e) => onType(index, e.target.value as ColumnType)}
          title="手动修正列类型（CORE-002）"
        >
          {(['numeric', 'categorical', 'datetime', 'boolean', 'unknown'] as ColumnType[]).map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
      </div>
      <div className="colrow__detail">
        <Badge tone={TYPE_TONE[type]}>{TYPE_LABEL[type]}</Badge>{' '}
        {overridden && <Badge tone="warn">已手动修正（推断：{TYPE_LABEL[inferred]}）</Badge>}
        {'  '}缺失 {pct(missingRate)} · 唯一值 {unique}
      </div>
      <div className="colrow__detail">
        {type === 'numeric' && min !== undefined && max !== undefined
          ? `范围 ${fmtNum(min, 1)} ~ ${fmtNum(max, 1)}；均值 ${fmtNum(mean, 1)}`
          : topValues
            ? `常见值：${topValues.slice(0, 3).map((v) => v.value).join('、')}`
            : '—'}
      </div>
    </div>
  )
}

export function DatasetPanel() {
  const { state, setColType, replaceData, reset } = useStore()
  const ds = state.task?.dataset
  const [showPreview, setShowPreview] = useState(false)
  const replaceRef = useRef<HTMLInputElement>(null)
  if (!ds) {
    return (
      <Panel title="项目与数据" icon="database">
        <div className="empty" style={{ padding: '18px 8px' }}>
          <p>上传 CSV 后，此处展示数据体检与列类型。</p>
        </div>
      </Panel>
    )
  }

  return (
    <Panel
      title="项目与数据"
      icon="database"
      right={<Badge tone="brand">{ds.rows} 行</Badge>}
      bodyClassName="thin-scroll"
    >
      <div className="col-stack">
        <div className="filecard">
          <div className="filecard__name">
            <Icon name="file" size={15} />
            <span title={ds.fileName}>{ds.fileName}</span>
          </div>
          <div style={{ marginTop: 7 }}>
            <Badge tone="muted">{ds.encoding}</Badge> <Badge tone="muted">分隔符 “{ds.delimiter}”</Badge>{' '}
            <Badge tone="muted">{fmtBytes(ds.sizeBytes)}</Badge>
          </div>
          <div className="kv" style={{ marginTop: 6 }}>
            <span className="kv__k">内容指纹</span>
            <span className="kv__v mono" title={ds.fingerprint}>{shortHash(ds.fingerprint, 12)}</span>
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat"><div className="stat__n">{ds.rows}</div><div className="stat__l">数据行</div></div>
          <div className="stat"><div className="stat__n">{ds.cols}</div><div className="stat__l">字段列</div></div>
        </div>

        <Tooltip content={retentionNote(state.gate)} placement="top">
          <div className="notebox notebox--info" style={{ cursor: 'help' }}>
            <Icon name="clock" size={14} />
            <span>数据保留方式见说明</span>
          </div>
        </Tooltip>

        {ds.warnings.length > 0 &&
          ds.warnings.map((w, i) => (
            <div key={i} className="warnline"><Icon name="warn" size={14} /> <span>{w}</span></div>
          ))}

        <div>
          <div style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--ink-600)', margin: '4px 0 6px' }}>
            字段与类型（可手动修正）
          </div>
          <div className="col-stack">
            {ds.columns.map((c) => (
              <ColumnRow
                key={c.index}
                index={c.index}
                name={c.name}
                type={c.userType ?? c.inferredType}
                inferred={c.inferredType}
                missingRate={c.missingRate}
                unique={c.unique}
                min={c.min}
                max={c.max}
                mean={c.mean}
                topValues={c.topValues}
                onType={setColType}
              />
            ))}
          </div>
        </div>

        <div>
          <Button variant="ghost" size="sm" icon={showPreview ? 'chevronD' : 'chevronR'} onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? '收起数据预览' : '查看前 6 行'}
          </Button>
          {showPreview && (
            <div style={{ overflow: 'auto', marginTop: 6, border: '1px solid var(--line)', borderRadius: 8 }}>
              <table className="minitable">
                <thead>
                  <tr>{ds.columns.slice(0, 6).map((c) => <th key={c.index}>{c.name}</th>)}</tr>
                </thead>
                <tbody>
                  {ds.headRows.map((r, i) => (
                    <tr key={i}>
                      {ds.columns.slice(0, 6).map((c) => <td key={c.index}>{r[c.name]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <input ref={replaceRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void replaceData(file).catch((error) => window.alert(error instanceof Error ? error.message : String(error)))
          event.currentTarget.value = ''
        }} />
        <Button variant="soft" size="sm" icon="upload" onClick={() => replaceRef.current?.click()}>替换数据并重算</Button>
        <Button variant="danger" size="sm" icon="trash" onClick={() => { if (window.confirm('删除任务及其数据？删除后原始文件立即不可达。')) reset() }}>
          删除任务与数据
        </Button>
      </div>
    </Panel>
  )
}
