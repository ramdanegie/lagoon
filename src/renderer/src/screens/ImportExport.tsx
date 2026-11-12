// Import wizards (CSV / JSON / SQL dump), table export, result export, and the background-jobs bell.
import { type ReactNode, type MouseEvent as RME, useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Column, DbObject, JobProgress } from '@shared/types'
import { TYPE_LIST, qt } from '@shared/sqlgen'
import { matchColumns, detectType, textType, expandPattern, needsKeys, CSV_DEFAULTS, EXPORT_FORMATS, exportExt, type CsvOut, type Matching, type Conflict, type ExportFormat as Fmt } from '@shared/importexport'
import { call, on, toast, fail, errText } from '../lib/api'
import { useWs, ws, guard, loadObjects } from '../lib/ws'
import { Modal, Popover, confirmDialog, menuAt, type MenuItem } from '../components/ui'
import { Grid } from '../components/Grid'
import { Icon } from '../components/Icon'
import '../styles/importexport.css'

// ---------- jobs store (also used by Backup.tsx) ----------
export const useJobs = create<{ list: JobProgress[]; logs: Record<string, string> }>(() => ({ list: [], logs: {} }))
call<JobProgress[]>('job.list').then((list) => useJobs.setState({ list })).catch(() => {})
on('job:log', (id: string, text: string) => useJobs.setState((s) => ({ logs: { ...s.logs, [id]: ((s.logs[id] ?? '') + text).slice(-200000) } })))
on('job:progress', (p: JobProgress) => {
  const prev = useJobs.getState().list.find((x) => x.id === p.id)
  useJobs.setState((s) => ({ list: prev ? s.list.map((x) => (x.id === p.id ? p : x)) : [p, ...s.list].slice(0, 30) }))
  if (p.state === 'running' || (prev && prev.state !== 'running')) return
  if (p.state === 'done') {
    toast(`${p.title}: ${p.message ?? 'finished'}`, 'success')
    if (p.kind === 'import') void loadObjects().then(() => window.dispatchEvent(new CustomEvent('ws:reload')))
  } else if (p.state === 'failed') toast(`${p.title} failed: ${p.message ?? ''}`, 'error')
})
const useJob = (id?: string): JobProgress | undefined => useJobs((s) => s.list.find((j) => j.id === id))
const STATE = { running: 'Running', done: 'Finished', failed: 'Failed', cancelled: 'Stopped' }

/** Progress bar + state line. Indeterminate while a running job reports 0. */
export function JobStatus({ job }: { job: JobProgress }): ReactNode {
  return (
    <div className="ie-job" role="status">
      <progress className="ie-progress" max={1} value={job.state === 'running' && !job.progress ? undefined : job.progress} aria-label={job.title} />
      <div className={`ie-job-msg ${job.state === 'failed' ? 'danger-text' : 'muted'}`}>{STATE[job.state]}{job.message ? ` · ${job.message}` : ''}</div>
    </div>
  )
}

export function Notifications(): ReactNode {
  const list = useJobs((s) => s.list)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const running = list.filter((j) => j.state === 'running').length
  return (
    <>
      <button className="btn icon ghost ie-bell" title="Background jobs" aria-label={`Background jobs${running ? `, ${running} running` : ''}`} aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <Icon name="bell" />
        {running > 0 && <span className="ie-badge" aria-hidden>{running}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={340} align="right">
          <div className="ie-jobs">
            {list.length === 0 && <div className="empty">No imports, exports or backups yet.</div>}
            {list.map((j) => (
              <div key={j.id} className="ie-job-row">
                <div className="row"><span className="grow ellipsis" title={j.title}>{j.title}</span>
                  {j.state === 'running' && <button className="btn sm" onClick={() => void call('job.cancel', j.id)}>Stop</button>}
                  {j.state === 'done' && j.output && <button className="btn sm" onClick={() => void call('shell.reveal', j.output)}>Show in folder</button>}
                </div>
                <JobStatus job={j} />
              </div>
            ))}
          </div>
          {list.some((j) => j.state !== 'running') && (
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-3)' }}>
              <button className="btn sm ghost" onClick={() => useJobs.setState((s) => ({ list: s.list.filter((j) => j.state === 'running') }))}>Clear finished</button>
            </div>
          )}
        </Popover>
      )}
    </>
  )
}

const baseName = (p: string): string => p.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '')
const ENCODINGS: [string, string][] = [['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['windows-1252', 'Windows Latin (1252)'], ['macintosh', 'Mac Roman'], ['iso-8859-1', 'ISO Latin-1 (8859-1)'], ['shift_jis', 'Shift JIS']]

function Choice({ id, label, value, options, custom, onChange }: { id: string; label: string; value: string; options: [string, string][]; custom?: boolean; onChange: (v: string) => void }): ReactNode {
  const isPreset = options.some(([v]) => v === value)
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row">
        <select id={id} className="select grow" value={isPreset ? value : '__custom'} onChange={(e) => onChange(e.target.value === '__custom' ? '' : e.target.value)}>
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          {custom && <option value="__custom">Custom…</option>}
        </select>
        {custom && !isPreset && <input className="input" style={{ width: 60 }} aria-label={`Custom ${label.toLowerCase()}`} value={value} maxLength={4} onChange={(e) => onChange(e.target.value)} />}
      </div>
    </div>
  )
}

type Preview = { columns: string[]; rows: unknown[][]; sheets?: string[] } & { text?: string }
const MODES: [Conflict, string][] = [
  ['stop', 'Append: insert rows, stop on a duplicate key'],
  ['skip', 'Skip existing: insert only rows with new keys'],
  ['update', 'Upsert: insert new rows, update existing ones'],
  ['updateOnly', 'Update: change matching rows, ignore the rest'],
  ['replace', 'Replace: delete and re-insert existing rows'],
  ['delete', 'Delete matching: remove rows whose key is in the file'],
  ['truncate', 'Empty the table, then insert']
]
type Over = Record<number, { dest?: string | null; type?: string }>

// ---------- import ----------
export function ImportDialog({ kind, table, onClose }: { kind: 'csv' | 'json' | 'sql' | 'xlsx'; table?: DbObject; onClose: () => void }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const dialect = useWs((s) => s.dialect) ?? 'postgres'
  const curSchema = useWs((s) => s.schema)
  const objects = useWs((s) => s.objects)
  const schema = table?.schema ?? curSchema
  const tables = objects.filter((o) => o.kind === 'table' && o.schema === schema)
  const [path, setPath] = useState('')
  const [encoding, setEncoding] = useState('utf-8')
  const [delimiter, setDelimiter] = useState(',')
  const [quote, setQuote] = useState('"')
  const [header, setHeader] = useState(true)
  const [sheet, setSheet] = useState('')
  const [preview, setPreview] = useState<Preview>()
  const [err, setErr] = useState('')
  const [dest, setDest] = useState<'existing' | 'new'>(table || tables.length ? 'existing' : 'new')
  const [target, setTarget] = useState(table?.name ?? '')
  const [newName, setNewName] = useState('')
  const [allText, setAllText] = useState(false)
  const [matching, setMatching] = useState<Matching>('nameOrder')
  const [ci, setCi] = useState(false)
  const [conflict, setConflict] = useState<Conflict>('stop')
  const [keyPick, setKeyPick] = useState<string[] | null>(null) // null: the primary key
  const [destCols, setDestCols] = useState<Column[]>([])
  const [over, setOver] = useState<Over>({})
  const [jobId, setJobId] = useState<string>()
  const job = useJob(jobId)

  useEffect(() => {
    if (path) call<Preview>('import.preview', { kind, path, encoding, delimiter, quote, header, sheet }).then((p) => { setErr(''); setPreview(p) }, (e) => { setPreview(undefined); setErr(errText(e)) })
  }, [kind, path, encoding, delimiter, quote, header, sheet])
  useEffect(() => {
    if (dest === 'existing' && target && sessionId && schema !== undefined) call<Column[]>('db.columns', sessionId, schema, target).then((c) => setDestCols(c.filter((x) => x.extra !== 'generated')), fail)
  }, [dest, target, sessionId, schema])
  useEffect(() => { if (job?.state === 'done') onClose() }, [job?.state])

  const pick = async (): Promise<void> => {
    const ext = kind === 'csv' ? ['csv', 'tsv', 'txt'] : kind === 'json' ? ['json', 'ndjson', 'jsonl'] : kind === 'xlsx' ? ['xlsx'] : ['sql', 'txt']
    const [f] = await call<string[]>('job.open', { properties: ['openFile'], filters: [{ name: kind === 'xlsx' ? 'Excel' : kind.toUpperCase(), extensions: ext }, { name: 'All files', extensions: ['*'] }] })
    if (f) { setPath(f); setNewName(baseName(f)); setOver({}); setSheet('') }
  }

  const src = preview?.columns ?? []
  const sample = (i: number): string[] => (preview?.rows ?? []).map((r) => (r[i] == null ? '' : typeof r[i] === 'object' ? JSON.stringify(r[i]) : String(r[i])))
  const cols = dest === 'existing' && target ? destCols : []
  const auto = dest === 'existing' ? matchColumns(src, cols.map((c) => c.name), matching, ci) : src
  const map = src.map((_s, i) => (over[i]?.dest !== undefined ? over[i].dest! : auto[i]))
  const typeOf = (i: number): string => over[i]?.type ?? (allText ? textType(dialect) : detectType(sample(i), dialect))
  const setCol = (i: number, p: Over[number]): void => setOver((o) => ({ ...o, [i]: { ...o[i], ...p } }))
  const tableName = dest === 'new' ? newName.trim() : target
  const mode: Conflict = dest === 'new' ? 'stop' : conflict
  const mapped = [...new Set(map.filter((m): m is string => !!m))]
  const keys = (keyPick ?? cols.filter((c) => c.pk).map((c) => c.name)).filter((k) => mapped.includes(k))
  const wantKeys = kind !== 'sql' && needsKeys(mode, dialect)
  const canRun = !!path && !!preview && !job && (kind === 'sql' || (schema !== undefined && !!tableName && map.some(Boolean) && (!wantKeys || keys.length > 0)))

  const headerMenu = (name: string, e: RME): void => {
    const i = src.indexOf(name)
    const items: MenuItem[] = dest === 'existing'
      ? [{ header: 'Import into column' }, ...cols.map((c) => ({ label: c.name, checked: map[i] === c.name, onClick: () => setCol(i, { dest: c.name }) })), { sep: true }, { label: 'Do not import', checked: map[i] === null, onClick: () => setCol(i, { dest: null }) }]
      : [{ label: 'Import', checked: map[i] !== null, onClick: () => setCol(i, { dest: undefined }) }, { label: 'Do not import', checked: map[i] === null, onClick: () => setCol(i, { dest: null }) }, { sep: true }, { header: 'Column type' }, ...TYPE_LIST[dialect].map((t) => ({ label: t, checked: typeOf(i) === t, onClick: () => setCol(i, { type: t }) }))]
    menuAt(e, items)
  }

  const run = async (): Promise<void> => {
    if (!sessionId) return
    const create = kind !== 'sql' && dest === 'new' ? src.flatMap((_s, i) => (map[i] ? [{ name: map[i]!, type: typeOf(i) }] : [])) : undefined
    const file = path.split(/[\\/]/).pop()
    const t = qt(dialect, schema, tableName)
    if (mode === 'truncate' && !(await confirmDialog(`Empty ${tableName} first?`, `Every row in ${tableName} is deleted, then the rows from ${file} are inserted. Both run in one transaction, so a failed import keeps the old rows.`, { ok: 'Empty and import', danger: true }))) return
    const write = mode === 'updateOnly' ? `UPDATE ${t} SET … WHERE … -- rows from ${file}` : mode === 'delete' ? `DELETE FROM ${t} WHERE … -- keys from ${file}` : `INSERT INTO ${t} … -- rows from ${file}`
    const summary = kind === 'sql' ? [`-- Run every statement in ${file}`] : [...(create ? [`CREATE TABLE ${t} (…)`] : []), ...(mode === 'truncate' ? [`DELETE FROM ${t}`] : []), write]
    if (!(await guard(summary))) return
    try {
      setJobId(await call<string>('import.run', sessionId, { kind, path, encoding, delimiter, quote, header, sheet, schema, table: tableName, create, map, conflict: mode, keys: wantKeys ? keys : undefined }))
    } catch (e) { fail(e) }
  }

  const title = kind === 'sql' ? 'Import SQL dump' : kind === 'xlsx' ? 'Import Excel' : `Import ${kind.toUpperCase()}`
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={kind === 'sql' ? 720 : 920}
      footer={
        <>
          <div className="grow">{job && <JobStatus job={job} />}</div>
          {job?.state === 'running' ? (
            <>
              <button className="btn" onClick={() => void call('job.cancel', job.id)}>Stop</button>
              <button className="btn" onClick={onClose}>Import in background</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose}>Close</button>
              {job && <button className="btn" onClick={() => setJobId(undefined)}>Try again</button>}
              <button className="btn primary" disabled={!canRun} onClick={() => void run()}>Import</button>
            </>
          )}
        </>
      }
    >
      <div className="row">
        <button className="btn" autoFocus onClick={() => void pick()}><Icon name="file" /> {path ? 'Change file…' : 'Choose file…'}</button>
        <span className="grow ellipsis mono muted" title={path}>{path || 'No file chosen'}</span>
      </div>
      {kind !== 'sql' && schema === undefined && <div className="danger-text">Select a database first.</div>}
      {path && (
        <div className={kind === 'sql' ? '' : 'ie-cols'}>
          <fieldset className="fieldset">
            <legend>File</legend>
            {kind !== 'xlsx' && <Choice id="ie-enc" label="Encoding" value={encoding} options={ENCODINGS} onChange={setEncoding} />}
            {kind === 'xlsx' && (
              <>
                <div className="field">
                  <label htmlFor="ie-sheet">Sheet</label>
                  <select id="ie-sheet" className="select" value={sheet || preview?.sheets?.[0] || ''} onChange={(e) => { setSheet(e.target.value); setOver({}) }}>
                    {(preview?.sheets ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="field"><span /><label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is a header</label></div>
              </>
            )}
            {kind === 'csv' && (
              <>
                <Choice id="ie-delim" label="Delimiter" value={delimiter} options={[[',', 'Comma ( , )'], [';', 'Semicolon ( ; )'], ['\t', 'Tab']]} custom onChange={setDelimiter} />
                <Choice id="ie-quote" label="Quote" value={quote} options={[['"', 'Double quote ( " )'], ["'", "Single quote ( ' )"]]} custom onChange={setQuote} />
                <div className="field"><span /><label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is a header</label></div>
              </>
            )}
          </fieldset>
          {kind !== 'sql' && (
            <fieldset className="fieldset">
              <legend>Destination</legend>
              <div className="field">
                <label htmlFor="ie-dest">Table</label>
                <select id="ie-dest" className="select" value={dest === 'new' ? '__new' : target} onChange={(e) => { setOver({}); setKeyPick(null); if (e.target.value === '__new') setDest('new'); else { setDest('existing'); setTarget(e.target.value) } }}>
                  {dest === 'existing' && !target && <option value="">Choose a table…</option>}
                  {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                  {table && !tables.some((t) => t.name === table.name) && <option value={table.name}>{table.name}</option>}
                  <option value="__new">New table…</option>
                </select>
              </div>
              {dest === 'new' ? (
                <>
                  <div className="field"><label htmlFor="ie-new">New table name</label><input id="ie-new" className="input" value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
                  <div className="field"><span /><label className="check"><input type="checkbox" checked={allText} onChange={(e) => setAllText(e.target.checked)} /> Create every column as text</label></div>
                </>
              ) : (
                <div className="field">
                  <label htmlFor="ie-match">Match columns</label>
                  <div className="row">
                    <select id="ie-match" className="select grow" value={matching} onChange={(e) => { setMatching(e.target.value as Matching); setOver({}) }}>
                      <option value="nameOrder">By name, then order</option>
                      <option value="name">By name</option>
                      <option value="order">By order</option>
                    </select>
                    <label className="check"><input type="checkbox" checked={ci} disabled={matching === 'order'} onChange={(e) => { setCi(e.target.checked); setOver({}) }} /> Ignore case</label>
                  </div>
                </div>
              )}
              {dest === 'existing' && (
                <div className="field">
                  <label htmlFor="ie-conflict">Mode</label>
                  <select id="ie-conflict" className="select" value={conflict} onChange={(e) => setConflict(e.target.value as Conflict)}>
                    {MODES.filter(([m]) => m !== 'replace' || dialect !== 'postgres').map(([m, label]) => <option key={m} value={m}>{label}</option>)}
                  </select>
                </div>
              )}
              {dest === 'existing' && wantKeys && (
                <div className="field">
                  <span className="muted" style={{ textAlign: 'right', fontSize: 'var(--fs-sm)' }}>Key columns</span>
                  <div className="ie-tokens" role="group" aria-label="Key columns">
                    {mapped.map((c) => (
                      <label key={c} className="check"><input type="checkbox" checked={keys.includes(c)} onChange={(e) => setKeyPick(e.target.checked ? [...keys, c] : keys.filter((k) => k !== c))} /> {c}</label>
                    ))}
                    {!keys.length && <span className="danger-text" style={{ fontSize: 'var(--fs-sm)' }}>Choose the columns that identify a row.</span>}
                  </div>
                </div>
              )}
            </fieldset>
          )}
        </div>
      )}
      {err && <div className="danger-text selectable">{err}</div>}
      {preview && kind === 'sql' && (
        <>
          <pre className="code ie-sql selectable" aria-label="File preview">{preview.text}</pre>
          {(preview.text?.length ?? 0) >= 100000 && <div className="muted">Showing the first 100,000 characters.</div>}
        </>
      )}
      {preview && kind !== 'sql' && (
        <>
          <div className="ie-scroll">
            <table className="ie-map">
              <thead><tr><th scope="col">Source column</th><th scope="col">Destination</th>{dest === 'new' && <th scope="col">Type</th>}</tr></thead>
              <tbody>
                {src.map((s, i) => (
                  <tr key={i}>
                    <td className="mono">{s}</td>
                    <td>
                      <select className="select sm" aria-label={`Destination for ${s}`} value={map[i] ?? ''} onChange={(e) => setCol(i, { dest: e.target.value || null })}>
                        {dest === 'existing' ? cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>) : <option value={s}>Import as {s}</option>}
                        <option value="">Do not import</option>
                      </select>
                    </td>
                    {dest === 'new' && (
                      <td>
                        <select className="select sm" aria-label={`Type for ${s}`} value={typeOf(i)} disabled={map[i] === null} onChange={(e) => setCol(i, { type: e.target.value })}>
                          {[...new Set([typeOf(i), ...TYPE_LIST[dialect]])].map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Preview of the first {preview.rows.length} {kind === 'json' ? 'records' : 'rows'}. Click a column header to change where it goes.</div>
          <div className="ie-preview">
            <Grid
              columns={src.map((name, i) => ({ name, sub: map[i] === null ? 'skip' : dest === 'new' ? typeOf(i) : `→ ${map[i]}` }))}
              rows={preview.rows}
              onHeaderClick={headerMenu}
              onHeaderMenu={headerMenu}
            />
          </div>
        </>
      )}
    </Modal>
  )
}

// ---------- export ----------

function FormatTabs({ value, onChange }: { value: Fmt; onChange: (f: Fmt) => void }): ReactNode {
  return (
    <div className="tabs" role="tablist" aria-label="Format" style={{ flexWrap: 'wrap' }}>
      {EXPORT_FORMATS.map(([id, label]) => <button key={id} role="tab" aria-selected={value === id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>{label}</button>)}
    </div>
  )
}

function CsvOptions({ o, set }: { o: CsvOut; set: (o: CsvOut) => void }): ReactNode {
  const p = (patch: Partial<CsvOut>): void => set({ ...o, ...patch })
  const check = (k: 'header' | 'nullAsEmpty' | 'breakToSpace', label: string): ReactNode => <label className="check"><input type="checkbox" checked={o[k]} onChange={(e) => p({ [k]: e.target.checked })} /> {label}</label>
  return (
    <div className="fieldset">
      <Choice id="ie-x-delim" label="Delimiter" value={o.delimiter} options={[[',', 'Comma ( , )'], [';', 'Semicolon ( ; )'], ['\t', 'Tab'], ['|', 'Pipe ( | )']]} onChange={(v) => p({ delimiter: v })} />
      <Choice id="ie-x-quote" label="Quote character" value={o.quote} options={[['"', 'Double quote ( " )'], ["'", "Single quote ( ' )"], ['', 'None']]} onChange={(v) => p({ quote: v })} />
      <Choice id="ie-x-lb" label="Line break" value={o.lineBreak} options={[['\n', 'LF (macOS, Linux)'], ['\r\n', 'CRLF (Windows)']]} onChange={(v) => p({ lineBreak: v })} />
      <Choice id="ie-x-dec" label="Decimal separator" value={o.decimal} options={[['.', 'Point ( . )'], [',', 'Comma ( , )']]} onChange={(v) => p({ decimal: v })} />
      <div className="field"><span /><div className="col ie-checks">{check('header', 'Column names in the first row')}{check('nullAsEmpty', 'Write NULL as an empty value')}{check('breakToSpace', 'Turn line breaks into spaces')}</div></div>
    </div>
  )
}

const TOKENS = ['connection', 'database', 'schema', 'table', 'date', 'time']
type SqlFlags = { structure: boolean; drop: boolean; data: boolean }
const keyOf = (o: DbObject): string => `${o.schema}.${o.name}`

export function ExportDialog({ items, onClose }: { items: DbObject[]; onClose: () => void }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const conn = useWs((s) => s.conn)
  const database = useWs((s) => s.database)
  const [checked, setChecked] = useState<DbObject[]>(items)
  const [schemas, setSchemas] = useState<string[]>([])
  const [schema, setSchema] = useState(items[0]?.schema ?? ws().schema ?? '')
  const [list, setList] = useState<DbObject[]>([])
  const [format, setFormat] = useState<Fmt>('csv')
  const [csv, setCsv] = useState<CsvOut>(CSV_DEFAULTS)
  const [pretty, setPretty] = useState(true)
  const [sqlFlags, setSqlFlags] = useState<Record<string, SqlFlags>>({})
  const [gzip, setGzip] = useState(false)
  const [folderPattern, setFolderPattern] = useState('{table}')
  const [filePattern, setFilePattern] = useState('{database}_{date}')
  const [jobId, setJobId] = useState<string>()
  const job = useJob(jobId)

  useEffect(() => { if (sessionId) call<string[]>('db.schemas', sessionId).then(setSchemas, fail) }, [sessionId])
  useEffect(() => {
    if (sessionId) call<DbObject[]>('db.objects', sessionId, schema).then((o) => setList(o.filter((x) => x.kind === 'table' || x.kind === 'view' || x.kind === 'matview')), fail)
  }, [sessionId, schema])

  const isOn = (o: DbObject): boolean => checked.some((c) => keyOf(c) === keyOf(o))
  const toggle = (o: DbObject, on: boolean): void => setChecked((c) => (on ? [...c.filter((x) => keyOf(x) !== keyOf(o)), o] : c.filter((x) => keyOf(x) !== keyOf(o))))
  const flags = (o: DbObject): SqlFlags => sqlFlags[keyOf(o)] ?? { structure: true, drop: false, data: o.kind === 'table' }
  const setFlag = (o: DbObject, k: keyof SqlFlags, v: boolean): void => setSqlFlags((f) => ({ ...f, [keyOf(o)]: { ...flags(o), [k]: v } }))
  const isSql = format === 'sql'
  const pattern = isSql ? filePattern : folderPattern
  const setPattern = isSql ? setFilePattern : setFolderPattern
  const tokens = { connection: conn?.name, database, schema: checked[0]?.schema, table: checked[0]?.name }
  const ext = isSql ? (gzip ? '.sql.gz' : '.sql') : `.${exportExt(format)}`

  const run = async (): Promise<void> => {
    if (!sessionId) return
    const target = isSql
      ? await call<string | undefined>('job.save', { title: 'Export to SQL file', defaultPath: expandPattern(filePattern, tokens) + ext, filters: [{ name: gzip ? 'Gzipped SQL' : 'SQL', extensions: [gzip ? 'gz' : 'sql'] }] })
      : (await call<string[]>('job.open', { title: 'Choose a folder for the exported files', buttonLabel: 'Export here', properties: ['openDirectory', 'createDirectory'] }))[0]
    if (!target) return
    const sql = Object.fromEntries(checked.map((o) => [keyOf(o), flags(o)]))
    try { setJobId(await call<string>('export.run', sessionId, { items: checked, format, target, pattern: folderPattern, csv, pretty, sql, gzip })) } catch (e) { fail(e) }
  }

  return (
    <Modal
      title="Export"
      onClose={onClose}
      width={820}
      footer={
        <>
          <div className="grow">{job ? <JobStatus job={job} /> : <span className="muted">{checked.length} selected</span>}</div>
          {job?.state === 'running' ? (
            <>
              <button className="btn" onClick={() => void call('job.cancel', job.id)}>Stop</button>
              <button className="btn" onClick={onClose}>Export in background</button>
            </>
          ) : (
            <>
              {job?.state === 'done' && job.output && <button className="btn" onClick={() => void call('shell.reveal', job.output)}>Show in folder</button>}
              <button className="btn" onClick={onClose}>Close</button>
              <button className="btn primary" disabled={!checked.length} onClick={() => void run()}>Export…</button>
            </>
          )}
        </>
      }
    >
      <div className="ie-export">
        <div className="col" style={{ gap: 'var(--sp-3)', minHeight: 0 }}>
          {schemas.length > 1 && (
            <select className="select" aria-label="Schema" value={schema} onChange={(e) => setSchema(e.target.value)}>
              {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <div className="row">
            <button className="btn sm" onClick={() => setChecked((c) => [...c.filter((x) => x.schema !== schema), ...list])}>All</button>
            <button className="btn sm" onClick={() => setChecked((c) => c.filter((x) => x.schema !== schema))}>None</button>
          </div>
          <div className="ie-items" role="group" aria-label="Tables and views">
            {list.map((o) => (
              <label key={o.name} className="check list-item">
                <input type="checkbox" checked={isOn(o)} onChange={(e) => toggle(o, e.target.checked)} />
                <Icon name={o.kind} size={13} className="faint" />
                <span className="ellipsis">{o.name}</span>
              </label>
            ))}
            {!list.length && <div className="empty">No tables in this schema.</div>}
          </div>
        </div>
        <div className="col" style={{ gap: 'var(--sp-5)', minWidth: 0 }}>
          <FormatTabs value={format} onChange={setFormat} />
          {format === 'csv' && <CsvOptions o={csv} set={setCsv} />}
          {format === 'json' && <label className="check"><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> Pretty-print (indented)</label>}
          {format === 'xlsx' && <div className="muted">One .xlsx workbook per table, header row in bold.</div>}
          {isSql && (
            <>
              <div className="ie-scroll">
                <table className="ie-map">
                  <thead><tr><th scope="col">Item</th><th scope="col">Structure</th><th scope="col">Drop first</th><th scope="col">Data</th></tr></thead>
                  <tbody>
                    {checked.map((o) => (
                      <tr key={keyOf(o)}>
                        <td className="ellipsis">{o.schema ? `${o.schema}.` : ''}{o.name}</td>
                        {(['structure', 'drop', 'data'] as const).map((k) => (
                          <td key={k}><input type="checkbox" aria-label={`${k} for ${o.name}`} checked={flags(o)[k]} disabled={k === 'data' && o.kind !== 'table'} onChange={(e) => setFlag(o, k, e.target.checked)} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className="check"><input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} /> Compress with gzip (.gz)</label>
            </>
          )}
          <div className="field">
            <label htmlFor="ie-pattern">{isSql ? 'File name' : 'File names'}</label>
            <input id="ie-pattern" className="input mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </div>
          <div className="field">
            <span />
            <div className="col" style={{ gap: 'var(--sp-2)' }}>
              <div className="ie-tokens" aria-label="Insert a name token">
                {TOKENS.map((t) => <button key={t} className="btn sm" onClick={() => setPattern(pattern + `{${t}}`)}>{t}</button>)}
              </div>
              <span className="muted ellipsis mono" style={{ fontSize: 'var(--fs-sm)' }}>{expandPattern(pattern, tokens)}{ext}{isSql ? '' : ' · one file per item in the chosen folder'}</span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function ExportResultDialog({ title, columns, rows, table, onClose }: { title: string; columns: string[]; rows: unknown[][]; table?: string; onClose: () => void }): ReactNode {
  const [format, setFormat] = useState<Fmt>('csv')
  const [csv, setCsv] = useState<CsvOut>(CSV_DEFAULTS)
  const [pretty, setPretty] = useState(true)
  const [tbl, setTbl] = useState(table ?? 'query_result')
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    const path = await call<string | undefined>('job.save', { title: 'Export result', defaultPath: `${expandPattern(title, {})}.${exportExt(format)}`, filters: [{ name: EXPORT_FORMATS.find((f) => f[0] === format)![1], extensions: [exportExt(format)] }] })
    if (!path) return
    setBusy(true)
    try {
      await call('export.rows', { path, format, columns, rows, table: tbl.trim() || 'query_result', dialect: ws().dialect ?? 'postgres', csv, pretty })
      toast(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to ${path}`, 'success')
      onClose()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  return (
    <Modal
      title={`Export result · ${title}`}
      onClose={onClose}
      width={520}
      footer={<><span className="grow muted">{rows.length} rows · {columns.length} columns</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !columns.length} onClick={() => void run()}>Export…</button></>}
    >
      <FormatTabs value={format} onChange={setFormat} />
      {format === 'csv' && <CsvOptions o={csv} set={setCsv} />}
      {format === 'json' && <label className="check"><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> Pretty-print (indented)</label>}
      {format === 'sql' && <div className="field"><label htmlFor="ie-r-table">Table name</label><input id="ie-r-table" className="input mono" value={tbl} onChange={(e) => setTbl(e.target.value)} /></div>}
      {format === 'xlsx' && <div className="muted">A single .xlsx workbook with the header row in bold.</div>}
    </Modal>
  )
}
