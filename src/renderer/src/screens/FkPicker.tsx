// Pick a foreign-key value from the referenced table (first 1000 rows, ordered by the referenced column).
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Column, ForeignKey, Result, TableQuery } from '@shared/types'
import { call, errText } from '../lib/api'
import { display } from '../lib/format'
import { Grid, type GridHandle, type Sel } from '../components/Grid'
import { Modal } from '../components/ui'

const LIMIT = 1000
const TEXTLIKE = /char|text|enum|string/i

export function FkPicker({ sessionId, schema, fk, current, onPick, onClose, onSql }: {
  sessionId: string
  schema: string
  fk: ForeignKey
  current: unknown
  onPick: (v: unknown) => void
  onClose: () => void
  onSql?: (sql: string) => void
}): ReactNode {
  const refSchema = fk.refSchema || schema
  const refCol = fk.refColumns[0]
  const [cols, setCols] = useState<Column[]>([])
  const [extra, setExtra] = useState<string[]>([])
  const [text, setText] = useState('')
  const [filter, setFilter] = useState('')
  const [res, setRes] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Sel | null>(null)
  const grid = useRef<GridHandle>(null)

  useEffect(() => {
    call<Column[]>('db.columns', sessionId, refSchema, fk.refTable).then((c) => {
      setCols(c)
      setExtra(c.filter((x) => x.name !== refCol && TEXTLIKE.test(x.type)).slice(0, 2).map((x) => x.name))
    }, (e) => setError(errText(e)))
  }, [])

  useEffect(() => {
    if (!cols.length) return
    const q: TableQuery = {
      schema: refSchema, table: fk.refTable, join: 'AND', sort: [{ column: refCol, dir: 'ASC' }], limit: LIMIT, offset: 0,
      filters: filter ? [{ id: 'fk', enabled: true, column: '__any__', op: 'Contains', value: filter }] : [],
      columns: [refCol, ...cols.filter((c) => c.name !== refCol && extra.includes(c.name)).map((c) => c.name)]
    }
    let live = true
    call<Result & { sql: string }>('db.rows', sessionId, q, cols.map((c) => ({ name: c.name, type: c.type }))).then((r) => {
      if (!live) return
      setError(null)
      setRes(r)
      onSql?.(r.sql)
      const i = current === null || current === undefined ? -1 : r.rows.findIndex((row) => display(row[0]) === display(current))
      if (r.rows.length) setTimeout(() => grid.current?.setSelection({ r0: Math.max(0, i), c0: 0, r1: Math.max(0, i), c1: 0 }))
    }, (e) => live && setError(errText(e)))
    return () => { live = false }
  }, [cols, extra, filter])

  const pick = (r: number | undefined): void => {
    const row = r === undefined ? undefined : res?.rows[r]
    if (row) onPick(row[0])
  }

  return (
    <Modal
      title={<>Choose <span className="mono">{refCol}</span> from <span className="mono">{fk.refTable}</span></>}
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 'var(--fs-sm)' }}>
            Current: <span className="mono">{current === null || current === undefined ? 'NULL' : display(current)}</span>
            {res && ` · ${res.rows.length.toLocaleString()} row${res.rows.length === 1 ? '' : 's'}${res.rows.length >= LIMIT ? ` (first ${LIMIT})` : ''}`}
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!sel || !res?.rows.length} onClick={() => pick(sel?.r1)}>Choose</button>
        </>
      }
    >
      <input
        className="input"
        placeholder="Filter any column, then press Enter"
        aria-label="Filter referenced rows"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (text !== filter) setFilter(text); else pick(sel?.r1) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); grid.current?.focus() }
        }}
      />
      <div className="row" style={{ alignItems: 'stretch', gap: 'var(--sp-5)', height: 360, minHeight: 0 }}>
        <div className="col" style={{ width: 170, flex: 'none', gap: 'var(--sp-2)', overflow: 'auto' }} aria-label="Columns to show">
          <b style={{ fontSize: 'var(--fs-sm)' }}>Columns</b>
          {cols.map((c) => (
            <label key={c.name} className="check" style={{ fontSize: 'var(--fs-sm)' }}>
              <input type="checkbox" checked={c.name === refCol || extra.includes(c.name)} disabled={c.name === refCol} onChange={(e) => setExtra(e.target.checked ? [...extra, c.name] : extra.filter((x) => x !== c.name))} />
              <span className="ellipsis">{c.name}</span>
            </label>
          ))}
        </div>
        <div className="col grow" style={{ minHeight: 0, minWidth: 0, border: '1px solid var(--border)' }}>
          {error ? <div className="empty danger-text selectable" style={{ whiteSpace: 'pre-wrap' }}>{error}</div> : (
            <Grid
              ref={grid}
              columns={(res?.columns ?? []).map((c) => ({ name: c.name, type: c.type, pk: c.name === refCol }))}
              rows={res?.rows ?? []}
              onSelect={setSel}
              onActivate={(r) => pick(r)}
              onKey={(e, s) => { if (e.key === 'Enter' && s) { pick(s.r1); return true } return false }}
              empty={res ? 'No matching rows.' : 'Loading…'}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}
