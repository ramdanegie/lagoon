// Structure synchronization: pick source and target, compare, review each object's DDL side by side,
// then copy, save, open or deploy the migration script for the target.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Connection, Result, ServerInfo } from '@shared/types'
import { DRIVERS, SAFE_MODES, dialectOf } from '@shared/types'
import {
  type DiffItem, type ObjType, type Op, type SchemaModel, type SyncDialect, type SyncOptions,
  DEFAULT_SYNC_OPTIONS, buildScript, canUseTransaction, caseSensitive, diffSchemas, lineDiff, scriptText
} from '@shared/structsync'
import { call, errText, fail, toast } from '../lib/api'
import { guard, newQueryTab, ws } from '../lib/ws'
import { Modal, confirmDialog, promptDialog } from '../components/ui'
import { CodeEditor } from '../components/CodeEditor'
import '../styles/structsync.css'

interface Side { connId: string; database: string; schema: string; sid?: string; databases: string[]; schemas: string[]; busy: boolean; err: string }
interface LogLine { sql: string; ok: boolean; error?: string; ms: number }
interface Run { done: number; total: number; log: LogLine[]; state: 'running' | 'ok' | 'failed' | 'stopped'; note: string }
type Step = 'setup' | 'results' | 'script'
type Asked = { password?: string; sshPassword?: string }

const blank = (connId = ''): Side => ({ connId, database: '', schema: '', databases: [], schemas: [], busy: false, err: '' })
const SYSTEM_DBS = ['information_schema', 'mysql', 'performance_schema', 'sys']
const family = (c?: Connection): SyncDialect | undefined => (c ? (dialectOf(c.driver) as SyncDialect | undefined) : undefined)
const pickSchema = (list: string[], want?: string): string => (want && list.includes(want) ? want : list.includes('public') ? 'public' : list[0] ?? '')

const TYPE_ORDER: ObjType[] = ['table', 'view', 'routine', 'trigger', 'sequence', 'type']
const TYPE_LABEL: Record<ObjType, string> = { table: 'Tables', view: 'Views', routine: 'Functions & procedures', trigger: 'Triggers', sequence: 'Sequences', type: 'Types' }
const TYPE_NOUN: Record<ObjType, string> = { table: 'table', view: 'view', routine: 'routine', trigger: 'trigger', sequence: 'sequence', type: 'type' }
const OP_ORDER: Op[] = ['create', 'alter', 'drop', 'same']
const OP_LABEL: Record<Op, string> = { create: 'Create', alter: 'Alter', drop: 'Drop', same: 'Identical' }
const OP_MARK: Record<Op, string> = { create: '+', alter: '~', drop: '−', same: '=' }

const OPTIONS: { key: keyof SyncOptions; label: string; only?: SyncDialect }[] = [
  { key: 'tables', label: 'Tables' }, { key: 'columns', label: 'Columns' }, { key: 'pk', label: 'Primary keys' },
  { key: 'fks', label: 'Foreign keys' }, { key: 'indexes', label: 'Indexes' }, { key: 'constraints', label: 'Unique & check constraints' },
  { key: 'views', label: 'Views' }, { key: 'routines', label: 'Functions & procedures' }, { key: 'triggers', label: 'Triggers' },
  { key: 'sequences', label: 'Sequences', only: 'postgres' }, { key: 'comments', label: 'Column comments' }, { key: 'defaults', label: 'Default values' },
  { key: 'collation', label: 'Collation', only: 'mysql' }
]

async function askSecrets(c: Connection): Promise<Asked> {
  const a: Asked = {}
  // the workspace's own connection lends its session password (see structsync.open)
  if (c.passwordMode === 'ask' && ws().conn?.id !== c.id) {
    const pw = await promptDialog(`Password for ${c.name}`, '', { password: true, ok: 'Connect' })
    if (pw === null) throw new Error('The database password is needed to connect.')
    a.password = pw
  }
  if (c.ssh?.enabled && !c.ssh.useKey && c.ssh.passwordMode === 'ask') {
    const pw = await promptDialog(`SSH password for ${c.name}`, '', { password: true, ok: 'Connect' })
    if (pw === null) throw new Error('The SSH password is needed to connect.')
    a.sshPassword = pw
  }
  return a
}

/** The target connection's own safe mode: levels 1–2 confirm, 3–4 ask for its password. Level 0 still confirms: this runs DDL. */
async function targetAllows(c: Connection, sid: string, summary: string): Promise<boolean> {
  const fresh = await call<Connection>('conn.get', c.id)
  const level = fresh.safeMode ?? 0
  if (level < 3) return confirmDialog(level ? `Deploy · ${SAFE_MODES[level]}` : 'Deploy to target', summary, { ok: 'Deploy', danger: true })
  const pw = await promptDialog(`Deploy · ${SAFE_MODES[level]}`, '', { password: true, ok: 'Deploy', message: `${summary}\n\n${fresh.name} is in safe mode. Enter its database password to continue.` })
  if (pw === null) return false
  const ok = fresh.passwordMode === 'store' ? await call<boolean>('conn.checkStoredPassword', fresh.id, pw) : await call<boolean>('session.checkPassword', sid, pw)
  if (!ok) fail('Wrong password.')
  return ok
}

export function StructureSync(p: { onClose: () => void }): ReactNode {
  const [conns, setConns] = useState<Connection[]>([])
  const [sides, setSides] = useState<[Side, Side]>([blank(), blank()])
  const sidesRef = useRef(sides)
  useEffect(() => { sidesRef.current = sides }, [sides])
  const tok = useRef([0, 0])
  const [opts, setOpts] = useState<SyncOptions>(DEFAULT_SYNC_OPTIONS)
  const [models, setModels] = useState<{ src: SchemaModel; dst: SchemaModel } | null>(null)
  const [step, setStep] = useState<Step>('setup')
  const [comparing, setComparing] = useState(false)
  const [group, setGroup] = useState<'type' | 'op'>('type')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['same']))
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [selId, setSelId] = useState<string>()
  const [pane, setPane] = useState<'ddl' | 'sql'>('ddl')
  const [stopOnError, setStopOnError] = useState(true)
  const [useTx, setUseTx] = useState(true)
  const [run, setRun] = useState<Run | null>(null)
  const stopRef = useRef(false)

  const [src, dst] = sides
  const connOf = (id: string): Connection | undefined => conns.find((c) => c.id === id)
  const srcConn = connOf(src.connId)
  const dstConn = connOf(dst.connId)
  const dialect = family(srcConn)
  const pg = dialect === 'postgres'
  const running = run?.state === 'running'

  const patch = (i: 0 | 1, part: Partial<Side>): void => setSides((ss) => {
    const n: [Side, Side] = [ss[0], ss[1]]
    n[i] = { ...n[i], ...part }
    return n
  })

  async function open(i: 0 | 1, c: Connection, database?: string, schema?: string): Promise<void> {
    const t = ++tok.current[i]
    const old = sidesRef.current[i].sid
    if (old) void call('session.close', old)
    patch(i, { ...blank(c.id), busy: true })
    setModels(null)
    try {
      const asked = await askSecrets(c)
      const w = ws()
      const r = await call<{ sessionId: string; info: ServerInfo }>('structsync.open', c.id, database || undefined, w.conn?.id === c.id ? w.sessionId : undefined, asked)
      const stale = (): boolean => {
        if (t === tok.current[i]) return false
        void call('session.close', r.sessionId)
        return true
      }
      if (stale()) return
      let databases = await call<string[]>('db.databases', r.sessionId)
      if (family(c) === 'mysql') databases = databases.filter((x) => !SYSTEM_DBS.includes(x))
      const db = r.info.database || databases[0] || ''
      const schemas = family(c) === 'postgres' ? await call<string[]>('db.schemas', r.sessionId) : db ? [db] : []
      if (stale()) return
      patch(i, { sid: r.sessionId, databases, database: db, schemas, schema: pickSchema(schemas, schema), busy: false })
    } catch (e) {
      if (t === tok.current[i]) patch(i, { busy: false, err: errText(e) })
    }
  }

  useEffect(() => {
    let alive = true
    call<Connection[]>('conn.list').then((list) => {
      if (!alive) return
      const ok = list.filter((c) => family(c) === 'postgres' || family(c) === 'mysql')
      setConns(ok)
      const w = ws()
      const first = ok.find((c) => c.id === w.conn?.id) ?? ok[0]
      if (!first) return
      void open(0, first, w.database, w.schema)
      void open(1, first, w.database, w.schema)
    }, fail)
    return () => {
      alive = false
      tok.current = [tok.current[0] + 1, tok.current[1] + 1] // sessions still opening close themselves
      sidesRef.current.forEach((s) => s.sid && void call('session.close', s.sid))
    }
  }, [])

  function pickConn(i: 0 | 1, id: string): void {
    const c = connOf(id)
    if (!c) return
    void open(i, c)
    // the target must be the same engine family as the source
    if (i === 0 && family(c) !== family(dstConn)) {
      const t = conns.find((x) => family(x) === family(c))
      if (t) void open(1, t)
    }
  }

  async function pickDatabase(i: 0 | 1, name: string): Promise<void> {
    const s = sidesRef.current[i]
    if (!s.sid) return
    setModels(null)
    if (family(connOf(s.connId)) === 'mysql') { patch(i, { database: name, schemas: [name], schema: name }); return }
    const t = ++tok.current[i]
    patch(i, { database: name, busy: true, err: '' })
    try {
      await call('db.use', s.sid, name)
      const schemas = await call<string[]>('db.schemas', s.sid)
      if (t === tok.current[i]) patch(i, { schemas, schema: pickSchema(schemas, s.schema), busy: false })
    } catch (e) {
      if (t === tok.current[i]) patch(i, { busy: false, err: errText(e) })
    }
  }

  const swap = (): void => {
    tok.current = [tok.current[1], tok.current[0]]
    setSides(([a, b]) => [b, a])
    setModels(null)
  }

  async function compare(): Promise<void> {
    if (!src.sid || !dst.sid || !src.schema || !dst.schema) return
    setComparing(true)
    try {
      const [a, b] = await Promise.all([call<SchemaModel>('structsync.read', src.sid, src.schema), call<SchemaModel>('structsync.read', dst.sid, dst.schema)])
      setModels({ src: a, dst: b })
      setRun(null)
      if (step === 'setup') { setStep('results'); setUnchecked(new Set()); setSelId(undefined) }
    } catch (e) {
      fail(e)
    } finally {
      setComparing(false)
    }
  }

  const items = useMemo(() => (models ? diffSchemas(models.src, models.dst, opts) : []), [models, opts])
  const isChecked = useCallback((id: string) => !unchecked.has(id), [unchecked])
  const stmts = useMemo(() => (models ? buildScript(items, isChecked, models.dst) : []), [items, isChecked, models])
  const text = useMemo(() => (models ? scriptText(stmts, models.dst.dialect) : ''), [stmts, models])
  const txOk = !!models && canUseTransaction(stmts, models.dst.dialect)
  const sel = items.find((i) => i.id === selId)
  const differences = items.filter((i) => i.op !== 'same').length
  const where = (s: Side, c?: Connection): string => (c ? `${c.name} / ${s.database}${pg && s.schema ? `.${s.schema}` : ''}` : '')

  const groups = (group === 'type'
    ? TYPE_ORDER.map((t) => ({ key: t as string, label: TYPE_LABEL[t], items: items.filter((i) => i.type === t) }))
    : OP_ORDER.map((o) => ({ key: o as string, label: OP_LABEL[o], items: items.filter((i) => i.op === o) }))
  ).filter((g) => g.items.length)

  const setChecked = (ids: string[], on: boolean): void => setUnchecked((u) => {
    const n = new Set(u)
    for (const id of ids) if (on) n.delete(id); else n.add(id)
    return n
  })

  const save = async (): Promise<void> => {
    const path = await call<string | undefined>('dialog.save', { title: 'Save migration script', defaultPath: `${dst.schema || dst.database || 'structure'}-sync.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })
    if (!path) return
    try {
      await call('file.write', path, text)
      toast('Script saved.', 'success')
    } catch (e) {
      fail(e)
    }
  }

  const openInEditor = (): void => {
    newQueryTab(text, `Sync → ${dst.schema || dst.database}`)
    const notes = [
      dstConn?.id !== ws().conn?.id ? `The editor runs on ${ws().conn?.name}; this script was written for ${dstConn?.name}.` : '',
      text.includes('DELIMITER $$') ? 'DELIMITER lines are for command-line clients; run each routine or trigger on its own here.' : ''
    ].filter(Boolean)
    if (notes.length) toast(notes.join('\n'))
    p.onClose()
  }

  async function deploy(): Promise<void> {
    if (!models || !dstConn || !dst.sid || !stmts.length) return
    const sid = dst.sid
    const d = models.dst.dialect
    const tx = d === 'postgres' && useTx && txOk
    if (!(await guard(stmts))) return
    const drops = stmts.filter((x) => /^\s*DROP\b|\sDROP\s+(COLUMN|CONSTRAINT|FOREIGN KEY|INDEX|PRIMARY KEY)\b/i.test(x)).length
    const summary = [
      `${stmts.length} statements will change ${where(dst, dstConn)}.`,
      drops ? `${drops} of them drop objects, columns or keys.` : '',
      d === 'mysql' ? 'MySQL commits each DDL statement on its own: if one fails, the statements before it stay applied.'
        : tx ? 'The script runs in one transaction: any error rolls everything back.'
          : 'The script runs without a transaction: if a statement fails, the statements before it stay applied.'
    ].filter(Boolean).join('\n\n')
    if (!(await targetAllows(dstConn, sid, summary))) return
    stopRef.current = false
    const log: LogLine[] = []
    setRun({ done: 0, total: stmts.length, log, state: 'running', note: '' })
    const exec = async (sql: string): Promise<Result> => (await call<Result[]>('db.query', sid, [sql.replace(/;\s*$/, '')], { source: 'structsync' }))[0]
    let failed = false
    try {
      if (tx) { const r = await exec('BEGIN'); if (r.error) throw new Error(r.error) }
      for (let i = 0; i < stmts.length && !stopRef.current; i++) {
        const r = await exec(stmts[i])
        log.push({ sql: stmts[i], ok: !r.error, error: r.error, ms: r.ms })
        setRun((x) => x && { ...x, done: i + 1, log: [...log] })
        if (r.error) { failed = true; if (tx || stopOnError) break }
      }
      if (tx) {
        const end = await exec(failed || stopRef.current ? 'ROLLBACK' : 'COMMIT')
        if (end.error) { failed = true; log.push({ sql: 'COMMIT', ok: false, error: end.error, ms: 0 }) }
      }
    } catch (e) {
      failed = true
      log.push({ sql: '', ok: false, error: errText(e), ms: 0 })
    }
    const ok = log.filter((l) => l.ok).length
    const stopped = stopRef.current && !failed
    const note = failed
      ? tx ? 'A statement failed, so the transaction was rolled back: nothing changed.' : `${ok} of ${stmts.length} statements applied; ${log.length - ok} failed.`
      : stopped ? (tx ? 'Stopped: the transaction was rolled back, nothing changed.' : `Stopped after ${ok} of ${stmts.length} statements.`)
        : `All ${stmts.length} statements applied. Re-compare to check the result.`
    setRun({ done: log.length, total: stmts.length, log: [...log], state: failed ? 'failed' : stopped ? 'stopped' : 'ok', note })
    toast(note, failed ? 'error' : 'success')
  }

  const canCompare = !!src.sid && !!dst.sid && !!src.schema && !!dst.schema && !src.busy && !dst.busy && !comparing
  const stepTab = (s: Step, label: string, enabled: boolean): ReactNode => (
    <button className={step === s ? 'on' : ''} disabled={!enabled || running} onClick={() => setStep(s)}>{label}</button>
  )

  return (
    <Modal
      title={
        <>
          <span>Structure synchronization</span>
          <div className="tabs ss-steps" role="tablist" aria-label="Steps">
            {stepTab('setup', '1 · Source & target', true)}
            {stepTab('results', '2 · Compare', !!models)}
            {stepTab('script', '3 · Script', !!models)}
          </div>
        </>
      }
      onClose={() => !running && p.onClose()}
      width={1120}
      className="ss"
      footer={
        <>
          {step !== 'setup' && models && <span className="muted grow">{differences ? `${differences} difference${differences > 1 ? 's' : ''} · ${stmts.length} statement${stmts.length === 1 ? '' : 's'}` : 'No differences.'}</span>}
          {step === 'setup' ? (
            <>
              <button className="btn" onClick={p.onClose}>Close</button>
              <button className="btn primary" disabled={!canCompare} onClick={() => void compare()}>{comparing ? 'Comparing…' : 'Compare'}</button>
            </>
          ) : (
            <>
              <button className="btn" disabled={running} onClick={() => setStep(step === 'script' ? 'results' : 'setup')}>Back</button>
              <button className="btn" disabled={!canCompare || running} onClick={() => void compare()}>{comparing ? 'Comparing…' : 'Re-compare'}</button>
              {step === 'results' && <button className="btn primary" onClick={() => setStep('script')}>Script…</button>}
              {step === 'script' && (running
                ? <button className="btn" onClick={() => { stopRef.current = true }}>Stop</button>
                : <button className="btn danger" disabled={!stmts.length} onClick={() => void deploy()}>Deploy…</button>)}
            </>
          )}
        </>
      }
    >
      {step === 'setup' && (
        <div className="ss-setup">
          {conns.length === 0 && <div className="empty">No saved PostgreSQL, MySQL or MariaDB connections.</div>}
          <div className="ss-sides">
            <SidePicker title="Source" side={src} conns={conns} pg={pg} onConn={(id) => pickConn(0, id)} onDb={(db) => void pickDatabase(0, db)} onSchema={(s) => { setModels(null); patch(0, { schema: s }) }} />
            <button className="btn icon" title="Swap source and target" aria-label="Swap source and target" disabled={src.busy || dst.busy} onClick={swap}>⇄</button>
            <SidePicker title="Target" side={dst} conns={conns.filter((c) => family(c) === dialect)} pg={pg} onConn={(id) => pickConn(1, id)} onDb={(db) => void pickDatabase(1, db)} onSchema={(s) => { setModels(null); patch(1, { schema: s }) }} />
          </div>
          {src.sid && dst.sid && src.connId === dst.connId && src.database === dst.database && src.schema === dst.schema && <div className="ss-warn">Source and target are the same {pg ? 'schema' : 'database'}.</div>}
          <fieldset className="fieldset">
            <legend>Compare</legend>
            <div className="ss-opts">
              {OPTIONS.filter((o) => !o.only || o.only === dialect).map((o) => (
                <label key={o.key} className="check"><input type="checkbox" checked={!!opts[o.key]} onChange={(e) => setOpts({ ...opts, [o.key]: e.target.checked })} />{o.label}</label>
              ))}
            </div>
          </fieldset>
          <fieldset className="fieldset">
            <legend>Matching and drops</legend>
            <div className="ss-opts">
              <label className="check"><input type="checkbox" checked={opts.drops} onChange={(e) => setOpts({ ...opts, drops: e.target.checked })} />Include drops (objects only in the target)</label>
              {pg && <label className="check"><input type="checkbox" checked={opts.cascade} disabled={!opts.drops} onChange={(e) => setOpts({ ...opts, cascade: e.target.checked })} />Drop with CASCADE</label>}
              <label className="check">
                Identifier case
                <select className="select sm" value={opts.caseMode} onChange={(e) => setOpts({ ...opts, caseMode: e.target.value as SyncOptions['caseMode'] })}>
                  <option value="server">Server default</option>
                  <option value="sensitive">Case-sensitive</option>
                  <option value="insensitive">Case-insensitive</option>
                </select>
              </label>
            </div>
            <div className="faint">
              {opts.caseMode === 'server' && (pg ? 'PostgreSQL names are case-sensitive.' : models ? `The server folds table names (lower_case_table_names): matching is ${caseSensitive(opts, models.src, models.dst) ? 'case-sensitive' : 'case-insensitive'}.` : 'Follows the servers’ lower_case_table_names setting.')}
              {opts.drops && ' Drops can lose data: review the script before deploying.'}
            </div>
          </fieldset>
        </div>
      )}

      {step === 'results' && models && (
        <div className="ss-results">
          <div className="ss-tree-wrap">
            <div className="row">
              <div className="seg" role="group" aria-label="Group by">
                <button className={group === 'type' ? 'on' : ''} onClick={() => setGroup('type')}>By type</button>
                <button className={group === 'op' ? 'on' : ''} onClick={() => setGroup('op')}>By operation</button>
              </div>
            </div>
            <div className="ss-tree" role="tree" aria-label="Comparison results">
              {groups.length === 0 && <div className="empty">Nothing to compare with these options.</div>}
              {groups.map((g) => {
                const checkable = g.items.filter((i) => i.op !== 'same')
                const on = checkable.filter((i) => isChecked(i.id)).length
                const open = !collapsed.has(g.key)
                return (
                  <div key={g.key} role="group">
                    <div className="ss-group">
                      <input type="checkbox" aria-label={`Include all ${g.label}`} disabled={!checkable.length} checked={!!checkable.length && on === checkable.length}
                        ref={(el) => { if (el) el.indeterminate = on > 0 && on < checkable.length }} onChange={() => setChecked(checkable.map((i) => i.id), on < checkable.length)} />
                      <button aria-expanded={open} onClick={() => setCollapsed((c) => { const n = new Set(c); if (open) n.add(g.key); else n.delete(g.key); return n })}>
                        <span>{open ? '▾' : '▸'}</span><span>{g.label}</span><span className="faint">{g.items.length}</span>
                      </button>
                    </div>
                    {open && g.items.map((it) => (
                      <div key={it.id} role="treeitem" aria-selected={selId === it.id} tabIndex={0} className={`ss-row ${selId === it.id ? 'sel' : ''}`}
                        onClick={() => setSelId(it.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSelId(it.id); if (e.key === ' ' && it.op !== 'same') { e.preventDefault(); setChecked([it.id], !isChecked(it.id)) } }}>
                        <input type="checkbox" tabIndex={-1} aria-label={`Include ${it.name}`} checked={it.op !== 'same' && isChecked(it.id)} disabled={it.op === 'same'}
                          onClick={(e) => e.stopPropagation()} onChange={(e) => setChecked([it.id], e.target.checked)} />
                        <span className={`ss-op ${it.op}`} title={OP_LABEL[it.op]}>{OP_MARK[it.op]}</span>
                        <span className="ellipsis grow">{it.name}</span>
                        {group === 'op' && <span className="faint">{TYPE_NOUN[it.type]}</span>}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="ss-pane">
            {sel ? (
              <>
                <div className="row">
                  <span className={`ss-op ${sel.op}`}>{OP_MARK[sel.op]}</span>
                  <b className="ellipsis grow">{TYPE_NOUN[sel.type]} {sel.name}</b>
                  <div className="tabs" role="tablist">
                    <button className={pane === 'ddl' ? 'on' : ''} onClick={() => setPane('ddl')}>DDL comparison</button>
                    <button className={pane === 'sql' ? 'on' : ''} onClick={() => setPane('sql')}>Statements</button>
                  </div>
                </div>
                {sel.details.length > 0 && <ul className="ss-details">{sel.details.map((x, i) => <li key={i} className={x.startsWith('Warning:') ? 'ss-warn' : ''}>{x}</li>)}</ul>}
                {pane === 'ddl'
                  ? <DdlDiff item={sel} labels={[`Source · ${where(src, srcConn)}`, `Target · ${where(dst, dstConn)}`]} />
                  : <pre className="code ss-stmts selectable">{sel.stmts.length ? [...sel.stmts].sort((a, b) => a.phase - b.phase || a.seq - b.seq).map((x) => x.sql).join('\n\n') : 'No statements: the object is identical.'}</pre>}
              </>
            ) : <div className="empty">Select an object to compare its definition.</div>}
          </div>
        </div>
      )}

      {step === 'script' && models && (
        <div className="ss-script">
          <div className="row">
            <span className="muted grow">Script for {where(dst, dstConn)}</span>
            <button className="btn" disabled={!text} onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied.'))}>Copy</button>
            <button className="btn" disabled={!text} onClick={() => void save()}>Save as .sql…</button>
            <button className="btn" disabled={!text || running} onClick={openInEditor}>Open in SQL editor</button>
          </div>
          <div className="ss-editor">
            <CodeEditor value={text || '-- Nothing to deploy: no checked differences.'} options={{ dialect: models.dst.dialect, readOnly: true }} ariaLabel="Migration script" />
          </div>
          <div className="row">
            <label className="check"><input type="checkbox" checked={stopOnError} disabled={running} onChange={(e) => setStopOnError(e.target.checked)} />Stop on first error</label>
            {pg && (
              <label className="check" title={txOk ? undefined : 'The script has a statement PostgreSQL cannot run inside a transaction.'}>
                <input type="checkbox" checked={useTx && txOk} disabled={!txOk || running} onChange={(e) => setUseTx(e.target.checked)} />Run in one transaction
              </label>
            )}
            <span className={pg ? 'faint' : 'ss-warn'}>
              {pg ? (useTx && txOk ? 'Any error rolls the whole script back.' : 'Without a transaction, statements before a failure stay applied.') : 'MySQL commits every DDL statement immediately: statements before a failure stay applied.'}
            </span>
          </div>
          {run && <RunLog run={run} />}
        </div>
      )}
    </Modal>
  )
}

function SidePicker(p: { title: string; side: Side; conns: Connection[]; pg: boolean; onConn: (id: string) => void; onDb: (db: string) => void; onSchema: (s: string) => void }): ReactNode {
  const s = p.side
  const id = `ss-${p.title.toLowerCase()}`
  const withCurrent = (list: string[], v: string): string[] => (v && !list.includes(v) ? [v, ...list] : list)
  return (
    <fieldset className="fieldset">
      <legend>{p.title}</legend>
      <div className="field">
        <label htmlFor={`${id}-conn`}>Connection</label>
        <select id={`${id}-conn`} className="select" value={s.connId} onChange={(e) => p.onConn(e.target.value)}>
          {!s.connId && <option value="">Choose…</option>}
          {p.conns.map((c) => <option key={c.id} value={c.id}>{c.name} ({DRIVERS.find((x) => x.id === c.driver)?.name})</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-db`}>Database</label>
        <select id={`${id}-db`} className="select" value={s.database} disabled={!s.sid || s.busy} onChange={(e) => p.onDb(e.target.value)}>
          {withCurrent(s.databases, s.database).map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {p.pg && (
        <div className="field">
          <label htmlFor={`${id}-schema`}>Schema</label>
          <select id={`${id}-schema`} className="select" value={s.schema} disabled={!s.sid || s.busy} onChange={(e) => p.onSchema(e.target.value)}>
            {withCurrent(s.schemas, s.schema).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
      )}
      {s.busy && <div className="faint">Connecting…</div>}
      {s.err && <div className="danger-text selectable">{s.err}</div>}
    </fieldset>
  )
}

function DdlDiff({ item, labels }: { item: DiffItem; labels: [string, string] }): ReactNode {
  const rows = useMemo(() => lineDiff(item.src, item.dst), [item.src, item.dst])
  return (
    <div className="ss-diff" role="table" aria-label="DDL comparison">
      <div className="ss-dl head" role="row">
        <span /><span role="columnheader" className="ellipsis">{labels[0]}</span><span /><span role="columnheader" className="ellipsis">{labels[1]}</span>
      </div>
      {!item.src && <div className="ss-dl"><span /><code className="faint">Not in the source.</code><span /><span /></div>}
      {!item.dst && <div className="ss-dl"><span /><span /><span /><code className="faint">Not in the target.</code></div>}
      {rows.map((r, i) => (
        <div key={i} className={`ss-dl ${r.kind}`} role="row">
          <span className="ln">{r.ln ?? ''}</span><code>{r.left ?? ''}</code><span className="ln">{r.rn ?? ''}</span><code>{r.right ?? ''}</code>
        </div>
      ))}
    </div>
  )
}

function RunLog({ run }: { run: Run }): ReactNode {
  return (
    <div className="ss-run">
      <progress className="ss-progress" max={run.total} value={run.done} aria-label="Deploy progress" />
      <div className={run.state === 'failed' ? 'danger-text' : run.state === 'running' ? 'muted' : ''} role="status">
        {run.state === 'running' ? `Running statement ${Math.min(run.done + 1, run.total)} of ${run.total}…` : run.note}
      </div>
      {run.log.length > 0 && (
        <div className="ss-log">
          {run.log.map((l, i) => (
            <div key={i}>
              <span className={l.ok ? 'ss-ok' : 'danger-text'}>{l.ok ? '✓' : '✕'}</span>
              <span className="ellipsis mono">{l.sql.split('\n')[0]}</span>
              <span className="faint">{l.ms} ms</span>
              {l.error && <span className="ss-err">{l.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
