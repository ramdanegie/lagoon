// Automation: saved tasks (run SQL, export tables, back up) on a schedule, with their run history. Main runs them.
import { type ReactNode, useEffect, useState } from 'react'
import type { Connection } from '@shared/types'
import { DAYS, scheduleText, type AutoRun, type AutoTask, type Schedule, type TaskAction } from '@shared/automation'
import { EXPORT_FORMATS, type ExportFormat } from '@shared/importexport'
import { call, errText, fail, on, toast } from '../lib/api'
import { ws } from '../lib/ws'
import { Modal, confirmDialog } from '../components/ui'
import { Icon } from '../components/Icon'
import '../styles/importexport.css'

type State = { tasks: AutoTask[]; runs: AutoRun[]; running: string[] }
const SQL_DRIVERS = ['postgres', 'mysql', 'mariadb', 'sqlite']
const when = (t: number): string => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const schemaFor = (c: Connection | undefined, database?: string): string => (c?.driver === 'postgres' ? 'public' : c?.driver === 'sqlite' ? 'main' : database || c?.database || '')
const ACTIONS: { type: TaskAction['type']; label: string }[] = [{ type: 'sql', label: 'Run SQL' }, { type: 'export', label: 'Export tables' }, { type: 'backup', label: 'Back up' }]

function blankAction(type: TaskAction['type'], c?: Connection): TaskAction {
  if (type === 'sql') return { type, sql: '' }
  if (type === 'export') return { type, schema: schemaFor(c), tables: [], format: 'csv', folder: '', pattern: '{table}_{date}_{time}', mask: false }
  return { type, folder: '', pattern: '{database}_{date}_{time}', gzip: true }
}

export function AutomationDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [st, setSt] = useState<State>({ tasks: [], runs: [], running: [] })
  const [conns, setConns] = useState<Connection[]>([])
  const [draft, setDraft] = useState<AutoTask | null>(null)
  const [shownLog, setShownLog] = useState<AutoRun | null>(null)
  const reload = (): void => void call<State>('automation.list').then(setSt, fail)
  useEffect(() => { reload(); return on('automation:changed', reload) }, [])
  useEffect(() => { void call<Connection[]>('conn.list').then((c) => setConns(c.filter((x) => SQL_DRIVERS.includes(x.driver))), fail) }, [])

  const conn = conns.find((c) => c.id === draft?.connectionId)
  const newTask = (): void => {
    const c = conns.find((x) => x.id === ws().conn?.id) ?? conns[0]
    setDraft({ id: '', name: 'Nightly export', enabled: true, connectionId: c?.id ?? '', database: ws().conn?.id === c?.id ? ws().database : undefined, action: blankAction('export', c), schedule: { kind: 'daily', time: '02:00' } })
  }
  const set = (p: Partial<AutoTask>): void => setDraft((d) => (d ? { ...d, ...p } : d))
  const setAction = (p: Partial<TaskAction>): void => setDraft((d) => (d ? { ...d, action: { ...d.action, ...p } as TaskAction } : d))
  const pickFolder = async (): Promise<void> => {
    const [f] = await call<string[]>('job.open', { title: 'Folder for the task\'s files', buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory'] })
    if (f) setAction({ folder: f } as Partial<TaskAction>)
  }
  const problem = !draft ? '' : !draft.connectionId ? 'Choose a connection.' : draft.action.type === 'sql' ? (draft.action.sql.trim() ? '' : 'Write the SQL to run.') : !draft.action.folder ? 'Choose a folder for the files.' : ''
  const save = async (): Promise<void> => {
    if (!draft || problem) return
    try { setDraft(await call<AutoTask>('automation.save', draft)); toast('Task saved', 'success') } catch (e) { fail(e) }
  }
  const remove = async (t: AutoTask): Promise<void> => {
    if (!(await confirmDialog(`Delete "${t.name}"?`, 'Its run history stays.', { ok: 'Delete', danger: true }))) return
    await call('automation.delete', t.id)
    setDraft(null)
  }
  const last = (id: string): AutoRun | undefined => st.runs.find((r) => r.taskId === id)
  const a = draft?.action
  const s = draft?.schedule

  return (
    <Modal title="Automation" onClose={onClose} width={1040} footer={<><span className="grow muted">Tasks run while Lagoon is open. A run missed while it was closed runs once at the next start.</span><button className="btn" onClick={onClose}>Close</button></>}>
      <div className="auto-layout">
        <div className="col" style={{ gap: 'var(--sp-3)', minHeight: 0 }}>
          <button className="btn" onClick={newTask} disabled={!conns.length} title={conns.length ? undefined : 'Add a SQL connection first'}><Icon name="plus" size={12} /> New task</button>
          <div className="auto-list" role="listbox" aria-label="Tasks">
            {st.tasks.map((t) => {
              const r = last(t.id)
              const busy = st.running.includes(t.id)
              return (
                <div key={t.id} role="option" aria-selected={draft?.id === t.id} className={`auto-item ${draft?.id === t.id ? 'on' : ''}`} onClick={() => setDraft(structuredClone(t))}>
                  <div className="row" style={{ gap: 'var(--sp-2)' }}>
                    <b className="ellipsis grow">{t.name}</b>
                    {busy ? <span className="muted">Running…</span> : r && <span className={r.ok ? 'ok-text' : 'danger-text'} title={r.message}>{r.ok ? '✓' : '✗'}</span>}
                  </div>
                  <span className="muted ellipsis">{t.enabled ? scheduleText(t.schedule) : 'Off'}{t.enabled && t.nextAt ? ` · next ${when(t.nextAt)}` : ''}</span>
                </div>
              )
            })}
            {!st.tasks.length && <div className="muted" style={{ padding: 'var(--sp-4)' }}>No tasks yet.</div>}
          </div>
        </div>

        {draft && a && s ? (
          <div className="col auto-edit">
            <div className="field"><label htmlFor="au-name">Name</label><input id="au-name" className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} /></div>
            <div className="field">
              <label htmlFor="au-conn">Connection</label>
              <div className="row">
                <select id="au-conn" className="select grow" value={draft.connectionId} onChange={(e) => { const c = conns.find((x) => x.id === e.target.value); set({ connectionId: e.target.value, database: undefined, action: a.type === 'export' ? { ...a, schema: schemaFor(c) } : a }) }}>
                  {!conn && <option value="">Choose…</option>}
                  {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {conn?.driver !== 'sqlite' && <input className="input" aria-label="Database" style={{ width: 180 }} placeholder={conn?.database || 'Database'} value={draft.database ?? ''} onChange={(e) => set({ database: e.target.value || undefined })} />}
              </div>
            </div>
            {conn?.passwordMode === 'ask' && <div className="danger-text" style={{ fontSize: 'var(--fs-sm)' }}>This connection asks for its password every time, so the task cannot run on its own. Save the password in the connection.</div>}
            <div className="field">
              <span>Task</span>
              <div className="seg" role="tablist" aria-label="Task">
                {ACTIONS.map((x) => <button key={x.type} role="tab" aria-selected={a.type === x.type} className={a.type === x.type ? 'on' : ''} onClick={() => a.type !== x.type && set({ action: blankAction(x.type, conn) })}>{x.label}</button>)}
              </div>
            </div>
            {a.type === 'sql' && <div className="field"><label htmlFor="au-sql">SQL</label><textarea id="au-sql" className="input mono" rows={6} style={{ height: 'auto', resize: 'vertical' }} placeholder="DELETE FROM sessions WHERE expires_at < now();" value={a.sql} onChange={(e) => setAction({ sql: e.target.value })} /></div>}
            {a.type === 'export' && (
              <>
                <div className="field"><label htmlFor="au-schema">{conn?.driver === 'postgres' ? 'Schema' : 'Database'}</label><input id="au-schema" className="input mono" value={a.schema} onChange={(e) => setAction({ schema: e.target.value })} /></div>
                <div className="field"><label htmlFor="au-tables">Tables</label><input id="au-tables" className="input mono" placeholder="All tables" value={a.tables.join(', ')} onChange={(e) => setAction({ tables: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></div>
                <div className="field">
                  <label htmlFor="au-format">Format</label>
                  <select id="au-format" className="select" value={a.format} onChange={(e) => setAction({ format: e.target.value as ExportFormat })}>
                    {EXPORT_FORMATS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                </div>
                <div className="field"><span /><label className="check"><input type="checkbox" checked={a.mask} onChange={(e) => setAction({ mask: e.target.checked })} /> Mask sensitive columns (rules from the Export dialog)</label></div>
              </>
            )}
            {a.type === 'backup' && <div className="field"><span /><div className="col" style={{ gap: 'var(--sp-2)' }}><label className="check"><input type="checkbox" checked={a.gzip} onChange={(e) => setAction({ gzip: e.target.checked })} /> Compress with gzip</label><span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Uses pg_dump or mysqldump, like File ▸ Backup Database.</span></div></div>}
            {a.type !== 'sql' && (
              <>
                <div className="field">
                  <label>Folder</label>
                  <div className="row"><button className="btn sm" onClick={() => void pickFolder()}>{a.folder ? 'Change…' : 'Choose…'}</button><span className="mono muted ellipsis grow" title={a.folder}>{a.folder || 'No folder chosen'}</span></div>
                </div>
                <div className="field"><label htmlFor="au-pattern">File names</label><input id="au-pattern" className="input mono" value={a.pattern} onChange={(e) => setAction({ pattern: e.target.value })} /></div>
              </>
            )}
            <div className="field">
              <label htmlFor="au-when">Runs</label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <select id="au-when" className="select" style={{ width: 'auto' }} value={s.kind} onChange={(e) => {
                  const k = e.target.value as Schedule['kind']
                  set({ schedule: k === 'interval' ? { kind: k, minutes: 60 } : k === 'daily' ? { kind: k, time: '02:00' } : k === 'weekly' ? { kind: k, day: 1, time: '02:00' } : { kind: 'manual' } })
                }}>
                  <option value="manual">By hand only</option>
                  <option value="interval">Every few minutes</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
                {s.kind === 'interval' && <label className="check">every <input className="input sm" type="number" min={1} style={{ width: 70 }} aria-label="Minutes" value={s.minutes} onChange={(e) => set({ schedule: { ...s, minutes: Math.max(1, Number(e.target.value) || 1) } })} /> minutes</label>}
                {s.kind === 'weekly' && <select className="select" style={{ width: 'auto' }} aria-label="Day" value={s.day} onChange={(e) => set({ schedule: { ...s, day: Number(e.target.value) } })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>}
                {(s.kind === 'daily' || s.kind === 'weekly') && <input className="input" type="time" aria-label="Time" style={{ width: 120 }} value={s.time} onChange={(e) => set({ schedule: { ...s, time: e.target.value } })} />}
              </div>
            </div>
            {s.kind !== 'manual' && <div className="field"><span /><label className="check"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Run on this schedule</label></div>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              {problem && <span className="muted grow" style={{ fontSize: 'var(--fs-sm)' }}>{problem}</span>}
              {draft.id && <button className="btn" onClick={() => void remove(draft)}>Delete</button>}
              {draft.id && <button className="btn" disabled={st.running.includes(draft.id)} onClick={() => void call('automation.run', draft.id).catch(fail)}><Icon name="play" size={11} /> Run now</button>}
              <button className="btn primary" disabled={!!problem} onClick={() => void save()}>Save</button>
            </div>
          </div>
        ) : (
          <div className="empty">Choose a task, or create one to export, back up or run SQL on a schedule.</div>
        )}
      </div>

      <div className="row" style={{ marginTop: 'var(--sp-4)' }}><b className="grow">History</b>{st.runs.length > 0 && <button className="btn sm ghost" onClick={() => void call('automation.clearHistory')}>Clear</button>}</div>
      <div className="auto-history">
        <table className="ie-map">
          <thead><tr><th scope="col">Started</th><th scope="col">Task</th><th scope="col">Result</th><th scope="col">Took</th><th scope="col" aria-label="Log" /></tr></thead>
          <tbody>
            {st.runs.map((r, i) => (
              <tr key={i}>
                <td>{when(r.start)}</td>
                <td className="ellipsis">{r.name}</td>
                <td className={`ellipsis ${r.ok ? '' : 'danger-text'}`} title={r.message}>{r.ok ? '✓ ' : '✗ '}{r.message}</td>
                <td>{((r.end - r.start) / 1000).toFixed(1)} s</td>
                <td>
                  {r.output && <button className="btn sm ghost" onClick={() => void call('shell.reveal', r.output).catch((e) => toast(errText(e), 'error'))}>Show</button>}
                  {r.log && <button className="btn sm ghost" onClick={() => setShownLog(r)}>Log</button>}
                </td>
              </tr>
            ))}
            {!st.runs.length && <tr><td colSpan={5} className="muted">Nothing has run yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {shownLog && (
        <Modal title={`Log · ${shownLog.name}`} onClose={() => setShownLog(null)} width={720} footer={<button className="btn" onClick={() => setShownLog(null)}>Close</button>}>
          <pre className="code selectable" style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{shownLog.log}</pre>
        </Modal>
      )}
    </Modal>
  )
}
