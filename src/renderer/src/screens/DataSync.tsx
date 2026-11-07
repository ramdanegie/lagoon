// Data Synchronization: compare rows of matching tables between two connections/schemas, review the differences, deploy them.
// Also exports the connection/database/schema picker and the target safe-mode check that Data Transfer reuses.
/* eslint-disable react-refresh/only-export-components -- helpers shared with DataTransfer.tsx; a hot reload of this module just reloads it fully */
import { type ReactNode, Fragment, useEffect, useId, useRef, useState } from 'react'
import type { Connection, Dialect, ServerInfo } from '@shared/types'
import { DRIVERS, dialectOf } from '@shared/types'
import { splitStatements } from '@shared/split'
import { matchTables, defaultPairing, keyProblem, commonColumns, type ColInfo, type OpKind } from '@shared/datasync'
import { call, toast, fail, errText } from '../lib/api'
import { ws, guard, newQueryTab } from '../lib/ws'
import { Modal, confirmDialog, promptDialog } from '../components/ui'
import { useJobs, JobStatus } from './ImportExport'
import '../styles/importexport.css'
import '../styles/sync.css'

// ---------- shared with DataTransfer ----------
export const plural = (n: number, w: string): string => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

/** Saved connections that speak SQL. */
export function useSqlConns(): Connection[] {
  const [list, setList] = useState<Connection[]>([])
  useEffect(() => { call<Connection[]>('conn.list').then((l) => setList(l.filter((c) => dialectOf(c.driver))), fail) }, [])
  return list
}

/** A private session for a picker (the workspace's own session is never switched to another database). */
async function openSide(c: Connection): Promise<{ sessionId: string; info: ServerInfo } | null> {
  const w = ws()
  if (c.id === w.conn?.id && w.sessionId) return call('transfer.open', c.id, undefined, w.sessionId)
  const asked: { password?: string; sshPassword?: string } = {}
  if (c.passwordMode === 'ask') {
    const pw = await promptDialog(`Password for ${c.name}`, '', { password: true, ok: 'Connect' })
    if (pw === null) return null
    asked.password = pw
  }
  if (c.ssh?.enabled && !c.ssh.useKey && c.ssh.passwordMode === 'ask') {
    const pw = await promptDialog(`SSH password for ${c.ssh.user}@${c.ssh.host}`, '', { password: true, ok: 'Connect' })
    if (pw === null) return null
    asked.sshPassword = pw
  }
  return call('transfer.open', c.id, asked)
}

export interface SideValue { connId: string; database?: string; schema?: string }
export interface SideState extends SideValue { conn?: Connection; sessionId?: string; dialect?: Dialect; databases: string[]; schemas: string[]; busy: boolean; error: string }
export interface Side { s: SideState; pick: (v: SideValue) => void }

/** Connection → database → schema, backed by its own session (closed when the window closes). */
export function useSide(initial: SideValue): Side {
  const [want, pick] = useState<SideValue>(initial)
  const [s, setS] = useState<SideState>({ ...initial, databases: [], schemas: [], busy: false, error: '' })
  const open = useRef<{ connId: string; sessionId: string; database?: string } | null>(null)
  useEffect(() => () => { if (open.current) void call('session.close', open.current.sessionId) }, [])
  useEffect(() => {
    let live = true
    const set = (p: Partial<SideState>): void => { if (live) setS((x) => ({ ...x, ...p })) }
    void (async () => {
      if (!want.connId) { set({ ...want, conn: undefined, sessionId: undefined, databases: [], schemas: [], busy: false, error: '' }); return }
      set({ ...want, busy: true, error: '' })
      try {
        const conn = await call<Connection>('conn.get', want.connId)
        let info: ServerInfo | undefined
        if (open.current?.connId !== want.connId) {
          if (open.current) { void call('session.close', open.current.sessionId); open.current = null }
          set({ sessionId: undefined })
          const r = await openSide(conn)
          if (!r) { set({ busy: false, error: 'Connection cancelled.' }); return }
          if (!live) { void call('session.close', r.sessionId); return }
          open.current = { connId: want.connId, sessionId: r.sessionId, database: r.info.database }
          info = r.info
        }
        const o = open.current!
        const dialect = dialectOf(conn.driver)!
        const fallback = want.connId === ws().conn?.id ? ws().database : (info?.database ?? o.database)
        const databases = await call<string[]>('db.databases', o.sessionId).catch(() => [] as string[])
        const pickDb = want.database ?? fallback ?? databases[0]
        if (pickDb && pickDb !== o.database) {
          await call('db.use', o.sessionId, pickDb)
          o.database = pickDb
        }
        const database = o.database
        if (database && !databases.includes(database)) databases.unshift(database)
        const schemas = dialect === 'mysql' ? (database ? [database] : []) : await call<string[]>('db.schemas', o.sessionId)
        const def = dialect === 'postgres' ? (schemas.includes('public') ? 'public' : schemas[0]) : dialect === 'sqlite' ? 'main' : database
        const schema = want.schema && schemas.includes(want.schema) ? want.schema : def
        set({ conn, sessionId: o.sessionId, dialect, databases, database, schemas, schema, busy: false })
      } catch (e) {
        set({ busy: false, error: errText(e) })
      }
    })()
    return () => { live = false }
  }, [want])
  return { s, pick }
}

/** Human label of a picked side: "Connection · database · schema". */
export const sideLabel = (s: SideState): string => [s.conn?.name, s.database, s.dialect === 'postgres' ? s.schema : undefined].filter(Boolean).join(' · ')
export const sideReady = (s: SideState): boolean => !!s.sessionId && !!s.schema && !s.busy

export function SidePicker({ title, side, conns, lockConn }: { title: string; side: Side; conns: Connection[]; lockConn?: boolean }): ReactNode {
  const { s, pick } = side
  const id = useId()
  const drv = (c: Connection): string => DRIVERS.find((d) => d.id === c.driver)?.name ?? c.driver
  const body = (
    <>
      <div className="field">
        <label htmlFor={`${id}c`}>Connection</label>
        <select id={`${id}c`} className="select" value={s.connId} disabled={lockConn || s.busy} onChange={(e) => pick({ connId: e.target.value })}>
          {!s.connId && <option value="">Choose a connection…</option>}
          {conns.map((c) => <option key={c.id} value={c.id}>{c.name} ({drv(c)})</option>)}
        </select>
      </div>
      {s.sessionId && (
        <div className="field">
          <label htmlFor={`${id}d`}>{s.dialect === 'sqlite' ? 'Database file' : 'Database'}</label>
          <select id={`${id}d`} className="select" value={s.database ?? ''} disabled={s.busy} onChange={(e) => pick({ connId: s.connId, database: e.target.value })}>
            {s.databases.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      )}
      {s.sessionId && s.dialect === 'postgres' && (
        <div className="field">
          <label htmlFor={`${id}s`}>Schema</label>
          <select id={`${id}s`} className="select" value={s.schema ?? ''} disabled={s.busy} onChange={(e) => pick({ connId: s.connId, database: s.database, schema: e.target.value })}>
            {s.schemas.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
      )}
      {s.busy && <div className="muted" role="status">Connecting…</div>}
      {s.error && <div className="danger-text selectable">{s.error}</div>}
    </>
  )
  // without a title the fields sit inside the caller's own fieldset
  return title ? <fieldset className="fieldset"><legend>{title}</legend>{body}</fieldset> : body
}

/**
 * Before writing to a target: an explicit confirmation, the workspace connection's safe mode (guard),
 * and the target connection's own safe mode when it is a different connection.
 */
export async function confirmTarget(target: Connection, stmts: string[], title: string, message: string): Promise<boolean> {
  if (!(await confirmDialog(title, message, { ok: 'Continue' }))) return false
  if (!(await guard(stmts))) return false
  if (ws().conn?.id === target.id || !target.safeMode) return true
  // levels 3–4 want the stored password; connections without one fall back to a confirmation
  if (target.safeMode <= 2 || target.passwordMode !== 'store') return confirmDialog(`Safe mode · ${target.name}`, `${target.name} asks for confirmation before changes.\n\n${stmts.slice(0, 12).join('\n')}${stmts.length > 12 ? '\n…' : ''}`, { ok: 'Send' })
  const pw = await promptDialog(`Safe mode · ${target.name}`, '', { password: true, message: `Enter the password of ${target.name} to continue.`, ok: 'Send' })
  if (pw === null) return false
  if (await call<boolean>('conn.checkStoredPassword', target.id, pw)) return true
  fail('Wrong password.')
  return false
}

// ---------- data synchronization ----------
interface TInfo { name: string; cols: ColInfo[] }
interface MapRow { source: string; target: string | null; on: boolean; keys: string[]; cols: string[]; where: string; open?: boolean }
interface TableSum { source: string; target: string; columns: string[]; targetColumns: string[]; keyCount: number; counts: Record<OpKind, number>; truncated: boolean; error?: string }
interface DiffRow { id: number; kind: OpKind; src: unknown[] | null; dst: unknown[] | null; changed: number[] }
type Filter = 'diff' | 'insert' | 'update' | 'delete' | 'same' | 'all'

const FILTERS: [Filter, string][] = [['diff', 'Difference'], ['insert', 'Insert'], ['update', 'Update'], ['delete', 'Delete'], ['same', 'Same'], ['all', 'All']]
const KIND_LABEL: Record<OpKind, string> = { insert: 'Insert', update: 'Update', delete: 'Delete', same: 'Same' }
const PAGE = 200
const diffs = (t: TableSum): number => t.counts.insert + t.counts.update + t.counts.delete

function Cell({ v }: { v: unknown }): ReactNode {
  if (v === null || v === undefined) return <span className="sy-null">NULL</span>
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return <>{s.length > 300 ? s.slice(0, 300) + '…' : s}</>
}

export function DataSync({ onClose }: { onClose: () => void }): ReactNode {
  const w = ws()
  const conns = useSqlConns()
  const src = useSide({ connId: w.conn?.id ?? '', database: w.database, schema: w.schema })
  const dst = useSide({ connId: '' })
  // mapping grid, remembered for the source/target it was read from
  const [map, setMap] = useState<{ key: string; tables: { source: TInfo[]; target: TInfo[] }; rows: MapRow[] }>()
  const [opts, setOpts] = useState({ insert: true, update: true, delete: false, ignoreCase: false, ignoreSpace: false })
  const [step, setStep] = useState<'setup' | 'results'>('setup')
  const [cmpId, setCmpId] = useState<string>()
  const cmpJob = useJobs((s) => s.list.find((j) => j.id === cmpId))
  const [summary, setSummary] = useState<TableSum[]>([])
  const [sel, setSel] = useState(0)
  const [filter, setFilter] = useState<Filter>('diff')
  const [page, setPage] = useState(0)
  const [diffFor, setDiffFor] = useState<{ key: string; total: number; rows: DiffRow[] }>()
  const [excluded, setExcluded] = useState<Record<number, number[]>>({})
  const [off, setOff] = useState<Record<number, boolean>>({})
  const [coe, setCoe] = useState(false)
  const [deployId, setDeployId] = useState<string>()
  const deployJob = useJobs((s) => s.list.find((j) => j.id === deployId))
  const deployLog = useJobs((s) => (deployId ? s.logs[deployId] : undefined))
  const cmpRef = useRef<string>(undefined)
  cmpRef.current = cmpId
  useEffect(() => () => { if (cmpRef.current) void call('datasync.drop', cmpRef.current) }, [])

  const sd = src.s.dialect ?? 'postgres'
  const td = dst.s.dialect ?? 'postgres'
  const ready = sideReady(src.s) && sideReady(dst.s)
  const mapKey = ready ? [src.s.sessionId, src.s.database, src.s.schema, dst.s.sessionId, dst.s.database, dst.s.schema].join('\0') : ''
  const tables = map?.key === mapKey ? map.tables : undefined
  const rows = tables ? map!.rows : []
  const loading = !!mapKey && !tables
  const setRows = (f: (rs: MapRow[]) => MapRow[]): void => setMap((m) => (m ? { ...m, rows: f(m.rows) } : m))

  // table pairs for the mapping grid
  useEffect(() => {
    if (!mapKey) return
    let live = true
    call<{ source: TInfo[]; target: TInfo[] }>('datasync.tables', src.s.sessionId, src.s.schema, dst.s.sessionId, dst.s.schema).then((t) => {
      if (!live) return
      const match = matchTables(t.source.map((x) => x.name), t.target.map((x) => x.name))
      setMap({ key: mapKey, tables: t, rows: t.source.map((s, i) => pairRow(t, s.name, match[i])) })
    }, fail)
    return () => { live = false }
  }, [mapKey])

  const colsOf = (side: 'source' | 'target', name: string | null): ColInfo[] => tables?.[side].find((x) => x.name === name)?.cols ?? []
  function pairRow(t: { source: TInfo[]; target: TInfo[] }, source: string, target: string | null): MapRow {
    const sc = t.source.find((x) => x.name === source)?.cols ?? []
    const tc = t.target.find((x) => x.name === target)?.cols ?? []
    const p = target ? defaultPairing(sc, tc, sd, td) : { keys: [], cols: [], reason: 'No target table' }
    return { source, target, on: !!target && !p.reason, keys: p.keys, cols: p.cols, where: '' }
  }
  const problem = (r: MapRow): string | undefined => (!r.target ? 'No target table' : keyProblem(r.keys, colsOf('source', r.source), colsOf('target', r.target), sd, td) ?? (r.cols.length ? undefined : 'No columns to compare'))
  const setRow = (i: number, p: Partial<MapRow>): void => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const usable = rows.filter((r) => r.on && !problem(r))

  const compare = async (): Promise<void> => {
    const pairs = usable.map((r) => {
      const common = commonColumns(colsOf('source', r.source), colsOf('target', r.target))
      const pair = (n: string): [string, string] => common.find(([s]) => s === n)!
      return { source: r.source, target: r.target!, keys: r.keys.map(pair), cols: r.cols.map(pair), where: r.where.trim() || undefined }
    })
    try {
      if (cmpId) void call('datasync.drop', cmpId)
      setSummary([])
      setDeployId(undefined)
      setCmpId(await call<string>('datasync.compare', { source: { sessionId: src.s.sessionId, schema: src.s.schema }, target: { sessionId: dst.s.sessionId, schema: dst.s.schema }, pairs, opts: { ignoreCase: opts.ignoreCase, ignoreSpace: opts.ignoreSpace } }))
    } catch (e) { fail(e) }
  }

  useEffect(() => {
    if (cmpJob?.state !== 'done' || !cmpId) return
    call<TableSum[]>('datasync.summary', cmpId).then((s) => {
      setSummary(s)
      setExcluded({})
      setOff(Object.fromEntries(s.flatMap((t, i) => (t.truncated ? [[i, true]] : [])))) // too many differences to deploy here
      setSel(Math.max(0, s.findIndex((t) => diffs(t) > 0)))
      setFilter('diff')
      setPage(0)
      setStep('results')
    }, fail)
  }, [cmpJob?.state, cmpId])

  const diffKey = step === 'results' && cmpId && summary[sel] ? [cmpId, summary.length, sel, filter, page].join('\0') : ''
  const diff = diffFor?.key === diffKey ? diffFor : undefined
  useEffect(() => {
    if (diffKey) call<{ total: number; rows: DiffRow[] }>('datasync.rows', cmpId, sel, filter, page * PAGE, PAGE).then((d) => setDiffFor({ key: diffKey, ...d }), fail)
  }, [diffKey])

  const kinds = { insert: opts.insert, update: opts.update, delete: opts.delete }
  const selection = (): { tables: Record<number, { off: boolean; excluded: number[] }>; kinds: typeof kinds } =>
    ({ tables: Object.fromEntries(summary.map((_t, i) => [i, { off: !!off[i], excluded: excluded[i] ?? [] }])), kinds })
  const script = (): Promise<{ total: number; sql: string }> => call('datasync.script', cmpId, selection())

  const preview = async (copy: boolean): Promise<void> => {
    try {
      const { total, sql } = await script()
      if (!total) { toast('Nothing to apply with the current choices.'); return }
      if (copy) { await navigator.clipboard.writeText(sql); toast(`Copied ${plural(total, 'statement')}.`, 'success'); return }
      newQueryTab(sql, 'Sync script')
      toast(`Opened in a new SQL tab. It runs on this window's connection; the script is meant for ${sideLabel(dst.s)}.`)
    } catch (e) { fail(e) }
  }

  const deploy = async (): Promise<void> => {
    try {
      const { total, sql } = await script()
      if (!total) { toast('Nothing to apply with the current choices.'); return }
      const stmts = total <= 200
        ? splitStatements(sql, td).map((s) => s.sql)
        : summary.flatMap((t, i) => (off[i] || t.error ? [] : [`-- ${t.target}: ${(['insert', 'update', 'delete'] as const).filter((k) => kinds[k]).map((k) => `${t.counts[k]} ${k.toUpperCase()}`).join(', ')}`]))
      if (!(await confirmTarget(dst.s.conn!, stmts, 'Deploy changes', `Apply ${plural(total, 'change')} to ${sideLabel(dst.s)}?\n\nEach table runs in its own transaction${coe ? '; failing statements are skipped' : ' and stops at the first error'}.`))) return
      setDeployId(await call<string>('datasync.deploy', cmpId, selection(), { continueOnError: coe }))
    } catch (e) { fail(e) }
  }

  const running = cmpJob?.state === 'running' || deployJob?.state === 'running'
  const t = summary[sel]
  const ex = new Set(excluded[sel] ?? [])
  const toggleRow = (id: number, on: boolean): void => setExcluded((e) => ({ ...e, [sel]: on ? (e[sel] ?? []).filter((x) => x !== id) : [...(e[sel] ?? []), id] }))
  const pageIds = (diff?.rows ?? []).filter((r) => r.kind !== 'same').map((r) => r.id)

  const optionChecks = (which: ('insert' | 'update' | 'delete')[]): ReactNode =>
    which.map((k) => (
      <label key={k} className="check"><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {k === 'insert' ? 'Insert missing rows' : k === 'update' ? 'Update different rows' : 'Delete extra rows'}</label>
    ))

  const footer = (
    <>
      <div className="grow">{deployJob ? <JobStatus job={deployJob} /> : cmpJob && (cmpJob.state !== 'done' || step === 'setup') ? <JobStatus job={cmpJob} /> : null}</div>
      {running ? (
        <button className="btn" onClick={() => void call('job.cancel', (deployJob?.state === 'running' ? deployJob : cmpJob)!.id)}>Stop</button>
      ) : step === 'setup' ? (
        <>
          <button className="btn" onClick={onClose}>Close</button>
          {summary.length > 0 && <button className="btn" onClick={() => setStep('results')}>Show results</button>}
          <button className="btn primary" disabled={!usable.length} onClick={() => void compare()}>Compare</button>
        </>
      ) : (
        <>
          <button className="btn" onClick={() => setStep('setup')}>Back</button>
          <button className="btn" onClick={() => void compare()}>Compare again</button>
          <button className="btn" onClick={() => void preview(true)}>Copy script</button>
          <button className="btn" onClick={() => void preview(false)}>Preview script</button>
          <button className="btn primary" onClick={() => void deploy()}>Deploy…</button>
        </>
      )}
    </>
  )

  return (
    <Modal title="Data Synchronization" onClose={onClose} width={1080} footer={footer}>
      {step === 'setup' ? (
        <>
          <div className="sy-sides">
            <SidePicker title="Source" side={src} conns={conns} />
            <button className="btn sm sy-swap" title="Swap source and target" aria-label="Swap source and target" disabled={!src.s.connId || !dst.s.connId || src.s.busy || dst.s.busy}
              onClick={() => { const a = { connId: src.s.connId, database: src.s.database, schema: src.s.schema }; src.pick({ connId: dst.s.connId, database: dst.s.database, schema: dst.s.schema }); dst.pick(a) }}>⇄</button>
            <SidePicker title="Target" side={dst} conns={conns} />
          </div>
          {ready && sd !== td && <div className="sy-note">Different engines: only columns with compatible types are compared, and keys must be numbers on both sides or text on both sides.</div>}
          {loading && <div className="muted" role="status">Reading tables…</div>}
          {tables && (
            <>
              <div className="row">
                <span className="muted grow">{usable.length} of {rows.length} tables selected</span>
                <button className="btn sm" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, on: !problem(r) })))}>All</button>
                <button className="btn sm" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, on: false })))}>None</button>
              </div>
              <div className="sy-scroll">
                <table className="sy-table">
                  <thead><tr><th scope="col" aria-label="Include" /><th scope="col">Source table</th><th scope="col">Target table</th><th scope="col">Key</th><th scope="col">Compared columns</th><th scope="col">Condition (WHERE, both sides)</th></tr></thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const why = problem(r)
                      const common = r.target ? commonColumns(colsOf('source', r.source), colsOf('target', r.target)) : []
                      return (
                        <Fragment key={r.source}>
                          <tr className={r.on && !why ? '' : 'off'}>
                            <td><input type="checkbox" aria-label={`Compare ${r.source}`} checked={r.on && !why} disabled={!!why} onChange={(e) => setRow(i, { on: e.target.checked })} /></td>
                            <td className="mono">{r.source}</td>
                            <td>
                              <select className="select sm" aria-label={`Target table for ${r.source}`} value={r.target ?? ''} onChange={(e) => tables && setRows((rs) => rs.map((x, k) => (k === i ? pairRow(tables, x.source, e.target.value || null) : x)))}>
                                <option value="">None (skip)</option>
                                {tables.target.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                              </select>
                            </td>
                            <td>
                              {r.target && <button className="btn sm" aria-expanded={!!r.open} onClick={() => setRow(i, { open: !r.open })}>{r.keys.length ? r.keys.join(', ') : 'Choose…'}</button>}
                              {why && <div className="sy-why danger-text">{why}</div>}
                            </td>
                            <td>{r.target && <button className="btn sm" aria-expanded={!!r.open} onClick={() => setRow(i, { open: !r.open })}>{r.cols.length} of {Math.max(0, common.length - r.keys.length)}</button>}</td>
                            <td><input className="input sm mono" aria-label={`Condition for ${r.source}`} placeholder="e.g. id < 1000" value={r.where} disabled={!r.target} onChange={(e) => setRow(i, { where: e.target.value })} /></td>
                          </tr>
                          {r.open && r.target && (
                            <tr className="sy-detail">
                              <td />
                              <td colSpan={5}>
                                <table className="sy-mini">
                                  <thead><tr><th scope="col">Column</th><th scope="col">Key</th><th scope="col">Compare</th></tr></thead>
                                  <tbody>
                                    {common.map(([s, d]) => (
                                      <tr key={s}>
                                        <td className="mono">{s === d ? s : `${s} → ${d}`}</td>
                                        <td><input type="checkbox" aria-label={`${s} is part of the key`} checked={r.keys.includes(s)} onChange={(e) => setRow(i, { keys: e.target.checked ? common.map(([x]) => x).filter((x) => r.keys.includes(x) || x === s) : r.keys.filter((x) => x !== s), cols: r.cols.filter((x) => x !== s) })} /></td>
                                        <td><input type="checkbox" aria-label={`Compare ${s}`} checked={r.cols.includes(s)} disabled={r.keys.includes(s)} onChange={(e) => setRow(i, { cols: e.target.checked ? common.map(([x]) => x).filter((x) => r.cols.includes(x) || x === s) : r.cols.filter((x) => x !== s) })} /></td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                <div className="muted sy-hint">Key columns pair rows on both sides and must be unique. Rows with an empty key are skipped.</div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                    {!rows.length && <tr><td colSpan={6} className="empty">No tables in the source.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="sy-opts" role="group" aria-label="Options">
                {optionChecks(['insert', 'update', 'delete'])}
                <label className="check"><input type="checkbox" checked={opts.ignoreCase} onChange={(e) => setOpts({ ...opts, ignoreCase: e.target.checked })} /> Ignore case in text</label>
                <label className="check"><input type="checkbox" checked={opts.ignoreSpace} onChange={(e) => setOpts({ ...opts, ignoreSpace: e.target.checked })} /> Ignore extra whitespace</label>
              </div>
            </>
          )}
          {!ready && !src.s.busy && !dst.s.busy && <div className="empty">Choose a source and a target to list their tables.</div>}
        </>
      ) : (
        <>
          <div className="sy-results">
            <div className="sy-tables" role="listbox" aria-label="Compared tables">
              {summary.map((x, i) => (
                <div key={i} role="option" aria-selected={i === sel} className={`list-item sy-tab ${i === sel ? 'selected' : ''}`} onClick={() => { setSel(i); setPage(0) }}>
                  <input type="checkbox" aria-label={`Deploy ${x.source}`} checked={!off[i] && !x.error && diffs(x) > 0} disabled={!!x.error || !diffs(x) || x.truncated} onClick={(e) => e.stopPropagation()} onChange={(e) => setOff((o) => ({ ...o, [i]: !e.target.checked }))} />
                  <span className="ellipsis grow" title={x.source === x.target ? x.source : `${x.source} → ${x.target}`}>{x.source}</span>
                  {x.error ? <span className="danger-text sy-counts" title={x.error}>not comparable</span> : (
                    <span className="sy-counts" aria-label={`${x.counts.insert} to insert, ${x.counts.update} to update, ${x.counts.delete} to delete, ${x.counts.same} same`}>
                      <span className="sy-n insert">+{x.counts.insert}</span><span className="sy-n update">~{x.counts.update}</span><span className="sy-n delete">−{x.counts.delete}</span><span className="sy-n same">={x.counts.same}</span>
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="sy-diff-wrap">
              {t?.error ? <div className="sy-note danger-text selectable">{t.source}: {t.error}</div> : t && (
                <>
                  <div className="row">
                    <div className="seg" role="tablist" aria-label="Show rows">
                      {FILTERS.map(([f, label]) => <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => { setFilter(f); setPage(0) }}>{label}</button>)}
                    </div>
                    <span className="grow" />
                    {diff && diff.total > PAGE && (
                      <>
                        <span className="muted">{(page * PAGE + 1).toLocaleString()}–{Math.min(diff.total, (page + 1) * PAGE).toLocaleString()} of {diff.total.toLocaleString()}</span>
                        <button className="btn sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button>
                        <button className="btn sm" disabled={(page + 1) * PAGE >= diff.total} onClick={() => setPage(page + 1)}>Next</button>
                      </>
                    )}
                  </div>
                  {t.truncated && <div className="sy-note">More than 100,000 differences: only the first 100,000 are listed and this table cannot be deployed. Narrow it with a condition, or copy it with Data Transfer.</div>}
                  {filter === 'same' && t.counts.same > 1000 && <div className="muted">Showing the first 1,000 identical rows.</div>}
                  <div className="sy-scroll sy-diff">
                    <table className="sy-table">
                      <thead>
                        <tr>
                          <th scope="col"><input type="checkbox" aria-label="Include every row on this page" checked={pageIds.length > 0 && pageIds.every((id) => !ex.has(id))} disabled={!pageIds.length}
                            onChange={(e) => setExcluded((x) => ({ ...x, [sel]: e.target.checked ? (x[sel] ?? []).filter((id) => !pageIds.includes(id)) : [...new Set([...(x[sel] ?? []), ...pageIds])] }))} /></th>
                          <th scope="col">Action</th>
                          {t.columns.map((c, i) => <th key={c} scope="col" className={i < t.keyCount ? 'sy-key' : ''}>{c}{t.targetColumns[i] !== c ? ` → ${t.targetColumns[i]}` : ''}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {(diff?.rows ?? []).map((r) => {
                          const on = r.kind !== 'same' && !ex.has(r.id) && kinds[r.kind as 'insert']
                          return (
                            <tr key={r.id} className={`sy-row ${r.kind} ${on || r.kind === 'same' ? '' : 'excluded'}`}>
                              <td><input type="checkbox" aria-label={`Include row ${r.id + 1}`} checked={on} disabled={r.kind === 'same' || !kinds[r.kind as 'insert']} onChange={(e) => toggleRow(r.id, e.target.checked)} /></td>
                              <td><span className={`sy-kind ${r.kind}`}>{KIND_LABEL[r.kind]}</span></td>
                              {t.columns.map((_c, i) => (
                                <td key={i} className={r.changed.includes(i) ? 'sy-changed' : ''}>
                                  {r.kind === 'update' && r.changed.includes(i) ? (
                                    <><span className="sy-new" title="Source"><Cell v={r.src![i]} /></span><span className="sy-old" title="Target now"><Cell v={r.dst![i]} /></span></>
                                  ) : <Cell v={(r.src ?? r.dst)![i]} />}
                                </td>
                              ))}
                            </tr>
                          )
                        })}
                        {diff && !diff.rows.length && <tr><td colSpan={t.columns.length + 2} className="empty">No rows in this view.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="sy-opts" role="group" aria-label="Deployment options">
            <span className="muted">Apply:</span>
            {optionChecks(['insert', 'update', 'delete'])}
            <label className="check"><input type="checkbox" checked={coe} onChange={(e) => setCoe(e.target.checked)} /> Continue on error</label>
            <span className="muted grow sy-target">Target: {sideLabel(dst.s)}</span>
          </div>
          {deployLog && <pre className="code sy-log" aria-label="Deployment log">{deployLog}</pre>}
        </>
      )}
    </Modal>
  )
}
