// Find & replace over the rows loaded in the grid. Replacements are staged as normal pending edits.
import { type ReactNode, useState } from 'react'
import type { GridColumn, Sel } from '../components/Grid'
import { display } from '../lib/format'
import { cellMatches, findRegex, replaceCell } from '../lib/gridfind'
import { Icon } from '../components/Icon'

export function GridFind({ columns, rowCount, valueAt, sel, editable, isDeleted, onSelect, onReplace, onClose }: {
  columns: GridColumn[]
  rowCount: number
  valueAt: (r: number, c: number) => unknown
  sel: Sel | null
  editable: boolean
  isDeleted: (r: number) => boolean
  onSelect: (s: Sel) => void
  onReplace: (cells: [number, number, string][]) => void
  onClose: () => void
}): ReactNode {
  const [find, setFind] = useState('')
  const [repl, setRepl] = useState('')
  const [column, setColumn] = useState('') // '' = any column
  const [range, setRange] = useState<Sel | null>(null) // set = "selected cells" scope, captured when chosen
  const [matchCase, setMatchCase] = useState(false)
  const [wholeCell, setWholeCell] = useState(false)
  const [regex, setRegex] = useState(false)
  const [status, setStatus] = useState('')

  const re = findRegex({ find, matchCase, wholeCell, regex })
  const W = columns.length
  const text = (r: number, c: number): string | null => {
    const v = valueAt(r, c)
    return v === null || v === undefined || (typeof v === 'object' && 'raw' in v) ? null : display(v)
  }
  const scoped = (r: number, c: number): boolean =>
    (!column || columns[c]?.name === column) && (!range || (r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1))
  const hits = (): [number, number][] => {
    const out: [number, number][] = []
    if (!re) return out
    for (let r = 0; r < rowCount; r++) for (let c = 0; c < W; c++) {
      if (!scoped(r, c)) continue
      const t = text(r, c)
      if (t !== null && cellMatches(re, t)) out.push([r, c])
    }
    return out
  }
  // key and generated columns are only touched when picked explicitly in the column list
  const canReplace = (r: number, c: number): boolean => editable && !isDeleted(r) && !columns[c].readOnly && (!columns[c].pk || column === columns[c].name)

  const step = (dir: 1 | -1): void => {
    if (!re) { setStatus(find ? 'Invalid pattern' : ''); return }
    const h = hits()
    if (!h.length) { setStatus('No matches'); return }
    const cur = sel ? sel.r0 * W + sel.c0 : dir === 1 ? -1 : Infinity
    let i = -1
    if (dir === 1) i = h.findIndex(([r, c]) => r * W + c > cur)
    else for (let k = h.length - 1; k >= 0 && i < 0; k--) if (h[k][0] * W + h[k][1] < cur) i = k
    if (i < 0) i = dir === 1 ? 0 : h.length - 1
    const [r, c] = h[i]
    onSelect({ r0: r, c0: c, r1: r, c1: c })
    setStatus(`${i + 1} of ${h.length}`)
  }

  const replaceOne = (): void => {
    if (!re) return
    if (sel && sel.r0 === sel.r1 && sel.c0 === sel.c1 && scoped(sel.r0, sel.c0) && canReplace(sel.r0, sel.c0)) {
      const t = text(sel.r0, sel.c0)
      if (t !== null && cellMatches(re, t)) {
        const nv = replaceCell(re, t, repl, regex)
        if (nv !== t) onReplace([[sel.r0, sel.c0, nv]])
      }
    }
    step(1)
  }

  const replaceAll = (): void => {
    if (!re) { setStatus(find ? 'Invalid pattern' : ''); return }
    const out: [number, number, string][] = []
    let skipped = 0
    for (const [r, c] of hits()) {
      if (!canReplace(r, c)) { skipped++; continue }
      const t = text(r, c)!
      const nv = replaceCell(re, t, repl, regex)
      if (nv !== t) out.push([r, c, nv])
    }
    if (out.length) onReplace(out)
    setStatus(`${out.length} cell${out.length === 1 ? '' : 's'} changed${skipped ? ` · ${skipped} skipped (read-only, key or deleted)` : ''}`)
  }

  const esc = (e: React.KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }
  const opt = (label: string, on: boolean, set: (v: boolean) => void): ReactNode => (
    <label className="check" style={{ fontSize: 'var(--fs-xs)' }}><input type="checkbox" checked={on} onChange={(e) => { set(e.target.checked); setStatus('') }} /> {label}</label>
  )

  return (
    <div className="filters" role="search" aria-label="Find and replace in loaded rows">
      <div className="filter-row">
        <Icon name="search" size={12} className="faint" />
        <input
          className="input sm grow mono"
          autoFocus
          placeholder="Find in loaded rows"
          aria-label="Find text"
          value={find}
          onChange={(e) => { setFind(e.target.value); setStatus('') }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) } else esc(e) }}
        />
        <button className="btn sm icon" aria-label="Previous match" title="Previous match (⇧↩)" onClick={() => step(-1)}><Icon name="chevronLeft" size={11} /></button>
        <button className="btn sm icon" aria-label="Next match" title="Next match (↩)" onClick={() => step(1)}><Icon name="chevronRight" size={11} /></button>
        <select className="select sm" aria-label="Column" style={{ maxWidth: 180 }} value={column} onChange={(e) => { setColumn(e.target.value); setStatus('') }}>
          <option value="">Any column</option>
          {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <select className="select sm" aria-label="Scope" value={range ? 'sel' : 'all'} onChange={(e) => { setRange(e.target.value === 'sel' ? sel : null); setStatus('') }}>
          <option value="all">All loaded rows</option>
          <option value="sel" disabled={!sel && !range}>Selected cells</option>
        </select>
        {opt('Match case', matchCase, setMatchCase)}
        {opt('Whole cell', wholeCell, setWholeCell)}
        {opt('Regex', regex, setRegex)}
        <button className="btn sm icon" aria-label="Close find" title="Close (⎋)" onClick={onClose}><Icon name="x" size={10} /></button>
      </div>
      <div className="filter-row">
        <span style={{ width: 12 }} />
        <input
          className="input sm grow mono"
          placeholder={editable ? 'Replace with' : 'Read-only: replacing is unavailable'}
          aria-label="Replace text"
          disabled={!editable}
          value={repl}
          onChange={(e) => setRepl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne() } else esc(e) }}
        />
        <button className="btn sm" disabled={!editable || !re} title="Replace the current match and go to the next" onClick={replaceOne}>Replace</button>
        <button className="btn sm" disabled={!editable || !re} title="Stage replacements for every match" onClick={replaceAll}>Replace All</button>
        <span role="status" style={{ fontSize: 'var(--fs-xs)', minWidth: 80 }}>{status}</span>
        <span className="faint" style={{ fontSize: 'var(--fs-xs)', marginLeft: 'auto' }}>Only the {rowCount.toLocaleString()} rows loaded on this page are searched. Replacements stay pending until you commit.</span>
      </div>
    </div>
  )
}
