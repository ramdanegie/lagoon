import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Result } from '@shared/types'
import { DRIVERS } from '@shared/types'
import { call, errText, fail, toast } from '../lib/api'
import { useWs, guard } from '../lib/ws'
import { COPY_FORMATS, formatRows, type CopyFormat } from '../lib/format'
import { Grid, type Sel } from '../components/Grid'
import { Modal, confirmDialog, menuAt } from '../components/ui'
import { Icon } from '../components/Icon'
import '../styles/admin.css'

const SUPPORTED = ['postgres', 'mysql', 'mariadb']

/** Running queries on the server; select rows and stop them. */
export function ProcessList({ onClose }: { onClose: () => void }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const driver = useWs((s) => s.conn?.driver)
  const isPg = driver === 'postgres'
  const [res, setRes] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [auto, setAuto] = useState(false)
  const [db, setDb] = useState('')
  const [sel, setSel] = useState<Sel | null>(null)
  const [gridKey, setGridKey] = useState(0)
  const selRef = useRef<Sel | null>(null)

  const select = (s: Sel | null): void => { selRef.current = s; setSel(s) }
  // a fresh list with the old selection would point at different processes, so a manual refresh clears it
  const load = async (clear = true): Promise<void> => {
    try {
      setRes(await call<Result>('db.processes', sessionId))
      setError('')
    } catch (e) { setError(errText(e)) }
    if (clear) { select(null); setGridKey((k) => k + 1) }
  }
  useEffect(() => { if (driver && SUPPORTED.includes(driver)) void load() }, [])
  // auto-refresh holds while rows are selected, so Kill acts on what is on screen
  useEffect(() => {
    if (!auto || sel) return
    const t = setInterval(() => void load(false), 2000)
    return () => clearInterval(t)
  }, [auto, sel])

  if (!driver || !SUPPORTED.includes(driver)) {
    return (
      <Modal title="Process list" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
        <div className="empty">The process list is not supported for {DRIVERS.find((d) => d.id === driver)?.name ?? 'this connection'}.</div>
      </Modal>
    )
  }

  const cols = res?.columns ?? []
  const dbIdx = isPg ? -1 : cols.findIndex((c) => c.name.toUpperCase() === 'DB')
  const idIdx = cols.findIndex((c) => /^(pid|id)$/i.test(c.name))
  const all = res?.rows ?? []
  const rows = db ? all.filter((r) => String(r[dbIdx] ?? '') === db) : all
  const dbs = dbIdx >= 0 ? [...new Set(all.map((r) => r[dbIdx]).filter((v) => v !== null && v !== undefined).map(String))].sort() : []
  const picked = (s: Sel | null): unknown[][] => (s ? rows.slice(s.r0, s.r1 + 1) : [])
  const ids = picked(sel).map((r) => String(r[idIdx]))

  const kill = async (): Promise<void> => {
    if (!ids.length) return
    const stmts = ids.map((id) => (isPg ? `SELECT pg_cancel_backend(${Number(id)});` : `KILL QUERY ${Number(id)};`))
    const ok = await confirmDialog(`Stop ${ids.length} running ${ids.length > 1 ? 'queries' : 'query'}?`, `${stmts.join('\n')}\n\nOnly the running statement is cancelled; the client stays connected.`, { ok: 'Kill', danger: true })
    if (!ok || !(await guard(stmts))) return
    let n = 0
    for (const id of ids) await call('db.kill', sessionId, id).then(() => n++, fail)
    if (n) toast(`Sent cancel to ${n} process${n > 1 ? 'es' : ''}`, 'success')
    void load()
  }

  const copy = (fmt: CopyFormat): void => {
    const r = picked(selRef.current)
    if (r.length) void navigator.clipboard.writeText(formatRows(fmt, cols.map((c) => c.name), r))
  }

  return (
    <Modal
      title={<><Icon name="terminal" /><span>Process list</span></>}
      onClose={onClose}
      width={1000}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto' }} aria-live="polite">{rows.length} process{rows.length === 1 ? '' : 'es'}{ids.length ? ` · ${ids.length} selected` : ''}</span>
          <button className="btn danger" disabled={!ids.length || idIdx < 0} onClick={() => void kill()}>Kill{ids.length > 1 ? ` ${ids.length}` : ''}</button>
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="row">
        <button className="btn" onClick={() => void load()}><Icon name="refresh" size={12} />Refresh</button>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Auto-refresh every 2 s</label>
        {auto && sel && <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>paused while rows are selected (Esc clears)</span>}
        <span className="grow" />
        {dbIdx >= 0 && (
          <select className="select" aria-label="Database" value={db} onChange={(e) => { setDb(e.target.value); select(null); setGridKey((k) => k + 1) }}>
            <option value="">All databases</option>
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
      </div>
      {error && <div className="danger-text selectable">{error}</div>}
      <div className="pl-grid">
        <Grid
          key={gridKey}
          columns={cols.map((c) => ({ name: c.name, type: c.type }))}
          rows={rows}
          onSelect={select}
          onCopy={(e, s) => e.clipboardData?.setData('text/plain', formatRows('plain', cols.slice(s.c0, s.c1 + 1).map((c) => c.name), picked(s).map((r) => r.slice(s.c0, s.c1 + 1))))}
          onCellMenu={(e) => menuAt(e, COPY_FORMATS.filter((f) => f.id !== 'insert').map((f) => ({ label: `Copy Rows as ${f.label}`, onClick: () => copy(f.id) })))}
          empty={res ? 'No running queries' : 'Loading…'}
        />
      </div>
    </Modal>
  )
}
