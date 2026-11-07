// Open Anything (⌘P), database switcher (⌘K) and connection switcher (⇧⌘K).
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Connection, DbObject } from '@shared/types'
import { DRIVERS } from '@shared/types'
import { call, dispatch, errText, fail, shortcut, toast } from '../lib/api'
import { useWs, setWs, ws, openTab, loadObjects, runSql, openScope } from '../lib/ws'
import { Icon, kindIcon } from '../components/Icon'
import { Modal, confirmDialog, menuAt, promptDialog } from '../components/ui'
import { fuzzy } from './Sidebar'
import { flatQueries, openSavedQuery, refreshQueries } from './QueriesPanel'

interface Item { id: string; label: string; detail?: string; icon: string; kbd?: string; run: (newTab: boolean) => void }

const FEATURES: { label: string; cmd: string; icon: string }[] = [
  { label: 'ER Diagram', cmd: 'tools.diagram', icon: 'diagram' },
  { label: 'Metrics Board', cmd: 'tools.metrics', icon: 'chart' },
  { label: 'Backup Database', cmd: 'file.backup', icon: 'download' },
  { label: 'Restore Database', cmd: 'file.restore', icon: 'upload' },
  { label: 'Open Connection', cmd: 'conn.openConnection', icon: 'plug' },
  { label: 'Open Database', cmd: 'conn.openDatabase', icon: 'db' },
  { label: 'Process List / Cancel Queries', cmd: 'tools.processList', icon: 'stop' },
  { label: 'User Management', cmd: 'tools.users', icon: 'user' },
  { label: 'Search in Database', cmd: 'tools.search', icon: 'search' },
  { label: 'Export Tables', cmd: 'file.exportTables', icon: 'download' },
  { label: 'Import CSV', cmd: 'file.importCsv', icon: 'upload' },
  { label: 'Manage Plugins', cmd: 'tools.plugins', icon: 'plug' },
  { label: 'New SQL Query', cmd: 'nav.newQuery', icon: 'sql' },
  { label: 'Settings', cmd: 'app.settings', icon: 'gear' }
]

function PaletteList({ placeholder, items, onClose, footer }: { placeholder: string; items: (q: string) => Item[]; onClose: () => void; footer?: ReactNode }): ReactNode {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const list = useMemo(() => items(q).slice(0, 200), [q, items])
  useEffect(() => setI(0), [q])
  const go = (it: Item | undefined, newTab: boolean): void => { if (!it) return; onClose(); it.run(newTab) }
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-label={placeholder}>
        <input
          autoFocus
          placeholder={placeholder}
          aria-label={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setI(Math.min(list.length - 1, i + 1)) }
            else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setI(Math.max(0, i - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); go(list[i], e.metaKey || e.ctrlKey) }
            else if (e.key === 'Tab' && list[i]) { e.preventDefault(); setQ(list[i].label) }
            else if (e.key === 'Escape') { e.preventDefault(); if (q) setQ(''); else onClose() }
          }}
        />
        <div className="results" role="listbox">
          {list.length === 0 && <div className="empty">Nothing found for "{q}"</div>}
          {list.map((it, k) => (
            <div key={it.id} role="option" aria-selected={k === i} className={`list-item ${k === i ? 'selected' : ''}`} style={{ height: 30 }} onMouseEnter={() => setI(k)} onClick={(e) => go(it, e.metaKey || e.ctrlKey)}>
              <Icon name={it.icon} size={14} className="faint" />
              <span className="ellipsis">{it.label}</span>
              {it.detail && <span className="faint ellipsis" style={{ fontSize: 'var(--fs-xs)' }}>{it.detail}</span>}
              {it.kbd && <span className="count">{it.kbd}</span>}
            </div>
          ))}
        </div>
        {footer}
      </div>
    </div>
  )
}

export function Palette({ onClose }: { onClose: () => void }): ReactNode {
  const s = useWs()
  const [dbs, setDbs] = useState<string[]>([])
  const [schemas, setSchemas] = useState<string[]>([])
  useEffect(() => {
    void refreshQueries()
    if (s.dialect) {
      void call<string[]>('db.databases', s.sessionId).then(setDbs).catch(() => {})
      void call<string[]>('db.schemas', s.sessionId).then(setSchemas).catch(() => {})
    }
  }, [])
  const openObj = (o: DbObject, newTab: boolean): void => {
    if (o.kind === 'function' || o.kind === 'procedure' || o.kind === 'sequence') openTab({ kind: 'ddl', title: o.name, schema: o.schema, name: o.name, objKind: o.kind }, { newTab })
    else if (o.kind === 'collection') openTab({ kind: 'mongo', title: o.name, name: o.name, objKind: o.kind }, { newTab })
    else openTab({ kind: 'table', title: o.name, schema: o.schema, name: o.name, objKind: o.kind, view: 'data' }, { newTab })
  }
  const items = (q: string): Item[] => {
    const features: Item[] = FEATURES.map((f) => ({ id: `f:${f.label}`, label: f.label, icon: f.icon, kbd: shortcut(f.cmd), detail: 'feature', run: () => dispatch(f.cmd) }))
    if (!q) return features
    const objs: Item[] = s.objects.filter((o) => fuzzy(o.name, q)).map((o) => ({ id: `o:${o.schema}.${o.name}`, label: o.name, detail: `${o.kind}${o.schema ? ' · ' + o.schema : ''}`, icon: kindIcon(o.kind), run: (n) => openObj(o, n) }))
    const db: Item[] = dbs.filter((x) => fuzzy(x, q)).map((x) => ({ id: `d:${x}`, label: x, detail: 'database', icon: 'db', run: () => void switchDatabase(x) }))
    const sc: Item[] = schemas.filter((x) => fuzzy(x, q) && x !== s.database).map((x) => ({ id: `s:${x}`, label: x, detail: 'schema', icon: 'folder', run: () => { setWs({ schema: x }); void loadObjects() } }))
    const qs: Item[] = flatQueries().filter((x) => fuzzy(x.name, q) || x.keywords?.some((k) => fuzzy(k, q))).map((x) => ({ id: `q:${x.path}`, label: x.name, detail: 'saved query', icon: 'sql', run: () => void openSavedQuery(x.path) }))
    const rank = (it: Item): number => (it.label.toLowerCase() === q.replace(/[$^]/g, '').toLowerCase() ? 0 : it.label.toLowerCase().startsWith(q.replace(/[$^]/g, '').toLowerCase()) ? 1 : 2)
    return [...objs, ...db, ...sc, ...qs, ...features.filter((f) => fuzzy(f.label, q, 'contains'))].sort((a, b) => rank(a) - rank(b))
  }
  return <PaletteList placeholder="Open anything: tables, views, functions, saved queries, features" items={items} onClose={onClose} />
}

/** Open another database of the focused connection in its own scope (the tree shows it, tabs keep theirs). */
export async function switchDatabase(name: string): Promise<void> {
  const c = ws().conn
  if (!c) return
  try {
    await openScope(c, { database: name, ask: (t) => promptDialog(t, '', { password: true, ok: 'Connect' }) })
  } catch (e) { fail(e) }
}

export function DatabasePicker({ onClose }: { onClose: () => void }): ReactNode {
  const s = useWs()
  const [dbs, setDbs] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const isMongo = s.conn?.driver === 'mongodb'
  const load = (): void => { void call<string[]>(isMongo ? 'mongo.databases' : 'db.databases', s.sessionId).then(setDbs).catch(fail) }
  useEffect(load, [])
  const list = dbs.filter((x) => fuzzy(x, q))
  const open = (n: string): void => { onClose(); void switchDatabase(n) }
  const canRename = s.dialect === 'postgres'
  const ident = (n: string): string => (s.dialect === 'mysql' ? '`' + n.replace(/`/g, '``') + '`' : '"' + n.replace(/"/g, '""') + '"')
  const drop = async (n: string): Promise<void> => {
    if (n === s.database) { toast('Switch to another database before dropping this one.'); return }
    if (!(await confirmDialog(`Drop database "${n}"?`, 'Every table and all data in it are permanently deleted.', { ok: 'Drop', danger: true, requireText: n }))) return
    const r = await runSql([`DROP DATABASE ${ident(n)}`])
    if (r?.[0]?.error) fail(r[0].error); else load()
  }
  const rename = async (n: string): Promise<void> => {
    if (n === s.database) { toast('Switch to another database before renaming this one.'); return }
    const to = await promptDialog(`Rename database "${n}"`, n, { ok: 'Rename' })
    if (!to?.trim() || to === n) return
    const r = await runSql([`ALTER DATABASE ${ident(n)} RENAME TO ${ident(to.trim())}`])
    if (r?.[0]?.error) fail(r[0].error); else load()
  }
  return (
    <Modal
      title="Open database"
      onClose={onClose}
      width={460}
      footer={<>
        {!isMongo && s.conn?.driver !== 'sqlite' && <button className="btn" style={{ marginRight: 'auto' }} onClick={() => setCreating(true)}>New…</button>}
        {s.conn?.driver === 'sqlite' && <button className="btn" style={{ marginRight: 'auto' }} onClick={async () => { const n = await promptDialog('New SQLite database file', 'new_database'); if (n?.trim()) { await call('db.create', s.sessionId, n.trim()).catch(fail); load() } }}>New file…</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!sel} onClick={() => sel && open(sel)}>Open</button>
      </>}
    >
      <input className="input" autoFocus placeholder="Search databases" aria-label="Search databases" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (sel ?? list[0])) open(sel ?? list[0]) }} />
      <div style={{ maxHeight: 340, overflow: 'auto', margin: '0 calc(-1 * var(--sp-3))' }} role="listbox">
        {list.map((n) => (
          <div key={n} role="option" aria-selected={sel === n} className={`list-item ${sel === n ? 'selected' : ''}`} onClick={() => setSel(n)} onDoubleClick={() => open(n)} onContextMenu={(e) => menuAt(e, [
            { label: 'Open', onClick: () => open(n) },
            { label: 'Copy Name', onClick: () => void navigator.clipboard.writeText(n) },
            ...(!isMongo && s.conn?.driver !== 'sqlite' ? [{ sep: true }, { label: 'Rename…', disabled: !canRename, onClick: () => void rename(n) }, { label: 'Drop…', danger: true, onClick: () => void drop(n) }] : [])
          ])}>
            <Icon name="db" size={13} className="faint" /><span className="ellipsis">{n}</span>{n === s.database && <span className="count">current</span>}
          </div>
        ))}
        {!list.length && <div className="empty">No databases</div>}
      </div>
      {creating && <NewDatabase dialect={s.dialect ?? 'postgres'} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load() }} />}
    </Modal>
  )
}

function NewDatabase({ dialect, onClose, onCreated }: { dialect: string; onClose: () => void; onCreated: () => void }): ReactNode {
  const [name, setName] = useState('')
  const [enc, setEnc] = useState(dialect === 'mysql' ? 'utf8mb4' : 'UTF8')
  const [coll, setColl] = useState('')
  const [err, setErr] = useState('')
  const create = async (): Promise<void> => {
    try { await call('db.create', ws().sessionId, name.trim(), enc || undefined, coll || undefined); toast(`Created ${name}`, 'success'); onCreated() } catch (e) { setErr(errText(e)) }
  }
  return (
    <Modal title="New database" onClose={onClose} width={400} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={create}>Create</button></>}>
      <div className="field"><label htmlFor="nd-name">Name</label><input id="nd-name" className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} /></div>
      <div className="field"><label htmlFor="nd-enc">{dialect === 'mysql' ? 'Character set' : 'Encoding'}</label><input id="nd-enc" className="input mono" value={enc} onChange={(e) => setEnc(e.target.value)} /></div>
      <div className="field"><label htmlFor="nd-coll">Collation</label><input id="nd-coll" className="input mono" placeholder="server default" value={coll} onChange={(e) => setColl(e.target.value)} /></div>
      {err && <div className="danger-text">{err}</div>}
    </Modal>
  )
}

export function ConnectionPicker({ onClose }: { onClose: () => void }): ReactNode {
  const [conns, setConns] = useState<Connection[]>([])
  useEffect(() => { void call<Connection[]>('conn.list').then(setConns) }, [])
  const items = (q: string): Item[] =>
    conns.filter((c) => fuzzy(c.name, q, 'contains') || fuzzy(c.host ?? '', q, 'contains')).map((c) => ({
      id: c.id, label: c.name, icon: 'plug', detail: `${DRIVERS.find((x) => x.id === c.driver)?.name} · ${c.driver === 'sqlite' ? c.filePath : c.host}`,
      run: () => { window.dispatchEvent(new CustomEvent('connections:changed')); void openScope(c, { ask: (t) => promptDialog(t, '', { password: true, ok: 'Connect' }) }).catch(fail) }
    }))
  return <PaletteList placeholder="Open a connection" items={items} onClose={onClose} />
}
