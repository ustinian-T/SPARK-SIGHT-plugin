import type { CSSProperties } from 'react'

export const PALETTE_SWATCHES: Record<string, { label: string; colors: string[] }> = {
  user_ocean: { label: '青蓝递进', colors: ['#DDF2F0', '#D6F6F1', '#A6EBDD', '#88C9D0', '#929ED2', '#5E8CBE', '#3E5682', '#0F1633'] },
  user_garden: { label: '柔和分类', colors: ['#99BC99', '#FFCC99', '#99BBDE', '#B6B6FF', '#136764', '#FFA579', '#3E85C5', '#A2A2FF'] },
  user_nature: { label: '自然低饱和', colors: ['#6E8FB2', '#7DA494', '#EAB67A', '#E5A79A', '#C16E71', '#ABC8E5', '#D8A0C1', '#9F8DB8', '#D0D08A'] },
  user_macaron: { label: '冷暖马卡龙', colors: ['#4C65A4', '#8B8FCA', '#B7AED9', '#E8C1CC', '#FFD7A8', '#F3A683', '#B9786F'] },
  user_pairs: { label: '成对对照', colors: ['#576FA0', '#A7B9D7', '#E3B87F', '#FADCB4', '#B57979', '#DEA3A2', '#9F9F9F', '#CFCECE'] },
  okabe_ito: { label: 'Okabe–Ito', colors: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442', '#000000'] },
  paultol_bright: { label: 'Paul Tol 亮色', colors: ['#4477AA', '#EE6677', '#228833', '#CCBB44', '#66CCEE', '#AA3377', '#BBBBBB'] },
  paultol_muted: { label: 'Paul Tol 柔和', colors: ['#332288', '#88CCEE', '#44AA99', '#117733', '#999933', '#DDCC77', '#CC6677', '#882255', '#AA4499', '#DDDDDD'] },
  ggsci_npg: { label: 'NPG 风格', colors: ['#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F', '#8491B4', '#91D1C2', '#DC0000'] },
  ggsci_nejm: { label: 'NEJM 风格', colors: ['#BC3C29', '#0072B5', '#E18727', '#20854E', '#7876B1', '#6F99AD', '#FFDC91', '#EE4C97'] },
  brewer_diverging: { label: '蓝红发散', colors: ['#2166AC', '#67A9CF', '#D1E5F0', '#F7F7F7', '#FDDBC7', '#EF8A62', '#B2182B'] },
  brewer_sequential: { label: '蓝绿顺序', colors: ['#F7FCFD', '#CCECE6', '#66C2A4', '#238B45', '#005824'] },
  viridis_like: { label: 'Viridis 渐变', colors: ['#440154', '#3B528B', '#21918C', '#5EC962', '#FDE725'] },
  magma_like: { label: 'Magma 渐变', colors: ['#000004', '#51127C', '#B63679', '#FB8861', '#FCFDBF'] }
}

/** A compact swatch key for the existing palette select; preserves control order and behavior. */
export function PaletteSelect({ value, onChange, options, disabled }: {
  value: string
  onChange: (value: string) => void
  options: { id: string; label: string }[]
  disabled?: boolean
}) {
  return <>
    <select className="form-control" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }} aria-label="配色预览色卡">
      {options.filter((option) => PALETTE_SWATCHES[option.id]).map((option) => {
        const selected = option.id === value
        return <button key={option.id} type="button" disabled={disabled} onClick={() => onChange(option.id)} title={option.label}
          aria-label={`选择${option.label}`} aria-pressed={selected}
          style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '3px 5px', borderRadius: 6, border: selected ? '1px solid var(--brand-600)' : '1px solid var(--glass-border)', background: selected ? 'rgba(63,166,114,.08)' : 'transparent', cursor: disabled ? 'default' : 'pointer' } as CSSProperties}>
          {PALETTE_SWATCHES[option.id].colors.map((color, index) => <i key={`${option.id}-${index}`} style={{ width: 9, height: 9, borderRadius: 3, background: color, display: 'block' }} />)}
          <span style={{ fontSize: 9, color: 'var(--ink-500)', marginLeft: 2 }}>{PALETTE_SWATCHES[option.id].label}</span>
        </button>
      })}
    </div>
  </>
}
