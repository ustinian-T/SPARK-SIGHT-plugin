import { useState } from 'react'
import { Icon } from './icons'
import type { DataOverview } from '../types'

/**
 * 数据概览卡（v0.4.2 增量 B）
 * 上传 CSV 后、进入澄清轮询前展示数据体检：行列数 / 列类型 / 缺失率 / 数值范围 /
 * 异常值提示 / 前几行预览。仅描述 + 诊断，不改写任何数据（数据包不变）；
 * 异常值只提示，绘图仍使用原始数据。
 */
export function DataOverviewCard({ overview, fileName }: { overview: DataOverview; fileName?: string }) {
  const [expanded, setExpanded] = useState(false)
  const outlierTotal = overview.outliers.reduce((s, o) => s + (o.iqr?.count ?? 0) + (o.sigma3?.count ?? 0), 0)
  const missingTotal = overview.columns.reduce((s, c) => s + (c.missing ?? 0), 0)

  return (
    <div
      style={{
        width: '100%',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--glass-border)',
        background: 'var(--glass-bg)',
        padding: '10px 12px',
        fontSize: 12.5,
        color: 'var(--ink-900)',
        marginBottom: 10
      }}
    >
      {/* 头部：数据体检徽章 + 规模 + 指纹（对应后端 data_profile 步骤） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="badge badge--brand" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="file" size={11} /> 数据概览
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--ink-500)' }}>
          {overview.rows} 行 × {overview.cols} 列
        </span>
        {fileName && <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{fileName}</span>}
        {missingTotal > 0 && (
          <span style={{ fontSize: 11, color: 'var(--warn, #b45309)' }}>缺失 {missingTotal} 个单元格</span>
        )}
        {outlierTotal > 0 && (
          <span style={{ fontSize: 11, color: 'var(--warn, #b45309)' }}>异常值提示 {outlierTotal} 处</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-400)' }}>
          {overview.note ?? '全部行参与统计'}
        </span>
      </div>

      {/* 列体检：类型 / 缺失率 / 唯一值或数值范围 */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, fontSize: 11.5 }}>
        <thead>
          <tr style={{ color: 'var(--ink-500)', textAlign: 'left' }}>
            <th style={{ padding: '3px 6px', fontWeight: 500 }}>列名</th>
            <th style={{ padding: '3px 6px', fontWeight: 500 }}>类型</th>
            <th style={{ padding: '3px 6px', fontWeight: 500, textAlign: 'right' }}>缺失率</th>
            <th style={{ padding: '3px 6px', fontWeight: 500, textAlign: 'right' }}>范围 / 唯一值</th>
          </tr>
        </thead>
        <tbody>
          {overview.columns.map((c) => {
            const numeric = c.type === 'numeric'
            return (
              <tr key={c.name} style={{ borderTop: '1px solid var(--glass-border)' }}>
                <td style={{ padding: '3px 6px', fontWeight: 600 }}>{c.name}</td>
                <td style={{ padding: '3px 6px' }}>
                  <span
                    className={numeric ? 'badge badge--brand' : 'badge badge--muted'}
                    style={{ fontSize: 10.5 }}
                  >
                    {numeric ? '数值' : c.type === 'categorical' ? '类别' : c.type}
                  </span>
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right', color: (c.missingRate ?? 0) > 0.05 ? 'var(--warn, #b45309)' : 'inherit' }}>
                  {((c.missingRate ?? 0) * 100).toFixed(1)}%
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--ink-600)' }}>
                  {numeric
                    ? `${fmtNum(c.min)} ~ ${fmtNum(c.max)}${typeof c.mean === 'number' ? `（均值 ${fmtNum(c.mean)}）` : ''}`
                    : `${c.unique ?? 0} 个取值`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* 异常值提示：仅提示，不改数据 */}
      {overview.outliers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-500)', marginBottom: 4 }}>
            异常值提示（IQR / 3σ，仅提示不改数据）
          </div>
          {overview.outliers.map((o) => (
            <div key={o.column} style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--warn, #b45309)' }}>
              「{o.column}」：IQR 检出 {o.iqr?.count ?? 0} 处
              {o.iqr?.bounds?.[0] != null && o.iqr?.bounds?.[1] != null
                ? `（正常区间 ${fmtNum(o.iqr.bounds[0])} ~ ${fmtNum(o.iqr.bounds[1])}）` : ''}
              ；3σ 检出 {o.sigma3?.count ?? 0} 处
              {o.sigma3?.bounds?.[0] != null && o.sigma3?.bounds?.[1] != null
                ? `（正常区间 ${fmtNum(o.sigma3.bounds[0])} ~ ${fmtNum(o.sigma3.bounds[1])}）` : ''}
            </div>
          ))}
        </div>
      )}

      {/* 前几行预览（可折叠） */}
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
            fontSize: 11, color: 'var(--brand, #2563eb)', display: 'inline-flex', alignItems: 'center', gap: 4
          }}
        >
          <Icon name={expanded ? 'chevronD' : 'chevronR'} size={11} />
          {expanded ? '收起数据预览' : '展开前 5 行数据预览'}
        </button>
        {expanded && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6, fontSize: 11 }}>
            <thead>
              <tr style={{ color: 'var(--ink-500)', textAlign: 'left' }}>
                {overview.preview[0]?.map((_, i) => (
                  <th key={i} style={{ padding: '2px 6px', fontWeight: 500 }}>列 {i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.preview.map((row, ri) => (
                <tr key={ri} style={{ borderTop: '1px solid var(--glass-border)' }}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{ padding: '2px 6px', color: 'var(--ink-600)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1000 || Math.abs(v) < 0.01) return v.toExponential(2)
  return String(Math.round(v * 1000) / 1000)
}
