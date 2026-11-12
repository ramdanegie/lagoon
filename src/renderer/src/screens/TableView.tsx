import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Column, Filter, FilterOp, ForeignKey, Index, Result, SortSpec, TableQuery } from '@shared/types'
import { countSql, deleteSql, insertSql, updateSql, type CellValue } from '@shared/sqlgen'
import { call, errText, focusScope, setting, toast, useCommands, useSetting } from '../lib/api'
import { useWs, setWs, ws, openTab, registerTabApi, bumpPending, guard, busy, updateTab, type Tab } from '../lib/ws'
import { COPY_FORMATS, formatRows, parseCsv, display } from '../lib/format'
import { pluginMenuItems } from '../lib/plugins'
import { Grid, type GridColumn, type GridHandle, type Sel } from '../components/Grid'
import { Icon } from '../components/Icon'
import { Popover, confirmDialog, menuAt, menuBelow, openMenu, promptDialog, type MenuItem } from '../components/ui'
import { FilterPanel, newFilter } from './Filters'
import { RowDetail } from './RowDetail'
import { QuickLook } from './QuickLook'
import { Structure, type StructureApi } from './Structure'
import { ExportResultDialog } from './ImportExport'
import { openTool } from './Tools'
import { ColumnStats } from './ColumnStats'
import { FkPicker } from './FkPicker'
import { GridFind } from './GridFind'
import { deleteProfile, profilesKey, renameProfile, saveProfile, type ProfileMap, type TableProfile } from '../lib/profiles'

interface Snapshot { edits: Map<number, Map<number, CellValue>>; deleted: Set<number>; inserted: unknown[][] }
const cloneSnap = (s: Snapshot): Snapshot => ({ edits: new Map([...s.edits].map(([k, v]) => [k, new Map(v)])), deleted: new Set(s.deleted), inserted: s.inserted.map((r) => [...r]) })

interface SavedState { filters?: Filter[]; applied?: Filter[]; join?: 'AND' | 'OR'; visible?: string[] | null; widths?: Record<string, number>; sort?: SortSpec[]; showFilters?: boolean }

const BINARY = /bytea|blob|binary/i

export function TableView({ tab }: { tab: Tab }): ReactNode {
  const s = useWs()
  const d = s.dialect!
  const schema = tab.schema ?? ''
  const name = tab.name ?? ''
  const stateKey = `${s.database ?? ''}.${schema}.${name}`
  const isView = tab.objKind === 'view' || tab.objKind === 'matview'
  const [pageSize] = useSetting('table.pageSize', 300)
  const [estimateOver] = useSetting('table.estimateOver', 500000)
  const [alternate] = useSetting('table.alternate', true)

  const [cols, setCols] = useState<Column[]>([])
  const [fks, setFks] = useState<ForeignKey[]>([])
  const [keyCols, setKeyCols] = useState<string[]>([])
  const [keyUnique, setKeyUnique] = useState(true)
  const [resCols, setResCols] = useState<string[]>([])
  const [base, setBase] = useState<unknown[][]>([])
  const [snap, setSnap] = useState<Snapshot>({ edits: new Map(), deleted: new Set(), inserted: [] })
  const undo = useRef<Snapshot[]>([])
  const redo = useRef<Snapshot[]>([])
  const [filters, setFilters] = useState<Filter[]>([])
  const [applied, setApplied] = useState<Filter[]>([])
  const [join, setJoin] = useState<'AND' | 'OR'>('AND')
  const [showFilters, setShowFilters] = useState(false)
  const [sort, setSort] = useState<SortSpec[]>([])
  const [visible, setVisible] = useState<string[] | null>(null)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [offset, setOffset] = useState(0)
  const [count, setCount] = useState<{ n: number; estimated: boolean } | null>(null)
  const [sel, setSel] = useState<Sel | null>(null)
  const [loading, setLoading] = useState(true)
  const [unseen, setUnseen] = useState<number | null>(null) // statistics' row estimate when the first page came back empty
  const [error, setError] = useState<string | null>(null)
  const [lastSql, setLastSql] = useState('')
  const [quick, setQuick] = useState<{ r: number; c: number } | null>(null)
  const [pop, setPop] = useState<{ kind: 'columns' | 'page'; el: HTMLElement } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [ready, setReady] = useState(false)
  const [picker, setPicker] = useState<{ fk: ForeignKey; r: number; c: number; rows: number[] } | null>(null)
  const [finding, setFinding] = useState(false)
  const [hist, setHist] = useState<{ at: number; sql: string }[]>([])
  const [showHist, setShowHist] = useState(false)
  const [profiles, setProfiles] = useSetting<ProfileMap>(profilesKey(s.conn?.id ?? ''), {})
  // shortcut: keeps the last 500 statements per tab, raise if users need longer sessions
  const logSql = useCallback((...sql: string[]) => setHist((h) => [...h, ...sql.map((x) => ({ at: Date.now(), sql: x }))].slice(-500)), [])
  const view = tab.isNew ? 'structure' : tab.view ?? 'data'
  const grid = useRef<GridHandle>(null)
  const structApi = useRef<StructureApi | null>(null)

  // ---------- metadata ----------
  const loadMeta = useCallback(async () => {
    if (tab.isNew) return
    const [c, f, ix] = await Promise.all([
      call<Column[]>('db.columns', s.sessionId, schema, name),
      call<ForeignKey[]>('db.fks', s.sessionId, schema, name).catch(() => []),
      call<Index[]>('db.indexes', s.sessionId, schema, name).catch(() => [])
    ])
    setCols(c)
    setFks(f)
    const pk = c.filter((x) => x.pk).map((x) => x.name)
    const uq = ix.find((i) => i.unique && i.columns.every((n) => c.find((x) => x.name === n && !x.nullable)))
    const k = pk.length ? pk : uq ? uq.columns : []
    setKeyCols(k)
    setKeyUnique(k.length > 0)
    return c
  }, [s.sessionId, schema, name, tab.isNew])

  // restore saved table state once
  useEffect(() => {
    if (tab.isNew) { setReady(true); setLoading(false); return }
    void (async () => {
      try {
        const c = await loadMeta()
        const st = (await call<SavedState | undefined>('tableState.get', s.conn!.id, stateKey)) ?? {}
        const defCol = setting('filter.defaultColumn', 'pk')
        const defOp = setting('filter.defaultOp', '=')
        const fstate: string = setting('filter.state', 'remember')
        if (tab.initialFilter) {
          const f: Filter = { id: crypto.randomUUID(), enabled: true, column: tab.initialFilter.column, op: tab.initialFilter.op as FilterOp, value: tab.initialFilter.value }
          setFilters([f]); setApplied([f]); setShowFilters(true)
        } else {
          setFilters(st.filters?.length ? st.filters : [newFilter(c ?? [], defCol, defOp)])
          setApplied(fstate === 'remember' ? st.applied ?? [] : [])
          setShowFilters(fstate === 'show' ? true : fstate === 'hide' ? false : !!st.showFilters)
        }
        setJoin(st.join ?? 'AND')
        setVisible(st.visible ?? null)
        setWidths(st.widths ?? {})
        const defSort = setting('table.defaultSort', 'none')
        const pk = (c ?? []).find((x) => x.pk)?.name
        setSort(st.sort ?? (pk && defSort !== 'none' ? [{ column: pk, dir: defSort === 'pkDesc' ? 'DESC' : 'ASC' }] : []))
      } catch (e) { setError(errText(e)) }
      setReady(true)
    })()
  }, [])

  const saveState = (patch: SavedState): void => {
    const st: SavedState = { filters, applied, join, visible, widths, sort, showFilters, ...patch }
    void call('tableState.set', s.conn!.id, stateKey, st)
  }

  const query = (): TableQuery => ({
    schema, table: name, filters: applied, join, sort, limit: pageSize, offset,
    columns: visible ? [...new Set([...visible, ...keyCols])] : undefined
  })

  const colTypes = (): { name: string; type: string }[] => cols.map((c) => ({ name: c.name, type: c.type }))

  const load = useCallback(async () => {
    if (!ready || tab.isNew || view !== 'data') return
    setLoading(true)
    setError(null)
    try {
      const r = await busy(call<Result & { sql: string }>('db.rows', s.sessionId, query(), colTypes()))
      setResCols(r.columns.map((c) => c.name))
      setBase(r.rows)
      setLastSql(r.sql)
      logSql(r.sql)
      setSnap({ edits: new Map(), deleted: new Set(), inserted: [] })
      undo.current = []
      redo.current = []
      bumpPending()
      // counting: a short page is the last one; else estimate for big unfiltered tables, exact otherwise
      const filtered = applied.some((f) => f.enabled)
      const est = filtered || isView ? null : await call<number | null>('db.estimate', s.sessionId, schema, name).catch(() => null)
      setUnseen(!r.rows.length && !offset && est ? est : null)
      if (r.rows.length < pageSize) setCount({ n: offset + r.rows.length, estimated: false })
      else if (est !== null && estimateOver > 0 && est > estimateOver) setCount({ n: est, estimated: true })
      else { logSql(countSql(d, query(), colTypes())); setCount({ n: await call<number>('db.count', s.sessionId, query(), colTypes()), estimated: false }) }
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [ready, view, applied, join, sort, offset, visible, keyCols, cols, pageSize])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const h = (): void => { void loadMeta().then(() => load()) }
    window.addEventListener('ws:reload', h)
    return () => window.removeEventListener('ws:reload', h)
  }, [load, loadMeta])

  // ---------- derived ----------
  const rows = useMemo(() => [...base, ...snap.inserted], [base, snap.inserted])
  const colIndex = (n: string): number => resCols.indexOf(n)
  const meta = (n: string): Column | undefined => cols.find((c) => c.name === n)
  const fkCols = new Set(fks.flatMap((f) => (f.columns.length === 1 ? f.columns : [])))
  const editable = !isView && (keyUnique || d === 'mysql') && !loading
  const gridCols: GridColumn[] = resCols.map((n) => ({ name: n, type: meta(n)?.type, pk: meta(n)?.pk, fk: fkCols.has(n), readOnly: meta(n)?.extra === 'generated' }))
  const types = Object.fromEntries(cols.map((c) => [c.name, c.type]))

  const pendingCount = (): number => {
    let n = snap.deleted.size + snap.inserted.filter((_, i) => !snap.deleted.has(base.length + i)).length
    for (const [r] of snap.edits) if (r < base.length && !snap.deleted.has(r)) n++
    return n
  }

  const keyFor = (r: number): Record<string, CellValue> => {
    const ks = keyCols.length ? keyCols : resCols
    return Object.fromEntries(ks.map((k) => [k, (base[r][colIndex(k)] ?? null) as CellValue]))
  }

  const dataSql = (): string[] => {
    const out: string[] = []
    for (const [r, m] of snap.edits) {
      if (r >= base.length || snap.deleted.has(r)) continue
      out.push(updateSql(d, schema, name, keyFor(r), Object.fromEntries([...m].map(([c, v]) => [resCols[c], v])), types, keyUnique))
    }
    for (const r of [...snap.deleted].sort((a, b) => a - b)) if (r < base.length) out.push(deleteSql(d, schema, name, keyFor(r), types, keyUnique))
    snap.inserted.forEach((_, i) => {
      const r = base.length + i
      if (snap.deleted.has(r)) return
      const m = snap.edits.get(r) ?? new Map()
      out.push(insertSql(d, schema, name, Object.fromEntries([...m].map(([c, v]) => [resCols[c], v])), types))
    })
    return out
  }

  const commitData = async (): Promise<boolean> => {
    const stmts = dataSql()
    if (!stmts.length) return true
    if (!(await guard(stmts))) return false
    const r = await busy(call<{ ok: boolean; index?: number; error?: string }>('db.commit', s.sessionId, stmts))
    logSql(...(r.ok ? stmts : [...stmts.slice(0, (r.index ?? 0) + 1), `-- failed and rolled back: ${r.error}`]))
    if (!r.ok) { toast(`Commit failed at statement ${(r.index ?? 0) + 1}:\n${r.error}\n\n${stmts[r.index ?? 0]}`, 'error', 12000); return false }
    toast(`${stmts.length} change${stmts.length > 1 ? 's' : ''} committed`, 'success')
    await load()
    return true
  }

  // ---------- tab api (toolbar + ⌘S) ----------
  const apiRef = useRef({ pendingCount, previewSql: (): string[] => [], commit: async () => true, discard: () => {} })
  apiRef.current = {
    pendingCount: () => pendingCount() + (structApi.current?.pendingCount() ?? 0),
    previewSql: () => [...(structApi.current?.previewSql() ?? []), ...dataSql()],
    commit: async () => {
      if (structApi.current?.pendingCount()) { if (!(await structApi.current.commit())) return false }
      return commitData()
    },
    discard: () => { structApi.current?.discard(); setSnap({ edits: new Map(), deleted: new Set(), inserted: [] }); undo.current = []; bumpPending() }
  }
  useEffect(() => {
    registerTabApi(tab.id, { pendingCount: () => apiRef.current.pendingCount(), previewSql: () => apiRef.current.previewSql(), commit: () => apiRef.current.commit(), discard: () => apiRef.current.discard() })
    return () => registerTabApi(tab.id, null)
  }, [tab.id])

  const mutate = (fn: (x: Snapshot) => void): void => {
    undo.current.push(cloneSnap(snap))
    redo.current = []
    const next = cloneSnap(snap)
    fn(next)
    setSnap(next)
    if (tab.preview) updateTab(tab.id, { preview: false })
    setTimeout(bumpPending)
  }

  const setCells = (cells: [number, number, CellValue][]): void => mutate((x) => {
    for (const [r, c, v] of cells) {
      const m = x.edits.get(r) ?? new Map()
      const orig = r < base.length ? base[r][c] : undefined
      if (r < base.length && typeof v !== 'object' && v !== null && String(orig ?? '') === v && orig !== null) m.delete(c)
      else m.set(c, v)
      if (m.size) x.edits.set(r, m); else x.edits.delete(r)
    }
  })
  const setCell = (r: number, c: number, v: CellValue): void => setCells([[r, c, v]])

  const selectedRows = (): number[] => (sel ? Array.from({ length: sel.r1 - sel.r0 + 1 }, (_, i) => sel.r0 + i) : [])
  const valueAt = (r: number, c: number): unknown => (snap.edits.get(r)?.has(c) ? snap.edits.get(r)!.get(c) : rows[r]?.[c])
  const rowValues = (r: number): unknown[] => resCols.map((_, c) => valueAt(r, c))

  const addRow = (values?: unknown[]): void => {
    mutate((x) => {
      x.inserted.push(resCols.map(() => null))
      if (values) {
        const r = base.length + x.inserted.length - 1
        x.edits.set(r, new Map(values.map((v, c) => [c, v as CellValue]).filter(([, v]) => v !== null && v !== undefined) as [number, CellValue][]))
      }
    })
    setTimeout(() => { const r = rows.length; grid.current?.setSelection({ r0: r, c0: 0, r1: r, c1: 0 }) }, 30)
  }

  const duplicate = (): void => {
    const rs = selectedRows()
    if (!rs.length) return
    mutate((x) => {
      for (const r of rs) {
        x.inserted.push(resCols.map(() => null))
        const nr = base.length + x.inserted.length - 1
        const m = new Map<number, CellValue>()
        resCols.forEach((cn, c) => { const v = valueAt(r, c); if (!meta(cn)?.pk && meta(cn)?.extra !== 'generated' && v !== null) m.set(c, v as CellValue) })
        x.edits.set(nr, m)
      }
    })
  }

  const toggleDelete = (): void => {
    const rs = selectedRows()
    if (!rs.length || !editable) return
    mutate((x) => {
      const all = rs.every((r) => x.deleted.has(r))
      rs.forEach((r) => (all ? x.deleted.delete(r) : x.deleted.add(r)))
    })
  }

  const doUndo = (): void => { const p = undo.current.pop(); if (p) { redo.current.push(cloneSnap(snap)); setSnap(p); setTimeout(bumpPending) } }
  const doRedo = (): void => { const n = redo.current.pop(); if (n) { undo.current.push(cloneSnap(snap)); setSnap(n); setTimeout(bumpPending) } }

  const applyFilters = (f: Filter[], j: 'AND' | 'OR'): void => {
    setFilters(f.length ? f : filters)
    setApplied(f)
    setJoin(j)
    setOffset(0)
    saveState({ filters: f.length ? f : filters, applied: f, join: j })
  }

  const headerClick = (col: string): void => {
    const cur = sort.find((x) => x.column === col)
    const next: SortSpec[] = !cur ? [{ column: col, dir: 'DESC' }] : cur.dir === 'DESC' ? [{ column: col, dir: 'ASC' }] : []
    setSort(next); setOffset(0); saveState({ sort: next })
  }

  const copyRows = (fmt: Parameters<typeof formatRows>[0], cellsOnly = false): void => {
    if (!sel) return
    const rs = selectedRows()
    const cs = cellsOnly ? resCols.slice(sel.c0, sel.c1 + 1) : resCols
    const data = rs.map((r) => (cellsOnly ? rowValues(r).slice(sel.c0, sel.c1 + 1) : rowValues(r)))
    void navigator.clipboard.writeText(formatRows(fmt, cs, data, { dialect: d, schema, table: name }))
  }

  const pasteRows = (text: string): void => {
    if (!editable) return
    const parsed = parseCsv(text.replace(/\n$/, ''), setting('csv.delimiter', ',') === ',' && text.includes('\t') ? '\t' : undefined)
    if (!parsed.length) return
    const header = parsed[0].every((h) => resCols.includes(h)) ? parsed.shift()! : null
    mutate((x) => {
      for (const p of parsed) {
        x.inserted.push(resCols.map(() => null))
        const r = base.length + x.inserted.length - 1
        const m = new Map<number, CellValue>()
        p.forEach((v, i) => {
          const c = header ? resCols.indexOf(header[i]) : i
          if (c >= 0 && c < resCols.length && v !== 'NULL') m.set(c, v)
        })
        x.edits.set(r, m)
      }
    })
    toast(`${parsed.length} row(s) pasted as new rows`)
  }

  const pasteCells = async (): Promise<void> => {
    if (!sel || !editable) return
    const data = parseCsv((await navigator.clipboard.readText()).replace(/\n$/, ''), '\t')
    if (!data.length) return
    const h = Math.max(sel.r1 - sel.r0 + 1, data.length)
    const w = Math.max(sel.c1 - sel.c0 + 1, data[0].length)
    mutate((x) => {
      for (let i = 0; i < h && sel.r0 + i < rows.length; i++) for (let j = 0; j < w && sel.c0 + j < resCols.length; j++) {
        const r = sel.r0 + i
        const c = sel.c0 + j
        const v = data[i % data.length][j % data[0].length]
        const m = x.edits.get(r) ?? new Map()
        m.set(c, v === 'NULL' ? null : v)
        x.edits.set(r, m)
      }
    })
  }

  const followFk = (r: number, c: number): void => {
    const col = resCols[c]
    const fk = fks.find((f) => f.columns.length === 1 && f.columns[0] === col)
    if (!fk) return
    openTab({ kind: 'table', title: fk.refTable, schema: fk.refSchema || schema, name: fk.refTable, objKind: 'table', initialFilter: { column: fk.refColumns[0], op: '=', value: String(valueAt(r, c)) } }, { newTab: true })
  }

  const fkOf = (c: number): ForeignKey | undefined => fks.find((f) => f.columns.length === 1 && f.columns[0] === resCols[c])
  const openPicker = (r: number, c: number): void => {
    const fk = fkOf(c)
    if (!fk || !editable || snap.deleted.has(r)) return
    setPicker({ fk, r, c, rows: sel && r >= sel.r0 && r <= sel.r1 ? selectedRows() : [r] })
  }

  const setValueMenu = (r: number, c: number): MenuItem[] => {
    const t = meta(resCols[c])?.type ?? ''
    const rs = sel && r >= sel.r0 && r <= sel.r1 ? selectedRows() : [r]
    const all = (v: CellValue): void => mutate((x) => rs.forEach((rr) => { const m = x.edits.get(rr) ?? new Map(); m.set(c, v); x.edits.set(rr, m) }))
    const fk = fkOf(c)
    return [
      ...(fk ? [{ label: `Choose from ${fk.refTable}…`, kbd: '⇧⌘↩', onClick: () => openPicker(r, c) }, { sep: true }] : []),
      { label: 'NULL', onClick: () => all(null) },
      { label: 'Empty string', onClick: () => all('') },
      { label: 'DEFAULT', onClick: () => all({ raw: 'DEFAULT' }) },
      { label: 'CURRENT_TIMESTAMP', onClick: () => all({ raw: 'CURRENT_TIMESTAMP' }) },
      { label: 'Date…', onClick: async () => { const v = await promptDialog('Date / time value', new Date().toISOString().slice(0, 19).replace('T', ' ')); if (v !== null) all(v) } },
      { label: 'From File…', onClick: async () => {
        const [f] = await call<string[]>('dialog.open', { properties: ['openFile'] })
        if (!f) return
        if (BINARY.test(t)) {
          const b64 = await call<string>('file.readBase64', f)
          const hex = Array.from(atob(b64), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
          all({ raw: d === 'postgres' ? `'\\x${hex}'::bytea` : `X'${hex}'` })
        } else all(await call<string>('file.read', f))
      } }
    ]
  }

  const cellMenu = (e: React.MouseEvent, r: number, c: number): void => {
    const v = valueAt(r, c)
    const col = resCols[c]
    const lit = v === null || v === undefined ? null : display(v)
    const items: MenuItem[] = [
      ...(editable ? [{ label: 'Set Value', submenu: setValueMenu(r, c) }] : []),
      { label: 'Quick Look', kbd: '⌘↩', onClick: () => setQuick({ r, c }) },
      { sep: true },
      { label: 'Copy Rows', kbd: '⌘C', onClick: () => copyRows('csv') },
      { label: 'Copy Rows As', submenu: COPY_FORMATS.map((f) => ({ label: f.label, onClick: () => copyRows(f.id) })) },
      { label: 'Copy Selected Cells', kbd: '⇧⌘C', onClick: () => copyRows('plain', true) },
      { label: 'Copy Selected Cells As', submenu: COPY_FORMATS.filter((f) => f.id !== 'insert').map((f) => ({ label: f.label, onClick: () => copyRows(f.id, true) })) },
      { label: 'Copy Column Values', onClick: () => void navigator.clipboard.writeText(rows.map((_, rr) => display(valueAt(rr, c))).join('\n')) },
      { sep: true },
      { label: 'Quick Filter', submenu: [
        { label: lit === null ? `${col} IS NULL` : `${col} = ${lit.slice(0, 40)}`, onClick: () => applyFilters([{ id: crypto.randomUUID(), enabled: true, column: col, op: lit === null ? 'IS NULL' : '=', value: lit ?? '' }], 'AND') },
        { label: 'Contains…', onClick: () => applyFilters([{ id: crypto.randomUUID(), enabled: true, column: col, op: 'Contains', value: lit ?? '' }], 'AND') },
        { label: 'Has prefix…', onClick: () => applyFilters([{ id: crypto.randomUUID(), enabled: true, column: col, op: 'Has prefix', value: lit ?? '' }], 'AND') },
        { label: 'IN selected values', onClick: () => applyFilters([{ id: crypto.randomUUID(), enabled: true, column: col, op: 'IN', value: [...new Set(selectedRows().map((rr) => display(valueAt(rr, c))))].join(', ') }], 'AND') },
        { label: 'IS NULL', onClick: () => applyFilters([{ id: crypto.randomUUID(), enabled: true, column: col, op: 'IS NULL', value: '' }], 'AND') }
      ] },
      { label: 'Sort', submenu: [
        { label: 'Ascending', onClick: () => { const n: SortSpec[] = [{ column: col, dir: 'ASC' }]; setSort(n); saveState({ sort: n }) } },
        { label: 'Descending', onClick: () => { const n: SortSpec[] = [{ column: col, dir: 'DESC' }]; setSort(n); saveState({ sort: n }) } },
        { label: 'Remove Sort', onClick: () => { setSort([]); saveState({ sort: [] }) } }
      ] },
      ...(fkCols.has(col) && lit !== null ? [{ label: 'Open Referenced Row', onClick: () => followFk(r, c) }] : []),
      ...(fkCols.has(col) && editable ? [{ label: `Choose from ${fkOf(c)?.refTable}…`, kbd: '⇧⌘↩', onClick: () => openPicker(r, c) }] : []),
      { label: 'Find & Replace…', onClick: () => setFinding(true) },
      { sep: true },
      ...(editable ? [
        { label: 'Add Row', kbd: '⌘I', onClick: () => addRow() },
        { label: 'Duplicate', kbd: '⌘D', onClick: duplicate },
        { label: 'Paste Rows', kbd: '⌘V', onClick: async () => pasteRows(await navigator.clipboard.readText()) },
        { label: 'Paste to Selected Cells', kbd: '⇧⌘V', onClick: () => void pasteCells() },
        { label: snap.deleted.has(r) ? 'Restore' : 'Delete', kbd: '⌫', onClick: toggleDelete },
        { sep: true }
      ] : []),
      { label: 'Refresh', onClick: () => void load() },
      { label: 'Export Current Page…', onClick: () => setExporting(true) },
      ...pluginMenuItems('cell', () => ({
        table: { schema, name, kind: tab.objKind ?? 'table' }, column: col, value: v, sessionId: s.sessionId,
        row: Object.fromEntries(resCols.map((n, i) => [n, valueAt(r, i)])),
        rows: selectedRows().map((rr) => Object.fromEntries(resCols.map((n, i) => [n, valueAt(rr, i)]))),
        setValue: editable ? (nv: string | null) => setCell(r, c, nv) : undefined
      }))
    ]
    menuAt(e, items)
  }

  const headerMenu = (col: string, e: React.MouseEvent): void => menuAt(e, [
    { label: 'Sort Ascending', onClick: () => { const n: SortSpec[] = [{ column: col, dir: 'ASC' }]; setSort(n); saveState({ sort: n }) } },
    { label: 'Sort Descending', onClick: () => { const n: SortSpec[] = [{ column: col, dir: 'DESC' }]; setSort(n); saveState({ sort: n }) } },
    { label: 'Add to Sort', submenu: [{ label: 'Ascending', onClick: () => { const n = [...sort.filter((x) => x.column !== col), { column: col, dir: 'ASC' as const }]; setSort(n); saveState({ sort: n }) } }, { label: 'Descending', onClick: () => { const n = [...sort.filter((x) => x.column !== col), { column: col, dir: 'DESC' as const }]; setSort(n); saveState({ sort: n }) } }] },
    { label: 'Remove Sort', disabled: !sort.length, onClick: () => { setSort([]); saveState({ sort: [] }) } },
    { sep: true },
    { label: 'Filter by This Column', onClick: () => { const f = { ...newFilter(cols, 'pk', setting('filter.defaultOp', '=')), column: col }; setFilters([f, ...filters.filter((x) => x.value)]); setShowFilters(true) } },
    { label: 'Hide Column', onClick: () => { const v = (visible ?? resCols).filter((x) => x !== col); setVisible(v); saveState({ visible: v }) } },
    { label: 'Show All Columns', disabled: !visible, onClick: () => { setVisible(null); saveState({ visible: null }) } },
    { label: 'Copy Column Name', onClick: () => void navigator.clipboard.writeText(col) }
  ])

  // ---------- profiles ----------
  const tableProfiles = profiles[stateKey] ?? []
  const applyProfile = (p: TableProfile): void => {
    const has = (n: string): boolean => cols.some((c) => c.name === n)
    const f = p.filters.length ? p.filters : [newFilter(cols, setting('filter.defaultColumn', 'pk'), setting('filter.defaultOp', '='))]
    const v = p.visible ? p.visible.filter(has) : null
    const so = p.sort.filter((x) => has(x.column))
    const show = p.applied.some((x) => x.enabled) || showFilters
    setFilters(f); setApplied(p.applied); setJoin(p.join); setSort(so); setVisible(v); setWidths(p.widths); setOffset(0); setShowFilters(show)
    saveState({ filters: f, applied: p.applied, join: p.join, sort: so, visible: v, widths: p.widths, showFilters: show })
    toast(`Profile “${p.name}” applied`)
  }
  const saveAsProfile = async (): Promise<void> => {
    const n = (await promptDialog('Save view as profile', '', { message: 'Saves the filters, sort, visible columns and column widths of this table. An existing profile with the same name is replaced.', ok: 'Save' }))?.trim()
    if (!n) return
    setProfiles(saveProfile(profiles, stateKey, { name: n, filters, applied, join, sort, visible, widths }))
    toast(`Profile “${n}” saved`, 'success')
  }
  const profileMenu = (el: HTMLElement): void => menuBelow(el, [
    ...(tableProfiles.length ? [{ header: 'Apply profile' }, ...tableProfiles.map((p) => ({ label: p.name, onClick: () => applyProfile(p) }))] : [{ header: 'No profiles for this table yet' }]),
    { sep: true },
    { label: 'Save Current View as Profile…', onClick: () => void saveAsProfile() },
    ...(tableProfiles.length ? [
      { label: 'Update with Current View', submenu: tableProfiles.map((p) => ({ label: p.name, onClick: () => { setProfiles(saveProfile(profiles, stateKey, { name: p.name, filters, applied, join, sort, visible, widths })); toast(`Profile “${p.name}” updated`, 'success') } })) },
      { label: 'Rename', submenu: tableProfiles.map((p) => ({ label: p.name, onClick: async () => { const n = (await promptDialog('Rename profile', p.name, { ok: 'Rename' }))?.trim(); if (n) setProfiles(renameProfile(profiles, stateKey, p.name, n)) } })) },
      { label: 'Delete', submenu: tableProfiles.map((p) => ({ label: p.name, danger: true, onClick: async () => { if (await confirmDialog(`Delete profile “${p.name}”?`, undefined, { ok: 'Delete', danger: true })) setProfiles(deleteProfile(profiles, stateKey, p.name)) } })) }
    ] : [])
  ])

  useCommands(`table-${tab.id}`, {
    'edit.addRow': () => { if (view === 'data' && editable) addRow(); else if (view !== 'data') structApi.current?.add(); else return false; return true },
    'edit.duplicate': () => { if (view === 'data' && editable) duplicate() },
    'edit.find': () => { if (view === 'data') { setShowFilters(!showFilters); saveState({ showFilters: !showFilters }) } else structApi.current?.focusSearch() },
    'edit.columns': () => { const el = document.getElementById(`cols-btn-${tab.id}`); if (el) setPop({ kind: 'columns', el }) },
    'edit.copyCells': () => copyRows('plain', true),
    'edit.pasteCells': () => void pasteCells(),
    'edit.undo': () => { if (isTextFocus()) return false; doUndo(); return true },
    'edit.redo': () => { if (isTextFocus()) return false; doRedo(); return true },
    'nav.showData': () => updateTab(tab.id, { view: 'data' }),
    'nav.showStructure': () => updateTab(tab.id, { view: 'structure' }),
    'query.runCurrent': () => { if (view === 'data' && sel) setQuick({ r: sel.r1, c: sel.c1 }) },
    // ⇧⌘↩ is the menu accelerator for "run all"; in a table it opens the FK value picker
    'query.runAll': () => { if (ws().active !== tab.id || view !== 'data' || !sel || !fkOf(sel.c1)) return false; openPicker(sel.r1, sel.c1); return true },
    'conn.reloadTab': () => void load()
  })

  const gridKey = (e: React.KeyboardEvent, sl: Sel | null): boolean | void => {
    if (e.key === ' ') { setWs({ right: !ws().right }); return true }
    if ((e.key === 'Backspace' || e.key === 'Delete') && editable) { toggleDelete(); return true }
    if (e.key === 'Enter' && e.altKey && sl) {
      const cell = document.querySelector(`[role=grid] .grid-cell.focus`)?.getBoundingClientRect()
      openMenu(setValueMenu(sl.r1, sl.c1), cell?.left ?? 200, cell?.bottom ?? 200)
      return true
    }
    if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey) && sl && fkOf(sl.c1)) { openPicker(sl.r1, sl.c1); return true }
    if (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey)) { nextPage(); return true }
    if (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey)) { prevPage(); return true }
    return false
  }

  const nextPage = (): void => { if (count && offset + pageSize < count.n) setOffset(offset + pageSize) }
  const prevPage = (): void => setOffset(Math.max(0, offset - pageSize))

  const selRows = selectedRows().slice(0, 500).map(rowValues)
  const pending = pendingCount()

  return (
    <div className="col grow" style={{ minHeight: 0 }} onFocusCapture={() => focusScope(`table-${tab.id}`)}>
      <div className="row grow" style={{ alignItems: 'stretch', gap: 0, minHeight: 0 }}>
        <div className="col grow" style={{ minHeight: 0 }}>
          {view === 'data' ? (
            <>
              {showFilters && cols.length > 0 && (
                <FilterPanel
                  dialect={d}
                  columns={cols}
                  filters={filters}
                  join={join}
                  applied={JSON.stringify(applied)}
                  onChange={setFilters}
                  onApply={applyFilters}
                  onClose={() => { setShowFilters(false); saveState({ showFilters: false }); grid.current?.focus() }}
                  defaults={{ column: setting('filter.defaultColumn', 'pk'), op: setting('filter.defaultOp', '=') }}
                  onFind={() => setFinding(true)}
                />
              )}
              {finding && (
                <GridFind
                  columns={gridCols}
                  rowCount={rows.length}
                  valueAt={valueAt}
                  sel={sel}
                  editable={editable}
                  isDeleted={(r) => snap.deleted.has(r)}
                  onSelect={(x) => grid.current?.setSelection(x)}
                  onReplace={setCells}
                  onClose={() => { setFinding(false); grid.current?.focus() }}
                />
              )}
              {error ? (
                <div className="empty"><div className="danger-text selectable" style={{ whiteSpace: 'pre-wrap' }}>{error}</div><pre className="code" style={{ maxWidth: 700 }}>{lastSql}</pre><button className="btn" onClick={() => void load()}>Retry</button></div>
              ) : (
                <Grid
                  ref={grid}
                  columns={gridCols}
                  rows={rows}
                  pending={{ edits: snap.edits, deleted: snap.deleted, insertedFrom: base.length }}
                  editable={editable}
                  sort={sort}
                  widths={widths}
                  rowOffset={offset}
                  alternate={alternate}
                  onWidths={(w) => { setWidths(w); saveState({ widths: w }) }}
                  onHeaderClick={headerClick}
                  onHeaderMenu={headerMenu}
                  onEdit={setCell}
                  onCellMenu={cellMenu}
                  onFk={followFk}
                  onFkPick={openPicker}
                  onSelect={setSel}
                  onKey={gridKey}
                  onCopy={(ev) => ev.clipboardData?.setData('text/plain', formatRows('csv', resCols, selectedRows().map(rowValues)))}
                  onPaste={(ev) => pasteRows(ev.clipboardData?.getData('text/plain') ?? '')}
                  empty={loading ? 'Loading…' : applied.some((f) => f.enabled) ? 'No rows match the filter.'
                    : unseen ? `No rows visible to this login, though statistics estimate ~${unseen.toLocaleString()}. Row-level security may hide them, or the statistics are out of date.` : 'This table is empty.'}
                />
              )}
            </>
          ) : view === 'stats' ? (
            <ColumnStats schema={schema} table={name} columns={cols} />
          ) : (
            <Structure tab={tab} view={view} columns={cols} fks={fks} apiRef={structApi} onCommitted={async () => { await loadMeta(); bumpPending() }} />
          )}
        </div>
        {s.right && view === 'data' && (
          <div className="right-sidebar" aria-label="Row details">
            <RowDetail
              columns={gridCols}
              rows={selRows}
              readOnly={!editable}
              nowExpr="CURRENT_TIMESTAMP"
              onSet={(c, v) => mutate((x) => selectedRows().forEach((r) => { const m = x.edits.get(r) ?? new Map(); m.set(c, v); x.edits.set(r, m) }))}
            />
          </div>
        )}
      </div>
      {showHist && view === 'data' && (
        <div className="console" role="log" aria-label="SQL sent by this tab">
          <div className="row" style={{ fontFamily: 'var(--font-ui)', marginBottom: 'var(--sp-2)' }}>
            <b className="grow">SQL sent by this tab this session ({hist.length})</b>
            <button className="btn sm ghost" disabled={!hist.length} onClick={() => void navigator.clipboard.writeText(hist.map((h) => h.sql.replace(/;?\s*$/, ';')).join('\n'))}>Copy All</button>
            <button className="btn sm ghost" disabled={!hist.length} onClick={() => setHist([])}>Clear</button>
            <button className="btn sm icon" aria-label="Hide history" onClick={() => setShowHist(false)}><Icon name="x" size={10} /></button>
          </div>
          {[...hist].reverse().map((h, i) => (
            <div key={hist.length - i} className="row" style={{ alignItems: 'flex-start' }}>
              <span className="time">{new Date(h.at).toLocaleTimeString()}</span>
              <span className="grow" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{h.sql}</span>
              <button className="btn sm ghost" style={{ flex: 'none' }} title="Copy statement" onClick={() => void navigator.clipboard.writeText(h.sql)}>Copy</button>
            </div>
          ))}
        </div>
      )}
      <div className="bottombar">
        <div className="seg" role="tablist" aria-label="Table view">
          <button role="tab" aria-selected={view === 'data'} className={view === 'data' ? 'on' : ''} disabled={tab.isNew} onClick={() => updateTab(tab.id, { view: 'data' })}>Data</button>
          <button role="tab" aria-selected={view === 'structure'} className={view === 'structure' ? 'on' : ''} onClick={() => updateTab(tab.id, { view: 'structure' })}>Structure</button>
          {!isView && <button role="tab" aria-selected={view === 'index'} className={view === 'index' ? 'on' : ''} disabled={tab.isNew} onClick={() => updateTab(tab.id, { view: 'index' })}>Indexes</button>}
          <button role="tab" aria-selected={view === 'stats'} className={view === 'stats' ? 'on' : ''} disabled={tab.isNew} title="Data profile: nulls, distinct values, ranges and distributions per column" onClick={() => updateTab(tab.id, { view: 'stats' })}>Stats</button>
        </div>
        {view === 'data' && (
          <>
            <div className="record-bar" role="group" aria-label="Record actions" data-tour="record-bar">
              <button className="btn sm icon" disabled={!editable} title="Add row (⌘I)" aria-label="Add row" onClick={() => addRow()}><Icon name="plus" size={11} /></button>
              <button className="btn sm icon" disabled={!editable || !sel} title="Delete selected rows (⌫)" aria-label="Delete selected rows" onClick={toggleDelete}><Icon name="minus" size={11} /></button>
              <button className="btn sm icon apply" disabled={!pending} title={`Save changes (⌘S)${pending ? ` · ${pending} pending` : ''}`} aria-label="Save changes" onClick={() => void apiRef.current.commit()}><Icon name="check" size={11} /></button>
              <button className="btn sm icon cancel" disabled={!pending} title="Discard changes (⇧⌘⌫)" aria-label="Discard changes" onClick={() => apiRef.current.discard()}><Icon name="x" size={11} /></button>
            </div>
            <button id={`cols-btn-${tab.id}`} className={`btn sm ${visible ? 'on' : ''}`} title="Choose columns (⌥⌘F)" onClick={(e) => setPop({ kind: 'columns', el: e.currentTarget })}><Icon name="columns" size={11} /> Columns</button>
            <button data-tour="filters" className={`btn sm ${showFilters || applied.some((f) => f.enabled) ? 'on' : ''}`} title="Filters (⌘F)" onClick={() => { setShowFilters(!showFilters); saveState({ showFilters: !showFilters }) }}><Icon name="filter" size={11} /> Filters{applied.filter((f) => f.enabled).length ? ` (${applied.filter((f) => f.enabled).length})` : ''}</button>
            <button className={`btn sm ${finding ? 'on' : ''}`} title="Find and replace in loaded rows" onClick={() => setFinding(!finding)}><Icon name="search" size={11} /> Find</button>
            <button className={`btn sm ${(profiles[stateKey] ?? []).length ? 'on' : ''}`} title="Saved filters, sort and column layouts for this table" onClick={(e) => profileMenu(e.currentTarget)}><Icon name="star" size={11} /> Profiles{(profiles[stateKey] ?? []).length ? ` (${(profiles[stateKey] ?? []).length})` : ''}</button>
            <button className={`btn sm ${showHist ? 'on' : ''}`} title="SQL sent by this tab this session" onClick={() => setShowHist(!showHist)}><Icon name="history" size={11} /> History</button>
            <button className="btn sm" title="Save rows as CSV, JSON, Excel, SQL, Markdown, HTML or XML" onClick={(e) => menuBelow(e.currentTarget, [
              { label: `Whole ${isView ? 'View' : 'Table'}…`, onClick: () => openTool({ kind: 'export', items: [{ schema, name, kind: tab.objKind ?? 'table' }] }) },
              { label: 'Current Page…', disabled: !base.length, onClick: () => setExporting(true) }
            ])}><Icon name="download" size={11} /> Export</button>
            {!editable && !loading && !isView && <span className="faint" title="No primary key or unique key: rows cannot be identified safely">Read-only (no key)</span>}
            {pending > 0 && <span style={{ color: 'var(--warning)' }}>{pending} pending</span>}
            <span className="grow" />
            <span className="muted">
              {loading ? 'Loading…' : count ? (
                count.estimated
                  ? <button className="btn sm ghost" title="Estimated. Click for the exact count." onClick={async () => { logSql(countSql(d, query(), colTypes())); setCount({ n: await call<number>('db.count', s.sessionId, query(), colTypes()), estimated: false }) }}>~{count.n.toLocaleString()} rows</button>
                  : `${count.n === 0 ? 0 : offset + 1}–${Math.min(offset + base.length, count.n).toLocaleString()} of ${count.n.toLocaleString()} rows`
              ) : ''}
            </span>
            <button className="btn sm icon" aria-label="Previous page" title="Previous page (⌘←)" disabled={offset === 0} onClick={prevPage}><Icon name="chevronLeft" size={11} /></button>
            <button className="btn sm icon" aria-label="Page settings" title="Limit and offset" onClick={(e) => setPop({ kind: 'page', el: e.currentTarget })}><Icon name="more" size={11} /></button>
            <button className="btn sm icon" aria-label="Next page" title="Next page (⌘→)" disabled={!count || offset + pageSize >= count.n} onClick={nextPage}><Icon name="chevronRight" size={11} /></button>
            <button className="btn sm icon" aria-label="Reload" title="Reload (⌥⌘R)" onClick={() => void load()}><Icon name="refresh" size={11} /></button>
          </>
        )}
        {view !== 'data' && <><span className="grow" /><span className="muted">{tab.isNew ? 'New table' : `${schema ? schema + '.' : ''}${name}`}</span></>}
      </div>
      {pop?.kind === 'columns' && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} width={260}>
          <div className="col" style={{ gap: 'var(--sp-2)', maxHeight: 360, overflow: 'auto', padding: 'var(--sp-3)' }}>
            <div className="row"><b className="grow">Columns</b><button className="btn sm ghost" onClick={() => { setVisible(null); saveState({ visible: null }) }}>All</button><button className="btn sm ghost" onClick={() => { setVisible(keyCols); saveState({ visible: keyCols }) }}>None</button></div>
            {cols.map((c) => (
              <label key={c.name} className="check">
                <input type="checkbox" checked={!visible || visible.includes(c.name)} onChange={(e) => {
                  const cur = visible ?? cols.map((x) => x.name)
                  const v = e.target.checked ? cols.map((x) => x.name).filter((n) => cur.includes(n) || n === c.name) : cur.filter((n) => n !== c.name)
                  const nv = v.length === cols.length ? null : v
                  setVisible(nv); saveState({ visible: nv })
                }} />
                <span className="ellipsis">{c.name}</span><span className="faint mono" style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)' }}>{c.type}</span>
              </label>
            ))}
          </div>
        </Popover>
      )}
      {pop?.kind === 'page' && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} align="right">
          <PageForm limit={pageSize} offset={offset} onGo={(o) => { setOffset(o); setPop(null) }} />
        </Popover>
      )}
      {quick && (
        <QuickLook
          column={resCols[quick.c]}
          value={valueAt(quick.r, quick.c)}
          readOnly={!editable || snap.deleted.has(quick.r)}
          onSave={(v) => setCell(quick.r, quick.c, v)}
          onClose={() => { setQuick(null); grid.current?.focus() }}
        />
      )}
      {picker && (
        <FkPicker
          sessionId={s.sessionId!}
          schema={schema}
          fk={picker.fk}
          current={valueAt(picker.r, picker.c)}
          onSql={logSql}
          onPick={(v) => { setCells(picker.rows.map((r) => [r, picker.c, v === null || v === undefined ? null : display(v)])); setPicker(null); grid.current?.focus() }}
          onClose={() => { setPicker(null); grid.current?.focus() }}
        />
      )}
      {exporting && <ExportResultDialog title={name} columns={resCols} rows={rows.map((_, r) => rowValues(r))} table={name} onClose={() => setExporting(false)} />}
    </div>
  )
}

function PageForm({ limit, offset, onGo }: { limit: number; offset: number; onGo: (offset: number) => void }): ReactNode {
  const [o, setO] = useState(String(offset))
  return (
    <div className="col" style={{ gap: 'var(--sp-3)', padding: 'var(--sp-3)', width: 200 }}>
      <div className="kv"><span>Limit</span><span className="mono">{limit} (Settings ▸ Table)</span></div>
      <label className="row">Offset <input className="input sm grow mono" autoFocus value={o} onChange={(e) => setO(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && onGo(Number(o) || 0)} /></label>
      <button className="btn primary sm" onClick={() => onGo(Number(o) || 0)}>Go</button>
    </div>
  )
}

const isTextFocus = (): boolean => {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest('.cm-editor'))
}

