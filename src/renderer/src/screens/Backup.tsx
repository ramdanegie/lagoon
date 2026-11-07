// Backup / Restore windows: pick a connection and database, a dump tool, options, then stream the tool's log.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Connection } from '@shared/types'
import { DRIVERS } from '@shared/types'
import { expandPattern, isArchiveFormat } from '@shared/importexport'
import { call, errText, fail } from '../lib/api'
import { ws, guard } from '../lib/ws'
import { Modal, confirmDialog, promptDialog, menuBelow } from '../components/ui'
import { DRIVER_COLORS } from './ConnectionForm'
import { useJobs, JobStatus } from './ImportExport'
import '../styles/importexport.css'

type Mode = 'backup' | 'restore'
type Family = 'pg' | 'my'
interface Tool { path: string; version: string }
interface Asked { password?: string; sshPassword?: string }

const PRESETS: Record<Mode, Record<Family, string[]>> = {
  backup: {
    pg: ['--format=custom', '--verbose', '--data-only', '--schema-only', '--clean', '--create', '--no-owner', '--no-privileges'],
    my: ['--single-transaction', '--verbose', '--set-gtid-purged=OFF', '--routines', '--triggers', '--events', '--no-data', '--no-create-info', '--add-drop-table']
  },
  restore: {
    pg: ['--single-transaction', '--verbose', '--clean', '--create', '--exit-on-error', '--no-owner', '--data-only', '--schema-only'],
    my: ['--force', '--one-database']
  }
}
const DEFAULT_OPTS: Record<Mode, Record<Family, string>> = {
  backup: { pg: '--format=custom --verbose', my: '--single-transaction --verbose' },
  restore: { pg: '--single-transaction --verbose', my: '' }
}

export const BackupDialog = (p: { connections: Connection[]; onClose: () => void }): ReactNode => <ToolDialog mode="backup" {...p} />
export const RestoreDialog = (p: { connections: Connection[]; onClose: () => void }): ReactNode => <ToolDialog mode="restore" {...p} />

/** Safe mode: the workspace guard for its own connection; in the Welcome window the connection's level is applied here. */
async function safeOk(c: Connection, what: string): Promise<boolean> {
  if (ws().conn?.id === c.id) return guard([what])
  if (!c.safeMode) return true
  // levels 3–4 want the stored password; connections without one fall back to a confirmation
  if (c.safeMode <= 2 || c.passwordMode !== 'store') return confirmDialog('Safe mode', what, { ok: 'Continue' })
  const pw = await promptDialog('Safe mode', '', { password: true, message: `${what}\n\nEnter the connection password to continue.`, ok: 'Continue' })
  if (pw === null) return false
  if (await call<boolean>('conn.checkStoredPassword', c.id, pw)) return true
  fail('Wrong password.')
  return false
}

function ToolDialog({ mode, connections, onClose }: { mode: Mode; connections: Connection[]; onClose: () => void }): ReactNode {
  const [connId, setConnId] = useState(connections[0]?.id)
  const conn = connections.find((c) => c.id === connId)
  const fam: Family = conn?.driver === 'postgres' ? 'pg' : 'my'
  const supported = !!conn && ['postgres', 'mysql', 'mariadb'].includes(conn.driver)
  const [asked, setAsked] = useState<Asked>({})
  const [dbs, setDbs] = useState<string[]>([])
  const [db, setDb] = useState('')
  const [tools, setTools] = useState<Tool[]>([])
  const [tool, setTool] = useState('')
  const optsFor = (c?: Connection): string => {
    if (!c) return ''
    const saved = mode === 'backup' ? c.options?.backupOptions : c.options?.restoreOptions
    // MySQL dumps carry GTID_PURGED by default, which fails when restoring on the same server (MariaDB's tool lacks the flag)
    return saved ?? DEFAULT_OPTS[mode][c.driver === 'postgres' ? 'pg' : 'my'] + (mode === 'backup' && c.driver === 'mysql' ? ' --set-gtid-purged=OFF' : '')
  }
  const [opts, setOpts] = useState(() => optsFor(connections[0]))
  const [pattern, setPattern] = useState('{connection}_{database}_{date}')
  const [gzip, setGzip] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [jobId, setJobId] = useState<string>()
  const job = useJobs((s) => s.list.find((j) => j.id === jobId))
  const log = useJobs((s) => (jobId ? s.logs[jobId] : undefined))
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [log])
  const running = job?.state === 'running'
  const plain = mode === 'backup' && (fam === 'my' || !isArchiveFormat(opts))

  const loadDbs = async (c: Connection, a: Asked, select?: string): Promise<void> => {
    setLoading(true)
    setErr('')
    try {
      const list = await call<string[]>('backup.databases', c.id, a)
      const pref = select ?? (ws().conn?.id === c.id ? ws().database : undefined) ?? c.database
      setDbs(list)
      setDb(pref && list.includes(pref) ? pref : list[0] ?? '')
    } catch (e) { setErr(errText(e)) } finally { setLoading(false) }
  }

  const connect = async (c: Connection): Promise<void> => {
    const a: Asked = {}
    if (c.passwordMode === 'ask') {
      const pw = await promptDialog(`Password for ${c.name}`, '', { password: true, ok: 'Continue' })
      if (pw === null) { setErr('The database password is needed to continue.'); return }
      a.password = pw
    }
    if (c.ssh?.enabled && !c.ssh.useKey && c.ssh.passwordMode === 'ask') {
      const pw = await promptDialog(`SSH password for ${c.name}`, '', { password: true, ok: 'Continue' })
      if (pw === null) { setErr('The SSH password is needed to continue.'); return }
      a.sshPassword = pw
    }
    setAsked(a)
    await loadDbs(c, a)
  }

  const pickConn = (c: Connection): void => {
    if (running || c.id === connId) return
    setConnId(c.id); setDbs([]); setDb(''); setTools([]); setTool(''); setErr(''); setJobId(undefined); setOpts(optsFor(c))
  }

  useEffect(() => {
    if (!conn || !supported) return
    let alive = true
    call<Tool[]>('backup.tools', conn.driver).then((found) => {
      if (!alive) return
      const saved = fam === 'pg' ? conn.options?.pgDumpPath : conn.options?.mysqldumpPath
      const list = saved && !found.some((t) => t.path === saved) ? [...found, { path: saved, version: 'Saved choice' }] : found
      setTools(list)
      setTool(saved ?? list[0]?.path ?? '')
    }, fail)
    void connect(conn)
    return () => { alive = false }
  }, [connId])

  const chooseTool = async (): Promise<void> => {
    const [p] = await call<string[]>('job.open', { title: `Choose ${fam === 'pg' ? 'pg_dump' : 'mysqldump'}`, properties: ['openFile', 'showHiddenFiles'] })
    if (!p) return
    try {
      const t = await call<Tool>('backup.addTool', p)
      setTools((l) => [...l.filter((x) => x.path !== p), t])
      setTool(p)
    } catch (e) { fail(e) }
  }

  const newDatabase = async (): Promise<void> => {
    if (!conn) return
    const name = (await promptDialog('New database', '', { ok: 'Create', message: 'The backup is restored into this new, empty database.' }))?.trim()
    if (!name) return
    try {
      await call('backup.createDatabase', conn.id, name, asked)
      await loadDbs(conn, asked, name)
    } catch (e) { fail(e) }
  }

  const toggleOpt = (o: string): void => {
    const parts = opts.split(/\s+/).filter(Boolean)
    setOpts((parts.includes(o) ? parts.filter((x) => x !== o) : [...parts, o]).join(' '))
  }

  const start = async (): Promise<void> => {
    if (!conn || !db || !tool) return
    const file = mode === 'backup'
      ? await call<string | undefined>('job.save', { title: 'Save backup as', defaultPath: `${expandPattern(pattern, { connection: conn.name, database: db })}.${plain ? 'sql' : 'dump'}${plain && gzip ? '.gz' : ''}` })
      : (await call<string[]>('job.open', { title: 'Choose a backup file', properties: ['openFile'], filters: [{ name: 'Backups', extensions: ['dump', 'backup', 'sql', 'gz', 'tar'] }, { name: 'All files', extensions: ['*'] }] }))[0]
    if (!file) return
    if (!(await safeOk(conn, mode === 'backup' ? `Back up "${db}" to ${file}` : `Restore ${file} into "${db}"`))) return
    try {
      // remember the tool and options for this connection (fresh copy so other option edits are kept)
      const fresh = await call<Connection>('conn.get', conn.id)
      void call('conn.patch', conn.id, { options: { ...fresh.options, [fam === 'pg' ? 'pgDumpPath' : 'mysqldumpPath']: tool, [mode === 'backup' ? 'backupOptions' : 'restoreOptions']: opts } })
      setJobId(await call<string>(`${mode}.run`, { connectionId: conn.id, database: db, tool, options: opts, file, gzip: plain && gzip, asked }))
    } catch (e) { fail(e) }
  }

  const engine = conn ? DRIVERS.find((d) => d.id === conn.driver)?.name : ''
  const verb = mode === 'backup' ? 'Backup' : 'Restore'
  return (
    <Modal
      title={`${verb} database`}
      onClose={onClose}
      width={860}
      footer={
        <>
          <div className="grow">{job && <JobStatus job={job} />}</div>
          {running ? (
            <>
              <button className="btn" onClick={() => void call('job.cancel', job.id)}>Cancel {mode}</button>
              <button className="btn" onClick={onClose}>Continue in background</button>
            </>
          ) : (
            <>
              {job?.state === 'done' && job.output && <button className="btn" onClick={() => void call('shell.reveal', job.output)}>Show in folder</button>}
              <button className="btn" onClick={onClose}>Close</button>
              <button className="btn primary" disabled={!supported || !db || !tool || loading} onClick={() => void start()}>Start {mode}…</button>
            </>
          )}
        </>
      }
    >
      <div className="ie-tool">
        <div className="ie-conns" role="listbox" aria-label="Connections">
          {connections.length === 0 && <div className="empty">No saved connections.</div>}
          {connections.map((c) => (
            <div
              key={c.id}
              role="option"
              aria-selected={c.id === connId}
              tabIndex={0}
              className={`conn-item ${c.id === connId ? 'selected' : ''}`}
              onClick={() => pickConn(c)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickConn(c) } }}
            >
              <div className="drv" style={{ background: DRIVER_COLORS[c.driver] }}>{DRIVERS.find((d) => d.id === c.driver)?.short}</div>
              <div className="grow"><div className="ellipsis">{c.name}</div><div className="meta ellipsis">{c.database || c.host || c.filePath}</div></div>
            </div>
          ))}
        </div>
        {!conn ? (
          <div className="empty">Choose a connection.</div>
        ) : !supported ? (
          <div className="empty">
            {verb} is not supported for {engine}.
            {conn.driver === 'sqlite' && <div>SQLite users can copy the database file, or export the tables to SQL.</div>}
          </div>
        ) : (
          <div className="col" style={{ gap: 'var(--sp-5)', minWidth: 0 }}>
            <div className="fieldset">
              <div className="field">
                <label htmlFor="bk-db">{mode === 'backup' ? 'Database' : 'Restore into'}</label>
                <div className="row">
                  <select id="bk-db" className="select grow" value={db} disabled={running || loading} onChange={(e) => (e.target.value === '__new' ? void newDatabase() : setDb(e.target.value))}>
                    {!dbs.length && <option value="">{loading ? 'Loading…' : 'No databases'}</option>}
                    {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
                    {mode === 'restore' && dbs.length > 0 && <option value="__new">New database…</option>}
                  </select>
                  {err && <button className="btn" onClick={() => void connect(conn)}>Retry</button>}
                </div>
              </div>
              <div className="field">
                <label htmlFor="bk-tool">{mode === 'backup' ? 'Dump tool' : 'Tool version'}</label>
                <select id="bk-tool" className="select" value={tool} disabled={running} onChange={(e) => (e.target.value === '__choose' ? void chooseTool() : setTool(e.target.value))}>
                  {!tools.length && <option value="">No {fam === 'pg' ? 'pg_dump' : 'mysqldump'} found — choose one</option>}
                  {tools.map((t) => <option key={t.path} value={t.path}>{t.version} — {t.path}</option>)}
                  <option value="__choose">Choose…</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="bk-opts">Options</label>
                <div className="row">
                  <input id="bk-opts" className="input mono grow" value={opts} disabled={running} onChange={(e) => setOpts(e.target.value)} />
                  <button className="btn" disabled={running} aria-haspopup="menu" onClick={(e) => menuBelow(e.currentTarget, PRESETS[mode][fam].map((o) => ({ label: o, checked: opts.split(/\s+/).includes(o), onClick: () => toggleOpt(o) })))}>Add option</button>
                </div>
              </div>
              {mode === 'backup' && (
                <>
                  <div className="field">
                    <label htmlFor="bk-name">File name</label>
                    <input id="bk-name" className="input mono" value={pattern} disabled={running} onChange={(e) => setPattern(e.target.value)} />
                  </div>
                  <div className="field">
                    <span />
                    <div className="col" style={{ gap: 'var(--sp-2)' }}>
                      <span className="muted mono ellipsis" style={{ fontSize: 'var(--fs-sm)' }}>{expandPattern(pattern, { connection: conn.name, database: db })}.{plain ? 'sql' : 'dump'}{plain && gzip ? '.gz' : ''} · tokens: {'{connection} {database} {date} {time}'}</span>
                      <label className="check"><input type="checkbox" checked={plain && gzip} disabled={!plain || running} onChange={(e) => setGzip(e.target.checked)} /> Compress with gzip{plain ? '' : ' (plain SQL only; the custom format is already compressed)'}</label>
                    </div>
                  </div>
                </>
              )}
              {mode === 'restore' && fam === 'pg' && <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Archives (custom/tar) go through pg_restore. Plain .sql files run through psql when it sits next to the selected tool; otherwise use Import ▸ From SQL Dump.</div>}
            </div>
            {err && <div className="danger-text selectable">{err}</div>}
            {jobId && <pre ref={logRef} className="code ie-log" role="log" aria-live="polite" aria-label={`${verb} log`}>{log || 'Starting…'}</pre>}
          </div>
        )}
      </div>
    </Modal>
  )
}
