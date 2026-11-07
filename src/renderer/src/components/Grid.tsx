// Virtualized, editable data grid. Rows are arrays; pending edits/inserts/deletes are overlaid by the parent.
import { type ReactNode, type MouseEvent as RME, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { CellValue } from '@shared/sqlgen'
import { Icon } from './Icon'

export interface GridColumn { name: string; type?: string; pk?: boolean; fk?: boolean; readOnly?: boolean; sub?: string }
export interface Sel { r0: number; c0: number; r1: number; c1: number }
export interface GridPending {
  edits: Map<number, Map<number, CellValue>> // row -> col -> new value
  deleted: Set<number>
  insertedFrom: number // rows at index >= this are new (not yet in the DB)
}
export interface GridHandle { focus: () => void; selection: () => Sel | null; setSelection: (s: Sel) => void; edit: (r: number, c: number) => void; scrollToRow: (r: number) => void }

interface Props {
  columns: GridColumn[]
  rows: unknown[][]
  pending?: GridPending
  editable?: boolean
  sort?: { column: string; dir: 'ASC' | 'DESC' }[]
  widths?: Record<string, number>
  rowOffset?: number
  alternate?: boolean
  onWidths?: (w: Record<string, number>) => void
  onHeaderClick?: (col: string, e: RME) => void
  onHeaderMenu?: (col: string, e: RME) => void
  onEdit?: (r: number, c: number, v: CellValue) => void
  onCellMenu?: (e: RME, r: number, c: number) => void
  onFk?: (r: number, c: number) => void
  onSelect?: (s: Sel | null) => void
  onKey?: (e: React.KeyboardEvent, s: Sel | null) => boolean | void
  onCopy?: (e: ClipboardEvent, s: Sel) => void
  onPaste?: (e: ClipboardEvent, s: Sel | null) => void
  onFocus?: () => void
  onDoubleClickCell?: (r: number, c: number) => boolean | void
  empty?: ReactNode
}

const NUM = /^(small|big|tiny|medium)?int|integer|serial|numeric|decimal|real|double|float|number|^2[0-3]$|^70[01]$|^1700$/i
export const isNumericCol = (c: GridColumn): boolean => !!c.type && NUM.test(c.type)
const valueOf = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? ((v as { raw?: string }).raw ?? JSON.stringify(v)) : String(v))
const norm = (s: Sel): Sel => ({ r0: Math.min(s.r0, s.r1), r1: Math.max(s.r0, s.r1), c0: Math.min(s.c0, s.c1), c1: Math.max(s.c0, s.c1) })

export const Grid = forwardRef<GridHandle, Props>(function Grid(p, ref) {
  const scroller = useRef<HTMLDivElement>(null)
  const [sel, setSelState] = useState<Sel | null>(null)
  const [editing, setEditing] = useState<{ r: number; c: number; v: string } | null>(null)
  const [widths, setWidths] = useState<Record<string, number>>(p.widths ?? {})
  const rowH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--h-row')) || 22
  useEffect(() => setWidths(p.widths ?? {}), [p.widths])

  const colW = useCallback((c: GridColumn, i: number) => {
    if (widths[c.name]) return widths[c.name]
    const sample = p.rows.slice(0, 40).reduce<number>((m, r) => Math.max(m, valueOf(r[i]).length), c.name.length + (c.sub ? 4 : 0))
    return Math.max(70, Math.min(320, sample * 7.4 + 28))
  }, [widths, p.rows])
  const colWidths = useMemo(() => p.columns.map(colW), [p.columns, colW])
  const lefts = useMemo(() => colWidths.reduce<number[]>((a, _w, i) => (a.push(i ? a[i - 1] + colWidths[i - 1] : 0), a), []), [colWidths])
  const numW = Math.max(36, String((p.rowOffset ?? 0) + p.rows.length).length * 8 + 14)
  const total = numW + colWidths.reduce((a, b) => a + b, 0)

  const v = useVirtualizer({ count: p.rows.length, getScrollElement: () => scroller.current, estimateSize: () => rowH, overscan: 24 })

  const setSel = (s: Sel | null): void => { setSelState(s); p.onSelect?.(s ? norm(s) : null) }
  useEffect(() => { if (sel && (sel.r0 >= p.rows.length || sel.r1 >= p.rows.length)) setSel(p.rows.length ? { r0: 0, c0: 0, r1: 0, c1: 0 } : null) }, [p.rows.length])

  const cellValue = (r: number, c: number): unknown => {
    const e = p.pending?.edits.get(r)
    return e?.has(c) ? e.get(c) : p.rows[r]?.[c]
  }

  const scrollToCell = (r: number, c: number): void => {
    v.scrollToIndex(r, { align: 'auto' })
    const el = scroller.current
    if (!el) return
    const x = numW + lefts[c]
    if (x < el.scrollLeft + numW) el.scrollLeft = x - numW
    else if (x + colWidths[c] > el.scrollLeft + el.clientWidth) el.scrollLeft = x + colWidths[c] - el.clientWidth
  }

  const startEdit = (r: number, c: number, initial?: string): void => {
    if (!p.editable || p.columns[c]?.readOnly || p.pending?.deleted.has(r)) return
    if (p.onDoubleClickCell?.(r, c) === true) return
    const cur = cellValue(r, c)
    scrollToCell(r, c)
    setEditing({ r, c, v: initial ?? (cur === null || cur === undefined ? '' : typeof cur === 'object' ? ((cur as { raw?: string }).raw ?? JSON.stringify(cur)) : String(cur)) })
  }

  useImperativeHandle(ref, () => ({
    focus: () => scroller.current?.focus(),
    selection: () => (sel ? norm(sel) : null),
    setSelection: (s) => { setSel(s); scrollToCell(s.r1, s.c1) },
    edit: (r, c) => startEdit(r, c),
    scrollToRow: (r) => v.scrollToIndex(r)
  }))

  const commitEdit = (move?: 'down' | 'right'): void => {
    if (!editing) return
    const old = cellValue(editing.r, editing.c)
    const oldStr = old === null || old === undefined ? null : valueOf(old)
    if (oldStr !== editing.v || old === null) {
      if (!(old === null && editing.v === '')) p.onEdit?.(editing.r, editing.c, editing.v)
    }
    const { r, c } = editing
    setEditing(null)
    scroller.current?.focus()
    if (move === 'down' && r + 1 < p.rows.length) setSel({ r0: r + 1, c0: c, r1: r + 1, c1: c })
    if (move === 'right' && c + 1 < p.columns.length) setSel({ r0: r, c0: c + 1, r1: r, c1: c + 1 })
  }

  // DOM clipboard events reach us through the Edit menu roles.
  useEffect(() => {
    const el = scroller.current!
    const copy = (e: ClipboardEvent): void => { if (document.activeElement === el && sel) { e.preventDefault(); p.onCopy?.(e, norm(sel)) } }
    const paste = (e: ClipboardEvent): void => { if (document.activeElement === el) { e.preventDefault(); p.onPaste?.(e, sel ? norm(sel) : null) } }
    document.addEventListener('copy', copy)
    document.addEventListener('paste', paste)
    return () => { document.removeEventListener('copy', copy); document.removeEventListener('paste', paste) }
  }, [sel, p.onCopy, p.onPaste])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (editing) return
    if (p.onKey?.(e, sel ? norm(sel) : null) === true) { e.preventDefault(); return }
    const n = p.rows.length
    if (!n) return
    const s = sel ?? { r0: 0, c0: 0, r1: 0, c1: 0 }
    const mod = e.metaKey || e.ctrlKey
    const moveTo = (r: number, c: number, extend: boolean): void => {
      r = Math.max(0, Math.min(n - 1, r)); c = Math.max(0, Math.min(p.columns.length - 1, c))
      setSel(extend ? { ...s, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c })
      scrollToCell(r, c)
      e.preventDefault()
    }
    switch (e.key) {
      case 'ArrowDown': return moveTo(mod ? n - 1 : s.r1 + 1, s.c1, e.shiftKey)
      case 'ArrowUp': return moveTo(mod ? 0 : s.r1 - 1, s.c1, e.shiftKey)
      case 'ArrowRight': if (!mod) moveTo(s.r1, s.c1 + 1, e.shiftKey); return
      case 'ArrowLeft': if (!mod) moveTo(s.r1, s.c1 - 1, e.shiftKey); return
      case 'Home': return moveTo(s.r1, 0, e.shiftKey)
      case 'End': return moveTo(s.r1, p.columns.length - 1, e.shiftKey)
      case 'PageDown': return moveTo(s.r1 + Math.floor((scroller.current?.clientHeight ?? 400) / rowH), s.c1, e.shiftKey)
      case 'PageUp': return moveTo(s.r1 - Math.floor((scroller.current?.clientHeight ?? 400) / rowH), s.c1, e.shiftKey)
      case 'Enter': if (!mod && !e.altKey) { e.preventDefault(); startEdit(s.r1, s.c1) } return
      case 'Tab': e.preventDefault(); return moveTo(s.r1, s.c1 + (e.shiftKey ? -1 : 1), false)
      case 'Escape': setSel(null); return
      case 'a': if (mod) { e.preventDefault(); setSel({ r0: 0, c0: 0, r1: n - 1, c1: p.columns.length - 1 }) } return
    }
    if (e.key.length === 1 && !mod && !e.altKey && e.key !== ' ' && p.editable) { e.preventDefault(); startEdit(s.r1, s.c1, e.key) }
  }

  const dragging = useRef(false)
  const ns = sel ? norm(sel) : null
  const rows = v.getVirtualItems()

  return (
    <div
      ref={scroller}
      className="grid"
      tabIndex={0}
      role="grid"
      aria-rowcount={p.rows.length}
      aria-colcount={p.columns.length}
      onKeyDown={onKeyDown}
      onFocus={p.onFocus}
      onMouseUp={() => (dragging.current = false)}
    >
      <div className="grid-head" style={{ width: total }}>
        <div className="grid-hcell" style={{ width: numW, position: 'sticky', left: 0, zIndex: 2, background: 'var(--bg-elev)' }} />
        {p.columns.map((c, i) => {
          const s = p.sort?.find((x) => x.column === c.name)
          return (
            <div
              key={c.name + i}
              className="grid-hcell"
              role="columnheader"
              aria-sort={s ? (s.dir === 'ASC' ? 'ascending' : 'descending') : undefined}
              style={{ width: colWidths[i] }}
              title={c.type ? `${c.name} · ${c.type}` : c.name}
              onClick={(e) => p.onHeaderClick?.(c.name, e)}
              onContextMenu={(e) => { e.preventDefault(); p.onHeaderMenu?.(c.name, e) }}
            >
              {c.pk && <Icon name="key" size={11} className="faint" />}
              <span className="ellipsis">{c.name}</span>
              {c.sub && <span className="sub ellipsis">{c.sub}</span>}
              {s && <span className="faint" style={{ marginLeft: 'auto' }}>{s.dir === 'ASC' ? '▲' : '▼'}{(p.sort?.length ?? 0) > 1 ? p.sort!.indexOf(s) + 1 : ''}</span>}
              <span
                className="rs"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => { e.stopPropagation(); const nw = { ...widths }; delete nw[c.name]; setWidths(nw); p.onWidths?.(nw) }}
                onMouseDown={(e) => {
                  e.preventDefault(); e.stopPropagation()
                  const start = e.clientX
                  const w0 = colWidths[i]
                  let last = widths
                  const move = (ev: MouseEvent): void => { last = { ...widths, [c.name]: Math.max(40, w0 + ev.clientX - start) }; setWidths(last) }
                  const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); p.onWidths?.(last) }
                  window.addEventListener('mousemove', move)
                  window.addEventListener('mouseup', up)
                }}
              />
            </div>
          )
        })}
      </div>
      <div style={{ height: v.getTotalSize(), width: total, position: 'relative' }}>
        {rows.map((vr) => {
          const r = vr.index
          const row = p.rows[r]
          const isNew = p.pending ? r >= p.pending.insertedFrom : false
          const isDel = p.pending?.deleted.has(r)
          const edits = p.pending?.edits.get(r)
          const rowSel = ns && r >= ns.r0 && r <= ns.r1
          return (
            <div key={vr.key} role="row" className={`grid-row ${p.alternate !== false && r % 2 ? 'alt' : ''} ${isNew ? 'new' : ''} ${isDel ? 'del' : ''} ${rowSel ? 'sel' : ''}`} style={{ top: vr.start, width: total }}>
              <div
                className="grid-cell rownum"
                style={{ width: numW }}
                onMouseDown={(e) => { scroller.current?.focus(); setSel(e.shiftKey && sel ? { ...sel, r1: r, c1: p.columns.length - 1 } : { r0: r, c0: 0, r1: r, c1: p.columns.length - 1 }) }}
                onContextMenu={(e) => { if (!rowSel) setSel({ r0: r, c0: 0, r1: r, c1: p.columns.length - 1 }); p.onCellMenu?.(e, r, 0) }}
              >
                {isNew ? '+' : (p.rowOffset ?? 0) + r + 1}
              </div>
              {p.columns.map((c, ci) => {
                const val = edits?.has(ci) ? edits.get(ci) : row?.[ci]
                const inSel = ns && rowSel && ci >= ns.c0 && ci <= ns.c1
                const isFocus = sel && sel.r1 === r && sel.c1 === ci
                const isNull = val === null || val === undefined
                return (
                  <div
                    key={ci}
                    role="gridcell"
                    className={`grid-cell ${isNumericCol(c) ? 'num' : ''} ${edits?.has(ci) ? 'mod' : ''} ${inSel && !(ns!.r0 === ns!.r1 && ns!.c0 === ns!.c1) ? 'csel' : ''} ${isFocus ? 'focus' : ''} ${isNull ? 'null' : ''}`}
                    style={{ width: colWidths[ci] }}
                    onMouseDown={(e) => {
                      if (e.button === 1) return
                      if (e.button === 2 && inSel) return
                      scroller.current?.focus()
                      dragging.current = e.button === 0
                      setSel(e.shiftKey && sel ? { ...sel, r1: r, c1: ci } : { r0: r, c0: ci, r1: r, c1: ci })
                    }}
                    onMouseEnter={() => { if (dragging.current && sel) setSel({ ...sel, r1: r, c1: ci }) }}
                    onDoubleClick={() => startEdit(r, ci)}
                    onContextMenu={(e) => p.onCellMenu?.(e, r, ci)}
                  >
                    {c.fk && !isNull && !isNew && (
                      <button className="fk" title="Open referenced row" aria-label="Open referenced row" onMouseDown={(e) => e.stopPropagation()} onClick={() => p.onFk?.(r, ci)}><Icon name="arrowFk" size={11} /></button>
                    )}
                    <span className="v">{isNull ? 'NULL' : valueOf(val).slice(0, 300)}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
        {editing && (
          <input
            className="grid-editor"
            autoFocus
            aria-label={`Edit ${p.columns[editing.c]?.name}`}
            style={{ top: editing.r * rowH, left: numW + lefts[editing.c], width: Math.max(colWidths[editing.c], 160), height: rowH }}
            value={editing.v}
            onChange={(e) => setEditing({ ...editing, v: e.target.value })}
            onBlur={() => commitEdit()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); commitEdit('down') }
              else if (e.key === 'Tab') { e.preventDefault(); commitEdit('right') }
              else if (e.key === 'Escape') { setEditing(null); scroller.current?.focus() }
            }}
          />
        )}
      </div>
      {!p.rows.length && p.empty && <div className="empty" style={{ position: 'absolute', inset: '40px 0 auto 0' }}>{p.empty}</div>}
    </div>
  )
})
