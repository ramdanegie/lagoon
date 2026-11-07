import { type ReactNode, useState } from 'react'
import type { CellValue } from '@shared/sqlgen'
import type { GridColumn } from '../components/Grid'
import { Icon } from '../components/Icon'
import { menuBelow } from '../components/ui'
import { fuzzy } from './Sidebar'

const show = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? ((v as { raw?: string }).raw ?? JSON.stringify(v)) : String(v))

/** Right sidebar: the selected row as a form. With several rows selected, an edit writes to all of them. */
export function RowDetail({ columns, rows, readOnly, onSet, nowExpr }: { columns: GridColumn[]; rows: unknown[][]; readOnly?: boolean; onSet: (col: number, v: CellValue) => void; nowExpr: string }): ReactNode {
  const [q, setQ] = useState('')
  if (!rows.length) return <div className="empty">Select a row to see its fields.</div>
  const multi = rows.length > 1
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="row" style={{ padding: 'var(--sp-4)', borderBottom: '1px solid var(--border)' }}>
        <input className="input sm grow" placeholder="Search fields" aria-label="Search fields" value={q} onChange={(e) => setQ(e.target.value)} />
        {multi && <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>{rows.length} rows</span>}
      </div>
      <div className="grow" style={{ overflow: 'auto', padding: 'var(--sp-4)', display: 'grid', gap: 'var(--sp-4)', alignContent: 'start' }}>
        {columns.map((c, i) => {
          if (!fuzzy(c.name, q)) return null
          const vals = rows.map((r) => r[i])
          const same = vals.every((v) => show(v) === show(vals[0]) && (v === null) === (vals[0] === null))
          const v = vals[0]
          const isNull = same && (v === null || v === undefined)
          const text = same ? show(v) : ''
          const long = text.length > 60 || text.includes('\n')
          let json: unknown
          try { json = /^[[{]/.test(text) ? JSON.parse(text) : undefined } catch { json = undefined }
          return (
            <div key={c.name} className="col" style={{ gap: 2 }}>
              <div className="row" style={{ fontSize: 'var(--fs-xs)' }}>
                {c.pk && <Icon name="key" size={10} className="faint" />}
                <label htmlFor={`rd-${i}`} className="ellipsis" style={{ fontWeight: 600 }}>{c.name}</label>
                <span className="faint ellipsis mono">{c.type}</span>
                {!readOnly && !c.readOnly && (
                  <button className="btn ghost icon sm" style={{ marginLeft: 'auto' }} aria-label={`Quick values for ${c.name}`} onClick={(e) => menuBelow(e.currentTarget, [
                    { label: 'NULL', onClick: () => onSet(i, null) },
                    { label: 'Empty string', onClick: () => onSet(i, '') },
                    { label: 'DEFAULT', onClick: () => onSet(i, { raw: 'DEFAULT' }) },
                    { label: nowExpr, onClick: () => onSet(i, { raw: nowExpr }) },
                    ...(json !== undefined ? [{ sep: true }, { label: 'Pretty JSON', onClick: () => onSet(i, JSON.stringify(json, null, 2)) }, { label: 'Minify JSON', onClick: () => onSet(i, JSON.stringify(json)) }] : [])
                  ])}><Icon name="chevronDown" size={10} /></button>
                )}
              </div>
              {long ? (
                <textarea id={`rd-${i}`} className="textarea" rows={Math.min(8, text.split('\n').length + 1)} readOnly={readOnly || c.readOnly} placeholder={isNull ? 'NULL' : multi && !same ? 'Multiple values' : ''} defaultValue={text} key={`${text}-${rows.length}`} onBlur={(e) => e.target.value !== text && onSet(i, e.target.value)} />
              ) : (
                <input id={`rd-${i}`} className="input mono" readOnly={readOnly || c.readOnly} placeholder={isNull ? 'NULL' : multi && !same ? 'Multiple values' : ''} defaultValue={text} key={`${text}-${rows.length}-${isNull}`} onBlur={(e) => e.target.value !== text && !(isNull && e.target.value === '') && onSet(i, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
