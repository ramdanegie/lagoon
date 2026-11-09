// Every table of a schema with its row count and size, sortable: opened by clicking "Tables" in the connection tree.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { TableStat } from '@shared/types'
import { call, errText } from '../lib/api'
import { useWs, openTab, type Tab } from '../lib/ws'
import { Grid } from '../components/Grid'
import { Icon } from '../components/Icon'

const COLS = ['Name', 'Type', 'Rows', 'Data size', 'Index size', 'Total size', 'Comment'] as const
type Col = (typeof COLS)[number]

export const fmtSize = (b: number | null): string => {
  if (b === null) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = b
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return i === 0 ? `${b} B` : `${v.toFixed(1)} ${u[i]}`
}

export function TablesOverview({ tab }: { tab: Tab }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const exactByDefault = useWs((s) => s.dialect) === 'sqlite'
  const [stats, setStats] = useState<TableStat[] | null>(null)
  const [error, setError] = useState('')
  const [exact, setExact] = useState<Record<string, number>>({})
  const [counting, setCounting] = useState<string | null>(null)
  const [sort, setSort] = useState<{ column: Col; dir: 'ASC' | 'DESC' }>({ column: 'Name', dir: 'ASC' })
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = async (): Promise<void> => {
    if (!sessionId) return
    setError('')
    setExact({})
    try { setStats(await call<TableStat[]>('db.tableStats', sessionId, tab.schema ?? '')) } catch (e) { setError(errText(e)) }
  }
  useEffect(() => { void load() }, [sessionId, tab.schema])

  const rowsOf = (t: TableStat): number | null => exact[t.name] ?? t.rows
  const total = (t: TableStat): number | null => (t.data === null && t.index === null ? null : (t.data ?? 0) + (t.index ?? 0))
  const key: Record<Col, (t: TableStat) => string | number | null> = {
    Name: (t) => t.name, Type: (t) => t.kind, Rows: rowsOf, 'Data size': (t) => t.data, 'Index size': (t) => t.index, 'Total size': total, Comment: (t) => t.comment
  }
  const sorted = useMemo(() => {
    const k = key[sort.column]
    const m = sort.dir === 'ASC' ? 1 : -1
    // empty values (views, unknown estimates) always last
    return [...(stats ?? [])].sort((a, b) => {
      const x = k(a), y = k(b)
      if (x === null || x === '') return y === null || y === '' ? 0 : 1
      if (y === null || y === '') return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * m
    })
  }, [stats, exact, sort])

  const estimated = (t: TableStat): boolean => !exactByDefault && exact[t.name] === undefined
  const rows = sorted.map((t) => {
    const n = rowsOf(t)
    return [t.name, t.kind, n === null ? '' : `${estimated(t) ? '~' : ''}${n.toLocaleString()}`, fmtSize(t.data), fmtSize(t.index), fmtSize(total(t)), t.comment ?? '']
  })

  const countExact = async (): Promise<void> => {
    for (const t of sorted.filter((x) => x.kind === 'table')) {
      if (!alive.current) return
      setCounting(t.name)
      try {
        const n = await call<number>('db.count', sessionId, { schema: tab.schema ?? '', table: t.name, filters: [], join: 'AND', sort: [], limit: 0, offset: 0 }, [])
        setExact((e) => ({ ...e, [t.name]: n }))
      } catch { /* keep the estimate for tables we may not read */ }
    }
    setCounting(null)
  }

  const tables = stats?.filter((t) => t.kind !== 'view') ?? []
  const sumRows = tables.reduce((a, t) => a + (rowsOf(t) ?? 0), 0)
  const sumSize = tables.reduce((a, t) => a + (total(t) ?? 0), 0)
  const anyEstimate = tables.some(estimated)

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      {error ? (
        <div className="empty"><div className="danger-text selectable">{error}</div><button className="btn" onClick={() => void load()}>Retry</button></div>
      ) : (
        <Grid
          columns={COLS.map((name) => ({ name, type: name === 'Rows' || name.endsWith('size') ? 'bigint' : 'text' }))}
          rows={rows}
          sort={[sort]}
          onHeaderClick={(column) => setSort((s) => ({ column: column as Col, dir: s.column === column ? (s.dir === 'ASC' ? 'DESC' : 'ASC') : column === 'Name' || column === 'Type' || column === 'Comment' ? 'ASC' : 'DESC' }))}
          onActivate={(r) => { const t = sorted[r]; openTab({ scope: tab.scope, kind: 'table', title: t.name, schema: tab.schema, name: t.name, objKind: t.kind, view: 'data' }) }}
          empty={stats ? 'No tables' : 'Loading…'}
        />
      )}
      <div className="bottombar">
        <button className="btn sm" onClick={() => void load()} title="Reload the list"><Icon name="refresh" size={11} /> Refresh</button>
        {!exactByDefault && (
          <button className="btn sm" disabled={!stats || !!counting} onClick={() => void countExact()} title="Run COUNT(*) on every table. Can take a while on large tables.">
            {counting ? `Counting ${counting}…` : 'Count exact rows'}
          </button>
        )}
        <span className="grow" />
        {stats && (
          <span className="muted" title={anyEstimate ? '~ marks estimates from the database statistics' : undefined}>
            {tables.length} table{tables.length === 1 ? '' : 's'} · {anyEstimate ? '~' : ''}{sumRows.toLocaleString()} rows{sumSize ? ` · ${fmtSize(sumSize)}` : ''} · double-click to open
          </span>
        )}
      </div>
    </div>
  )
}
