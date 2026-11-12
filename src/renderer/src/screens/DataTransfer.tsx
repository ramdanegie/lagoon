// Data Transfer: copy tables (and views as tables) to another connection / database / schema, or into a .sql file.
import { type ReactNode, Fragment, useEffect, useState } from 'react'
import type { Column, DbObject, Dialect } from '@shared/types'
import { DRIVERS } from '@shared/types'
import { qt } from '@shared/sqlgen'
import { call, fail } from '../lib/api'
import { ws } from '../lib/ws'
import { Modal } from '../components/ui'
import { useJobs, JobStatus } from './ImportExport'
import { useSide, useSqlConns, SidePicker, confirmTarget, sideLabel, sideReady, plural } from './DataSync'
import { MaskingOptions, useMaskRules } from './Masking'
import '../styles/importexport.css'
import '../styles/sync.css'

type Create = 'drop' | 'create' | 'existing'
interface Conf { on: boolean; target: string; create: Create; rows: 'all' | 'where' | 'none'; where: string; columns: string[] | null; open?: boolean }
const CREATE: [Create, string][] = [['create', 'Create if missing'], ['drop', 'Drop and create'], ['existing', 'Use existing']]
const DIALECTS: Dialect[] = ['postgres', 'mysql', 'sqlite']
const dialectName = (d: Dialect): string => DRIVERS.find((x) => x.dialect === d)!.name

export function DataTransfer({ items, onClose }: { items: DbObject[]; onClose: () => void }): ReactNode {
  const w = ws()
  const conns = useSqlConns()
  const src = useSide({ connId: w.conn?.id ?? '', database: w.database, schema: items[0]?.schema ?? w.schema })
  const dst = useSide({ connId: '' })
  const [toFile, setToFile] = useState(false)
  const [fileDialect, setFileDialect] = useState<Dialect>(w.dialect ?? 'postgres')
  const [objectsFor, setObjectsFor] = useState<{ key: string; list: DbObject[] }>()
  const [views, setViews] = useState(false)
  const [conf, setConf] = useState<Record<string, Conf>>({})
  const [cols, setCols] = useState<Record<string, Column[]>>({})
  const [batch, setBatch] = useState(1000)
  const [coe, setCoe] = useState(false)
  const [tx, setTx] = useState(true)
  const [noFk, setNoFk] = useState(false)
  const [masking, setMasking] = useState(false)
  const [maskRules] = useMaskRules()
  const [jobId, setJobId] = useState<string>()
  const job = useJobs((s) => s.list.find((j) => j.id === jobId))
  const log = useJobs((s) => (jobId ? s.logs[jobId] : undefined))

  // the source's tables, remembered for the database/schema they were read from
  const srcKey = sideReady(src.s) ? [src.s.sessionId, src.s.database, src.s.schema].join('\0') : ''
  const objects = objectsFor?.key === srcKey ? objectsFor.list : []
  useEffect(() => {
    if (srcKey) call<DbObject[]>('db.objects', src.s.sessionId, src.s.schema).then((o) => setObjectsFor({ key: srcKey, list: o.filter((x) => x.kind === 'table' || x.kind === 'view' || x.kind === 'matview') }), fail)
  }, [srcKey])

  const list = objects.filter((o) => o.kind === 'table' || views)
  const preselected = new Set(items.filter((i) => i.schema === src.s.schema || src.s.dialect !== 'postgres').map((i) => i.name))
  const cfg = (o: DbObject): Conf => conf[o.name] ?? { on: preselected.has(o.name), target: o.name, create: 'create', rows: 'all', where: '', columns: null }
  const set = (o: DbObject, p: Partial<Conf>): void => setConf((c) => ({ ...c, [o.name]: { ...cfg(o), ...p } }))
  const checked = list.filter((o) => cfg(o).on)
  const td = toFile ? fileDialect : dst.s.dialect

  const colKey = (o: DbObject): string => `${srcKey}\0${o.name}`
  const openCols = (o: DbObject): void => {
    set(o, { open: !cfg(o).open })
    const k = colKey(o)
    if (!cols[k]) call<Column[]>('db.columns', src.s.sessionId, src.s.schema, o.name).then((c) => setCols((x) => ({ ...x, [k]: c })), fail)
  }

  const problems = [
    !sideReady(src.s) && 'Choose the source.',
    !toFile && !sideReady(dst.s) && 'Choose the target connection.',
    !checked.length && 'Select at least one table.',
    checked.some((o) => !cfg(o).target.trim()) && 'Every selected table needs a target name.',
    checked.some((o) => cfg(o).columns?.length === 0) && 'A selected table has no columns selected.',
    checked.some((o) => cfg(o).rows === 'where' && !cfg(o).where.trim()) && 'Enter the row condition, or copy all rows.'
  ].filter(Boolean) as string[]

  const run = async (): Promise<void> => {
    const tables = checked.map((o) => {
      const c = cfg(o)
      return { source: o.name, kind: o.kind, target: c.target.trim(), create: c.create, data: c.rows !== 'none', where: c.rows === 'where' ? c.where.trim() : undefined, columns: c.columns ?? undefined }
    })
    let target: { file: string; dialect: Dialect } | { sessionId: string; schema: string }
    if (toFile) {
      const file = await call<string | undefined>('job.save', { title: 'Save transfer as SQL', defaultPath: `${src.s.database ?? 'transfer'}_${fileDialect}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })
      if (!file) return
      target = { file, dialect: fileDialect }
    } else {
      const d = dst.s.dialect!
      const schema = dst.s.schema!
      const stmts = tables.flatMap((t) => [
        ...(t.create === 'drop' ? [`DROP TABLE IF EXISTS ${qt(d, schema, t.target)}`] : []),
        ...(t.create !== 'existing' ? [`CREATE TABLE ${t.create === 'create' ? 'IF NOT EXISTS ' : ''}${qt(d, schema, t.target)} (…)`] : []),
        ...(t.data ? [`INSERT INTO ${qt(d, schema, t.target)} … -- rows from ${t.source}${t.where ? ` WHERE ${t.where}` : ''}`] : [])
      ])
      const drops = tables.filter((t) => t.create === 'drop').length
      const msg = `Copy ${plural(tables.length, 'table')} into ${sideLabel(dst.s)}?${drops ? `\n\n${plural(drops, 'target table')} with the same name will be dropped and created again.` : ''}`
      if (!(await confirmTarget(dst.s.conn!, stmts, 'Start transfer', msg))) return
      target = { sessionId: dst.s.sessionId!, schema }
    }
    try {
      setJobId(await call<string>('transfer.run', { source: { sessionId: src.s.sessionId, schema: src.s.schema }, target, tables, batch, continueOnError: coe, transaction: tx, disableFk: noFk, mask: masking ? maskRules : undefined }))
    } catch (e) { fail(e) }
  }

  const running = job?.state === 'running'
  return (
    <Modal
      title="Data Transfer"
      onClose={onClose}
      width={1040}
      footer={
        <>
          <div className="grow">{job ? <JobStatus job={job} /> : <span className={problems.length && checked.length ? 'danger-text' : 'muted'}>{problems.length && checked.length ? problems[0] : `${checked.length} selected`}</span>}</div>
          {running ? (
            <>
              <button className="btn" onClick={() => void call('job.cancel', job.id)}>Stop</button>
              <button className="btn" onClick={onClose}>Continue in background</button>
            </>
          ) : (
            <>
              {job?.state === 'done' && job.output && <button className="btn" onClick={() => void call('shell.reveal', job.output)}>Show in folder</button>}
              <button className="btn" onClick={onClose}>Close</button>
              <button className="btn primary" disabled={problems.length > 0} title={problems[0]} onClick={() => void run()}>{toFile ? 'Save…' : 'Start'}</button>
            </>
          )}
        </>
      }
    >
      <div className="sy-sides">
        <SidePicker title="Source" side={src} conns={conns} lockConn />
        <span className="sy-arrow" aria-hidden>→</span>
        <fieldset className="fieldset">
          <legend>Target</legend>
          <div className="field">
            <span />
            <div className="seg" role="tablist" aria-label="Target kind">
              <button role="tab" aria-selected={!toFile} className={toFile ? '' : 'on'} onClick={() => setToFile(false)}>Connection</button>
              <button role="tab" aria-selected={toFile} className={toFile ? 'on' : ''} onClick={() => setToFile(true)}>SQL file</button>
            </div>
          </div>
          {toFile ? (
            <div className="field">
              <label htmlFor="xt-dialect">SQL for</label>
              <select id="xt-dialect" className="select" value={fileDialect} onChange={(e) => setFileDialect(e.target.value as Dialect)}>
                {DIALECTS.map((d) => <option key={d} value={d}>{dialectName(d)}</option>)}
              </select>
            </div>
          ) : <SidePicker title="" side={dst} conns={conns} />}
        </fieldset>
      </div>
      {td && src.s.dialect && td !== src.s.dialect && <div className="sy-note">{dialectName(src.s.dialect)} to {dialectName(td)}: column types are mapped to close equivalents. Indexes other than the primary key, foreign keys, triggers and checks are not copied.</div>}

      <div className="row">
        <span className="muted grow">{list.length ? `${checked.length} of ${list.length} selected` : sideReady(src.s) ? 'No tables in this schema.' : ''}</span>
        <label className="check"><input type="checkbox" checked={views} onChange={(e) => setViews(e.target.checked)} /> Include views (copied as tables)</label>
        <button className="btn sm" onClick={() => setConf((c) => ({ ...c, ...Object.fromEntries(list.map((o) => [o.name, { ...cfg(o), on: true }])) }))}>All</button>
        <button className="btn sm" onClick={() => setConf((c) => ({ ...c, ...Object.fromEntries(list.map((o) => [o.name, { ...cfg(o), on: false }])) }))}>None</button>
      </div>
      <div className="sy-scroll">
        <table className="sy-table">
          <thead><tr><th scope="col" aria-label="Copy" /><th scope="col">Source</th><th scope="col">Target table</th><th scope="col">Table</th><th scope="col">Rows</th><th scope="col">Columns</th></tr></thead>
          <tbody>
            {list.map((o) => {
              const c = cfg(o)
              const all = cols[colKey(o)] ?? []
              return (
                <Fragment key={o.name}>
                  <tr className={c.on ? '' : 'off'}>
                    <td><input type="checkbox" aria-label={`Copy ${o.name}`} checked={c.on} onChange={(e) => set(o, { on: e.target.checked })} /></td>
                    <td className="mono">{o.name}{o.kind !== 'table' && <span className="muted"> (view)</span>}</td>
                    <td><input className="input sm mono" aria-label={`Target name for ${o.name}`} value={c.target} disabled={!c.on} onChange={(e) => set(o, { target: e.target.value })} /></td>
                    <td>
                      <select className="select sm" aria-label={`Target table handling for ${o.name}`} value={c.create} disabled={!c.on} onChange={(e) => set(o, { create: e.target.value as Create })}>
                        {CREATE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                    <td>
                      <div className="row">
                        <select className="select sm" aria-label={`Rows to copy from ${o.name}`} value={c.rows} disabled={!c.on} onChange={(e) => set(o, { rows: e.target.value as Conf['rows'] })}>
                          <option value="all">All rows</option>
                          <option value="where">Rows where…</option>
                          <option value="none">No rows</option>
                        </select>
                        {c.rows === 'where' && <input className="input sm mono" aria-label={`Row condition for ${o.name}`} placeholder="e.g. created_at > '2024-01-01'" value={c.where} disabled={!c.on} onChange={(e) => set(o, { where: e.target.value })} />}
                      </div>
                    </td>
                    <td><button className="btn sm" aria-expanded={!!c.open} disabled={!c.on} onClick={() => openCols(o)}>{c.columns ? `${c.columns.length} of ${all.length || '…'}` : 'All'}</button></td>
                  </tr>
                  {c.open && c.on && (
                    <tr className="sy-detail">
                      <td />
                      <td colSpan={5}>
                        <div className="row">
                          <button className="btn sm" onClick={() => set(o, { columns: null })}>All</button>
                          <button className="btn sm" onClick={() => set(o, { columns: [] })}>None</button>
                        </div>
                        <div className="sy-colgrid" role="group" aria-label={`Columns of ${o.name}`}>
                          {all.map((col) => {
                            const on = !c.columns || c.columns.includes(col.name)
                            return (
                              <label key={col.name} className="check">
                                <input type="checkbox" checked={on} onChange={(e) => {
                                  const cur = c.columns ?? all.map((x) => x.name)
                                  const next = e.target.checked ? all.map((x) => x.name).filter((n) => cur.includes(n) || n === col.name) : cur.filter((n) => n !== col.name)
                                  set(o, { columns: next.length === all.length ? null : next })
                                }} />
                                <span className="mono ellipsis">{col.name}</span><span className="faint">{col.type}</span>
                              </label>
                            )
                          })}
                          {!all.length && <span className="muted">Loading columns…</span>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="sy-opts" role="group" aria-label="Options">
        <label className="check">Rows per batch <input className="input sm" type="number" min={1} max={50000} style={{ width: 80 }} value={batch} onChange={(e) => setBatch(Math.max(1, Math.min(50000, Number(e.target.value) || 1)))} /></label>
        <label className="check"><input type="checkbox" checked={tx} onChange={(e) => setTx(e.target.checked)} /> One transaction per table</label>
        <label className="check"><input type="checkbox" checked={coe} onChange={(e) => setCoe(e.target.checked)} /> Continue on error</label>
        <label className="check" title="MySQL and SQLite switch the checks off for the transfer. PostgreSQL needs a superuser; otherwise tables simply load parents first.">
          <input type="checkbox" checked={noFk} onChange={(e) => setNoFk(e.target.checked)} /> Turn off foreign key checks while loading
        </label>
      </div>
      <MaskingOptions on={masking} setOn={setMasking} columns={[...new Set(checked.flatMap((o) => (cols[colKey(o)] ?? []).map((c) => c.name)))]} />
      {log && <pre className="code sy-log" aria-label="Transfer summary">{log}</pre>}
    </Modal>
  )
}
