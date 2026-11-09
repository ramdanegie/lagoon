// Connection tree: connections → databases → schemas → objects, all in one window. Opening a database creates a
// scope (its own session); objects open as tabs that remember their scope.
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { Column, Connection, DbObject, DriverId, Group, Tag } from '@shared/types'
import { DRIVERS } from '@shared/types'
import { qt, truncateSql, dropObjectSql, cloneTableSql } from '@shared/sqlgen'
import { call, errText, fail, toast, useSetting } from '../lib/api'
import { useScopes, useFocus, useWs, focusOn, setScope, openScope, closeConnection, closeScope, openTab, loadObjects, newQueryTab, runSql, guard, scopes, type Scope } from '../lib/ws'
import { pluginMenuItems } from '../lib/plugins'
import { Icon, kindIcon } from '../components/Icon'
import { confirmDialog, menuAt, promptDialog, type MenuItem } from '../components/ui'
import { ConnectionForm, DriverPicker, UrlImport, DRIVER_COLORS } from './ConnectionForm'
import { ExportConnections, importConnectionsFile, importForeignConnections } from './ConnectionIO'
import { openTool } from './Tools'
import { fuzzy } from './Sidebar'

type FormState = { step: 'driver' } | { step: 'url' } | { step: 'form'; initial: Partial<Connection> & { driver: DriverId } } | null

const ask = (title: string): Promise<string | null> => promptDialog(title, '', { password: true, ok: 'Connect' })
const isSql = (d: DriverId): boolean => d === 'postgres' || d === 'mysql' || d === 'mariadb' || d === 'sqlite'

export function Navigator({ filter }: { filter: string }): ReactNode {
  const allScopes = useScopes()
  const focus = useFocus()
  const activeTab = useWs((s) => s.tabs.find((t) => t.id === s.active))
  const [conns, setConns] = useState<Connection[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [dbs, setDbs] = useState<Record<string, string[]>>({})
  const [schemaList, setSchemaList] = useState<Record<string, string[]>>({})
  const [schemaObjs, setSchemaObjs] = useState<Record<string, DbObject[]>>({})
  const [cols, setCols] = useState<Record<string, Column[]>>({})
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [form, setForm] = useState<FormState>(null)
  const [exportIds, setExportIds] = useState<string[] | null>(null)
  const [sortBy, setSortBy] = useSetting<'name' | 'tag' | 'driver'>('welcome.sortBy', 'name')
  const [sysSchemas] = useSetting('table.showSystemSchemas', false)
  const [showCols] = useSetting('sidebar.showColumns', false)
  const [match] = useSetting<'fuzzy' | 'contains'>('sidebar.match', 'fuzzy')

  const loadConns = useCallback(async () => {
    const [c, g, t] = await Promise.all([call<Connection[]>('conn.list'), call<Group[]>('group.list'), call<Tag[]>('tag.list')])
    setConns(c); setGroups(g); setTags(t)
  }, [])
  useEffect(() => {
    void loadConns()
    const h = (): void => void loadConns()
    const nc = (): void => setForm({ step: 'driver' })
    window.addEventListener('connections:changed', h)
    window.addEventListener('nav:newConnection', nc)
    return () => { window.removeEventListener('connections:changed', h); window.removeEventListener('nav:newConnection', nc) }
  }, [loadConns])

  const toggle = (k: string, v?: boolean): void => setOpen((o) => ({ ...o, [k]: v ?? !o[k] }))
  const busy = async (k: string, fn: () => Promise<void>): Promise<void> => {
    setPending((p) => ({ ...p, [k]: true }))
    setErrors((e) => { const n = { ...e }; delete n[k]; return n })
    try { await fn() } catch (e) { setErrors((x) => ({ ...x, [k]: errText(e) })) } finally { setPending((p) => ({ ...p, [k]: false })) }
  }

  const scopesOf = (connId: string): Scope[] => Object.values(allScopes).filter((s) => s.conn.id === connId)

  const fetchDbs = async (sc: Scope): Promise<void> => {
    const d = sc.conn.driver
    if (d === 'redis') return
    const all = d === 'mongodb' ? await call<string[]>('mongo.databases', sc.sessionId) : await call<string[]>('db.databases', sc.sessionId)
    const SYSTEM = d === 'mongodb' ? ['admin', 'config', 'local'] : d === 'mysql' || d === 'mariadb' ? ['information_schema', 'mysql', 'performance_schema', 'sys'] : []
    const list = sysSchemas ? all : all.filter((x) => !SYSTEM.includes(x) || x === sc.database)
    setDbs((x) => ({ ...x, [sc.conn.id]: list.includes(sc.database ?? '') || !sc.database ? list : [sc.database, ...list] }))
  }

  const fetchSchemas = async (sc: Scope): Promise<void> => {
    if (sc.dialect !== 'postgres') return
    setSchemaList((x) => ({ ...x, [sc.id]: [] }))
    const list = await call<string[]>('db.schemas', sc.sessionId, sysSchemas)
    setSchemaList((x) => ({ ...x, [sc.id]: list }))
  }

  /** Reveal a freshly opened scope: expand its connection, database and schema, list siblings. */
  const reveal = async (sc: Scope): Promise<void> => {
    setOpen((o) => ({ ...o, [`c:${sc.conn.id}`]: true, [`d:${sc.id}`]: true, [`s:${sc.id}:${sc.schema ?? ''}`]: true }))
    await Promise.all([fetchDbs(sc).catch(() => {}), fetchSchemas(sc).catch(() => {})])
  }
  useEffect(() => {
    for (const sc of Object.values(allScopes)) if (sc.sessionId && !dbs[sc.conn.id] && !pending[`r:${sc.id}`]) { setPending((p) => ({ ...p, [`r:${sc.id}`]: true })); void reveal(sc) }
  }, [allScopes])

  const connect = (c: Connection): Promise<void> => busy(`c:${c.id}`, async () => {
    const id = await openScope(c, { ask })
    await reveal(scopes()[id])
  })

  const openDb = (c: Connection, db: string): Promise<void> => busy(`d:${c.id}:${db}`, async () => {
    const id = await openScope(c, { database: db, ask })
    const sc = scopes()[id]
    setOpen((o) => ({ ...o, [`d:${id}`]: true, [`s:${id}:${sc.schema ?? ''}`]: true }))
    await fetchSchemas(sc)
  })

  const disconnect = async (c: Connection): Promise<void> => {
    const tabs = useWs.getState().tabs.filter((t) => scopes()[t.scope ?? '']?.conn.id === c.id)
    const dirty = tabs.filter((t) => (useWs.getState().tabApis[t.id]?.pendingCount() ?? 0) > 0)
    if (dirty.length && !(await confirmDialog(`Disconnect ${c.name}?`, `${dirty.length} tab(s) have uncommitted changes that will be lost.`, { ok: 'Disconnect', danger: true }))) return
    await closeConnection(c.id)
    setDbs((x) => { const n = { ...x }; delete n[c.id]; return n })
    setOpen((o) => ({ ...o, [`c:${c.id}`]: false }))
  }

  const objectsFor = (sc: Scope, schema: string): DbObject[] => (sc.schema === schema || sc.dialect !== 'postgres' ? sc.objects : schemaObjs[`${sc.id}|${schema}`] ?? [])

  const openSchema = async (sc: Scope, schema: string): Promise<void> => {
    toggle(`s:${sc.id}:${schema}`, true)
    if (sc.schema === schema) return
    if (!schemaObjs[`${sc.id}|${schema}`]) {
      const objs = await call<DbObject[]>('db.objects', sc.sessionId, schema).catch((e) => { fail(e); return [] as DbObject[] })
      setSchemaObjs((x) => ({ ...x, [`${sc.id}|${schema}`]: objs }))
    }
  }

  /** Make a schema the scope's working schema (editor default, autocomplete, Open Anything). */
  const pickSchema = (sc: Scope, schema: string): void => {
    focusOn(sc.id, schema)
    if (sc.schema !== schema) void loadObjects(sc.id)
  }

  // ---------- object actions (always bound to the node's scope) ----------
  const openObj = (sc: Scope, o: DbObject, preview: boolean, newTab = false): void => {
    focusOn(sc.id, sc.dialect === 'postgres' ? o.schema : undefined)
    const base = { scope: sc.id, title: o.name, name: o.name, objKind: o.kind, preview }
    if (o.kind === 'function' || o.kind === 'procedure' || o.kind === 'sequence') openTab({ ...base, kind: 'ddl', schema: o.schema }, { newTab })
    else if (o.kind === 'collection' || (sc.conn.driver === 'mongodb' && o.kind === 'view')) openTab({ ...base, kind: 'mongo' }, { newTab })
    else openTab({ ...base, kind: 'table', schema: o.schema, view: 'data' }, { newTab })
  }

  const keyOf = (o: DbObject): string => `${o.schema}.${o.name}`
  const select = (sc: Scope, o: DbObject, list: DbObject[], e: React.MouseEvent): void => {
    const sel = sc.selectedObjects
    if (e.shiftKey && sel.length) {
      const a = list.findIndex((x) => keyOf(x) === keyOf(sel[sel.length - 1]))
      const b = list.findIndex((x) => keyOf(x) === keyOf(o))
      setScope(sc.id, { selectedObjects: list.slice(Math.min(a, b), Math.max(a, b) + 1) })
    } else if (e.metaKey || e.ctrlKey) setScope(sc.id, { selectedObjects: sel.some((x) => keyOf(x) === keyOf(o)) ? sel.filter((x) => keyOf(x) !== keyOf(o)) : [...sel, o] })
    else setScope(sc.id, { selectedObjects: [o] })
  }

  const refreshScope = async (sc: Scope): Promise<void> => {
    await loadObjects(sc.id)
    setSchemaObjs((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith(sc.id + '|'))))
  }

  const dropObjects = async (sc: Scope, objs: DbObject[]): Promise<void> => {
    if (!objs.length) return
    if (sc.conn.driver === 'mongodb') {
      if (!(await confirmDialog(`Drop ${objs.length} collection(s)?`, objs.map((o) => o.name).join('\n'), { ok: 'Drop', danger: true }))) return
      if (!(await guard(objs.map((o) => `db.${o.name}.drop()`), sc.id))) return
      for (const o of objs) await call('mongo.dropCollection', sc.sessionId, o.name).catch(fail)
    } else {
      const stmts = objs.map((o) => dropObjectSql(sc.dialect!, o.kind, o.schema, o.name))
      if (!(await confirmDialog(`Delete ${objs.length} item(s)?`, stmts.join('\n'), { ok: 'Delete', danger: true }))) return
      const r = await runSql(stmts, { stopOnError: true, scope: sc.id })
      const err = r?.find((x) => x.error)
      if (err) fail(err.error)
    }
    setScope(sc.id, { selectedObjects: [] })
    await refreshScope(sc)
  }

  const truncate = async (sc: Scope, objs: DbObject[]): Promise<void> => {
    const tables = objs.filter((o) => o.kind === 'table' || o.kind === 'collection')
    if (!tables.length) return
    if (sc.conn.driver === 'mongodb') {
      if (!(await confirmDialog(`Empty ${tables.length} collection(s)?`, '', { ok: 'Empty', danger: true }))) return
      if (!(await guard(tables.map((o) => `db.${o.name}.deleteMany({})`), sc.id))) return
      for (const o of tables) await call('mongo.truncateCollection', sc.sessionId, o.name).catch(fail)
      return
    }
    const opts = sc.dialect === 'postgres'
      ? await promptDialog(`Truncate ${tables.length} table(s)?`, '', { ok: 'Truncate', message: 'Options (optional): type "cascade", "restart" or both.' })
      : (await confirmDialog(`Truncate ${tables.length} table(s)?`, tables.map((t) => t.name).join('\n'), { ok: 'Truncate', danger: true })) ? '' : null
    if (opts === null) return
    const r = await runSql(tables.map((o) => truncateSql(sc.dialect!, o.schema, o.name, { cascade: /cascade/i.test(opts), restartIdentity: /restart/i.test(opts) })), { scope: sc.id })
    const err = r?.find((x) => x.error)
    if (err) fail(err.error)
    else if (r) window.dispatchEvent(new CustomEvent('ws:reload'))
  }

  const copyScript = async (sc: Scope, o: DbObject, what: 'create' | 'drop' | 'truncate' | 'select'): Promise<void> => {
    const d = sc.dialect!
    const text = what === 'create' ? await call<string>('db.ddl', sc.sessionId, o.schema, o.name, o.kind)
      : what === 'drop' ? dropObjectSql(d, o.kind, o.schema, o.name)
        : what === 'truncate' ? truncateSql(d, o.schema, o.name)
          : `SELECT * FROM ${qt(d, o.schema, o.name)} LIMIT 100;`
    await navigator.clipboard.writeText(text)
    toast('Copied to clipboard')
  }

  const [pins, setPins] = useSetting<Record<string, string[]>>('pins', {})
  const itemMenu = (sc: Scope, o: DbObject): MenuItem[] => {
    const sel = sc.selectedObjects
    const many = sel.some((x) => keyOf(x) === keyOf(o)) && sel.length > 1 ? sel : [o]
    const sql = !!sc.dialect
    const isTable = o.kind === 'table'
    const pinKey = `${sc.conn.id}`
    const pinned = (pins[pinKey] ?? []).includes(keyOf(o))
    const withFocus = (f: () => void) => () => { focusOn(sc.id, sc.dialect === 'postgres' ? o.schema : undefined); f() }
    return [
      { label: 'Open', onClick: () => openObj(sc, o, false) },
      { label: 'Open in New Tab', onClick: () => openObj(sc, o, false, true) },
      ...(sql && (isTable || o.kind === 'view' || o.kind === 'matview') ? [{ label: 'Open Structure', onClick: withFocus(() => openTab({ scope: sc.id, kind: 'table', title: o.name, schema: o.schema, name: o.name, objKind: o.kind, view: 'structure' })) }] : []),
      ...(sql && isTable ? [{ label: 'Show Diagram', onClick: withFocus(() => openTab({ scope: sc.id, kind: 'diagram', title: `Diagram · ${o.schema || sc.database}`, schema: o.schema })) }] : []),
      ...(sql ? [{ label: 'New Query Here', onClick: withFocus(() => newQueryTab(`SELECT * FROM ${qt(sc.dialect!, o.schema, o.name)} LIMIT 100;`)) }] : []),
      { sep: true },
      { label: 'Copy Name', onClick: () => void navigator.clipboard.writeText(many.map((x) => x.name).join('\n')) },
      ...(sql ? [{ label: 'Copy Script As', submenu: [
        { label: 'CREATE', onClick: () => void copyScript(sc, o, 'create') },
        { label: 'DROP', onClick: () => void copyScript(sc, o, 'drop') },
        ...(isTable ? [{ label: 'TRUNCATE', onClick: () => void copyScript(sc, o, 'truncate') }, { label: 'SELECT first 100', onClick: () => void copyScript(sc, o, 'select') }] : [])
      ] }] : []),
      { label: pinned ? 'Unpin from Top' : 'Pin to Top', onClick: () => setPins({ ...pins, [pinKey]: pinned ? (pins[pinKey] ?? []).filter((p) => p !== keyOf(o)) : [...(pins[pinKey] ?? []), keyOf(o)] }) },
      ...(sql ? [
        { sep: true },
        { label: 'Export…', onClick: withFocus(() => openTool({ kind: 'export', items: many })) },
        ...(isTable ? [{ label: 'Import', submenu: (['csv', 'json', 'sql'] as const).map((f) => ({ label: `From ${f.toUpperCase()}…`, onClick: withFocus(() => openTool({ kind: 'import', format: f, table: o })) })) }] : []),
        ...(isTable ? [{ label: 'Transfer to Another Connection…', onClick: withFocus(() => openTool({ kind: 'transfer', items: many.filter((x) => x.kind === 'table') })) }, { label: 'Generate Test Data…', onClick: withFocus(() => openTool({ kind: 'generate', table: o })) }] : [])
      ] : []),
      { sep: true },
      ...(sql && isTable ? [{ label: 'Clone…', onClick: async () => {
        const name = await promptDialog('Clone table', `${o.name}_clone`, { ok: 'Clone', message: 'New table name. Add " -empty" to copy the structure only.' })
        if (!name?.trim()) return
        const r = await runSql(cloneTableSql(sc.dialect!, o.schema, o.name, name.replace(/ -empty$/, '').trim(), !/ -empty$/.test(name)), { stopOnError: true, scope: sc.id })
        if (r?.some((x) => x.error)) fail(r.find((x) => x.error)!.error); else await refreshScope(sc)
      } }] : []),
      ...(isTable || o.kind === 'collection' ? [{ label: 'Truncate…', onClick: () => void truncate(sc, many) }] : []),
      { label: many.length > 1 ? `Delete ${many.length} Items…` : 'Delete…', danger: true, onClick: () => void dropObjects(sc, many) },
      ...pluginMenuItems('sidebarItem', () => ({ table: { schema: o.schema, name: o.name, kind: o.kind }, sessionId: sc.sessionId }))
    ]
  }

  const newItemsMenu = (sc: Scope, schema?: string): MenuItem[] => {
    const f = (fn: () => void) => () => { focusOn(sc.id, schema); fn() }
    if (sc.conn.driver === 'mongodb') return [{ label: 'New Collection…', onClick: async () => { const n = await promptDialog('New collection'); if (n?.trim()) { await call('mongo.createCollection', sc.sessionId, n.trim()).catch(fail); await refreshScope(sc) } } }]
    return [
      { label: 'New Query', onClick: f(() => newQueryTab()) },
      { sep: true },
      { label: 'New Table', onClick: f(() => openTab({ scope: sc.id, kind: 'table', title: 'New table', schema: schema ?? sc.schema, name: '', isNew: true, view: 'structure' }, { newTab: true })) },
      { label: 'New View', onClick: f(() => openTab({ scope: sc.id, kind: 'ddl', title: 'New view', schema: schema ?? sc.schema, objKind: 'view', isNew: true }, { newTab: true })) },
      ...(sc.dialect === 'postgres' ? [{ label: 'New Materialized View', onClick: f(() => openTab({ scope: sc.id, kind: 'ddl', title: 'New materialized view', schema: schema ?? sc.schema, objKind: 'matview', isNew: true }, { newTab: true })) }] : []),
      ...(sc.dialect !== 'sqlite' ? [{ label: 'New Function / Procedure', onClick: f(() => openTab({ scope: sc.id, kind: 'ddl', title: 'New function', schema: schema ?? sc.schema, objKind: 'function', isNew: true }, { newTab: true })) }] : []),
      ...(sc.dialect === 'postgres' ? [{ label: 'New Schema…', onClick: async () => { const n = await promptDialog('New schema'); if (n?.trim()) { const r = await runSql([`CREATE SCHEMA "${n.trim().replace(/"/g, '""')}"`], { scope: sc.id }); if (r?.[0]?.error) fail(r[0].error); else await fetchSchemas(sc) } } }] : []),
      { sep: true },
      { label: 'ER Diagram', onClick: f(() => openTab({ scope: sc.id, kind: 'diagram', title: `Diagram · ${schema ?? sc.schema ?? sc.database}`, schema: schema ?? sc.schema })) },
      { label: 'Metrics Board', onClick: f(() => openTab({ scope: sc.id, kind: 'metrics', title: 'Metrics' })) },
      { label: 'Data Dictionary…', onClick: f(() => openTool({ kind: 'dictionary' })) },
      { label: 'Export Tables…', onClick: f(() => openTool({ kind: 'export', items: [] })) },
      { label: 'Refresh', onClick: () => { void refreshScope(sc); void fetchSchemas(sc) } }
    ]
  }

  // ---------- connection management ----------
  const tagOf = (id?: string | null): Tag | undefined => tags.find((t) => t.id === id)
  const newGroup = async (parentId: string | null = null): Promise<void> => {
    const name = await promptDialog('New group', '', { ok: 'Create' })
    if (name?.trim()) setGroups(await call<Group[]>('group.save', { name: name.trim(), parentId }))
  }
  const rootMenu = (): MenuItem[] => [
    { label: 'New Connection…', onClick: () => setForm({ step: 'driver' }) },
    { label: 'New Connection from URL…', onClick: () => setForm({ step: 'url' }) },
    { label: 'New Group…', onClick: () => void newGroup() },
    { sep: true },
    { label: 'Import Connections', submenu: [
      { label: 'Lagoon File…', onClick: () => void importConnectionsFile().then((n) => { if (n) void loadConns() }) },
      { sep: true },
      ...(['tableplus', 'dbeaver', 'navicat'] as const).map((app) => ({ label: `From ${({ tableplus: 'TablePlus', dbeaver: 'DBeaver', navicat: 'Navicat (.ncx)…' })[app]}`, onClick: () => void importForeignConnections(app).then((n) => { if (n) void loadConns() }) }))
    ] },
    { label: 'Export All Connections…', disabled: !conns.length, onClick: () => setExportIds(conns.map((c) => c.id)) },
    { label: 'Sort By', submenu: (['name', 'tag', 'driver'] as const).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), checked: sortBy === k, onClick: () => setSortBy(k) })) }
  ]
  const connMenu = (c: Connection): MenuItem[] => {
    const connected = scopesOf(c.id).length > 0
    const first = scopesOf(c.id)[0]
    return [
      connected ? { label: 'Disconnect', onClick: () => void disconnect(c) } : { label: 'Connect', onClick: () => void connect(c) },
      ...(connected && first && isSql(c.driver) ? [{ label: 'New Query', onClick: () => { focusOn(first.id); newQueryTab() } }] : []),
      ...(connected && first ? [{ label: 'Refresh', onClick: () => void fetchDbs(first) }] : []),
      { sep: true },
      { label: 'Edit…', onClick: () => setForm({ step: 'form', initial: c }) },
      { label: 'Duplicate', onClick: async () => { await call('conn.duplicate', c.id); void loadConns() } },
      { label: 'Copy as URL', onClick: async () => { await navigator.clipboard.writeText(await call<string>('conn.toUrl', c.id)); toast('URL copied (includes the password)') } },
      { label: 'Move to Group', submenu: [{ label: 'No group', checked: !c.groupId, onClick: () => void call('conn.patch', c.id, { groupId: null }).then(loadConns) }, ...groups.map((g) => ({ label: g.name, checked: c.groupId === g.id, onClick: () => void call('conn.patch', c.id, { groupId: g.id }).then(loadConns) }))] },
      { label: 'Export…', onClick: () => setExportIds([c.id]) },
      { sep: true },
      ...rootMenu(),
      { sep: true },
      { label: 'Delete…', danger: true, onClick: async () => {
        if (!(await confirmDialog(`Delete "${c.name}"?`, 'The saved connection and its stored password are removed.', { ok: 'Delete', danger: true }))) return
        await closeConnection(c.id); await call('conn.delete', c.id); void loadConns()
      } }
    ]
  }

  // ---------- rendering ----------
  const row = (p: { k: string; depth: number; label: string; icon?: ReactNode; caret?: boolean; expanded?: boolean; selected?: boolean; dim?: boolean; extra?: ReactNode; title?: string; onToggle?: () => void; onClick?: (e: React.MouseEvent) => void; onDoubleClick?: () => void; onMenu?: (e: React.MouseEvent) => void; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void; onDrop?: (e: React.DragEvent) => void }): ReactNode => (
    <div
      key={p.k}
      role="treeitem"
      aria-label={p.label}
      aria-expanded={p.caret ? !!p.expanded : undefined}
      aria-selected={!!p.selected}
      tabIndex={-1}
      className={`list-item nav-row ${p.selected ? 'selected' : ''}`}
      style={{ paddingLeft: 4 + p.depth * 14, opacity: p.dim ? 0.55 : 1 }}
      title={p.title ?? p.label}
      draggable={p.draggable}
      onDragStart={p.onDragStart}
      onDragOver={p.onDrop ? (e) => e.preventDefault() : undefined}
      onDrop={p.onDrop}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onContextMenu={p.onMenu}
      onKeyDown={(e) => { if (e.key === 'Enter') p.onDoubleClick?.(); if (e.key === 'ArrowRight' && p.caret && !p.expanded) p.onToggle?.(); if (e.key === 'ArrowLeft' && p.expanded) p.onToggle?.() }}
    >
      <span className="nav-caret" onClick={(e) => { if (p.caret) { e.stopPropagation(); p.onToggle?.() } }} aria-hidden>
        {p.caret ? <Icon name={p.expanded ? 'chevronDown' : 'chevronRight'} size={9} /> : null}
      </span>
      {p.icon}
      <span className="ellipsis">{p.label}</span>
      {p.extra}
    </div>
  )

  const renderObjects = (sc: Scope, schema: string, depth: number): ReactNode[] => {
    const all = objectsFor(sc, schema)
    const list = all.filter((o) => fuzzy(o.name, filter, match))
    const pinned = (pins[sc.conn.id] ?? [])
    const isActive = (o: DbObject): boolean => activeTab?.scope === sc.id && activeTab?.name === o.name && (activeTab?.schema ?? '') === (o.schema ?? '')
    const sel = new Set(sc.selectedObjects.map(keyOf))
    const sections: [string, string, DbObject[]][] = [
      ['pinned', 'Pinned', list.filter((o) => pinned.includes(keyOf(o)))],
      ['tables', sc.conn.driver === 'mongodb' ? 'Collections' : 'Tables', list.filter((o) => ['table', 'view', 'matview', 'collection'].includes(o.kind))],
      ['functions', 'Functions', list.filter((o) => o.kind === 'function' || o.kind === 'procedure')],
      ['sequences', 'Sequences', list.filter((o) => o.kind === 'sequence')]
    ]
    if (sc.objectsLoading && !all.length) return [<div key={`l:${sc.id}:${schema}`} className="faint nav-note" style={{ paddingLeft: 18 + depth * 14 }}>Loading…</div>]
    if (!all.length) return [<div key={`e:${sc.id}:${schema}`} className="faint nav-note" style={{ paddingLeft: 18 + depth * 14 }}>{sc.conn.driver === 'mongodb' ? 'No collections' : 'No tables'}</div>]
    return sections.filter(([, , items]) => items.length).flatMap(([id, title, items]) => {
      const k = `sec:${sc.id}:${schema}:${id}`
      const expanded = open[k] ?? id !== 'sequences'
      return [
        row({
          k, depth, label: `${title}`, caret: true, expanded, extra: <span className="count">{items.length}</span>, onToggle: () => toggle(k, !expanded),
          // SQL "Tables" opens the overview (row counts, sizes); the caret still expands the list
          ...(id === 'tables' && sc.dialect
            ? { onClick: () => { focusOn(sc.id, sc.dialect === 'postgres' ? schema : undefined); openTab({ scope: sc.id, kind: 'tables', title: `Tables · ${schema || sc.database}`, schema }) }, onDoubleClick: () => toggle(k, !expanded) }
            : { onClick: () => toggle(k, !expanded) })
        }),
        ...(expanded ? items.flatMap((o, i) => {
          const ok = `o:${sc.id}:${keyOf(o)}`
          const rk = `${ok}:${id}:${i}` // pinned objects are listed twice and PG function overloads share a name
          return [
            row({
              k: rk, depth: depth + 1, label: o.name, title: `${sc.conn.name} · ${sc.database ?? ''} · ${o.schema ? o.schema + '.' : ''}${o.name}`,
              icon: <Icon name={kindIcon(o.kind)} size={13} className="faint" />,
              caret: showCols && !!sc.dialect && (o.kind === 'table' || o.kind === 'view'), expanded: !!open[ok],
              onToggle: async () => { toggle(ok); if (!cols[ok]) setCols((c) => ({ ...c, [ok]: [] })); if (!cols[ok]?.length) { const cs = await call<Column[]>('db.columns', sc.sessionId, o.schema, o.name).catch(() => []); setCols((c) => ({ ...c, [ok]: cs })) } },
              selected: (focus === sc.id && sel.has(keyOf(o))) || isActive(o),
              extra: pinned.includes(keyOf(o)) ? <Icon name="pin" size={10} className="faint" /> : undefined,
              onClick: (e) => { select(sc, o, items, e); if (!e.metaKey && !e.ctrlKey && !e.shiftKey) openObj(sc, o, true) },
              onDoubleClick: () => openObj(sc, o, false),
              onMenu: (e) => { if (!sel.has(keyOf(o))) setScope(sc.id, { selectedObjects: [o] }); focusOn(sc.id, sc.dialect === 'postgres' ? o.schema : undefined); menuAt(e, itemMenu(sc, o)) }
            }),
            ...(open[ok] ? (cols[ok] ?? []).map((c) => (
              <div key={`${rk}:${c.name}`} className="list-item nav-note" style={{ paddingLeft: 34 + (depth + 1) * 14, fontSize: 'var(--fs-sm)' }}>
                {c.pk ? <Icon name="key" size={10} className="faint" /> : <span style={{ width: 10 }} />}
                <span className="ellipsis">{c.name}</span><span className="count mono">{c.type}</span>
              </div>
            )) : [])
          ]
        }) : [])
      ]
    })
  }

  const renderDatabase = (c: Connection, db: string, depth: number): ReactNode[] => {
    const sc = Object.values(allScopes).find((s) => s.conn.id === c.id && s.database === db)
    const k = sc ? `d:${sc.id}` : `d:${c.id}:${db}`
    const expanded = !!(sc && open[k])
    const nodes: ReactNode[] = [row({
      k: `db:${c.id}:${db}`, depth, label: db, icon: <Icon name="db" size={13} className={sc ? '' : 'faint'} />, caret: true, expanded,
      selected: !!sc && focus === sc.id && !activeTab, dim: !sc,
      extra: pending[`d:${c.id}:${db}`] ? <span className="count">…</span> : undefined,
      onToggle: () => (sc ? toggle(k) : void openDb(c, db)),
      onClick: () => { if (sc) focusOn(sc.id) },
      onDoubleClick: () => (sc ? toggle(k) : void openDb(c, db)),
      onMenu: (e) => menuAt(e, sc ? [
        ...newItemsMenu(sc),
        { sep: true },
        { label: 'Close Database', onClick: () => void closeScope(sc.id) }
      ] : [{ label: 'Open', onClick: () => void openDb(c, db) }])
    })]
    if (errors[`d:${c.id}:${db}`]) nodes.push(<div key={`err:${c.id}:${db}`} className="danger-text nav-note selectable" style={{ paddingLeft: 18 + (depth + 1) * 14 }}>{errors[`d:${c.id}:${db}`]}</div>)
    if (!sc || !expanded) return nodes
    if (sc.dialect === 'postgres') {
      const list = schemaList[sc.id] ?? (sc.schema ? [sc.schema] : [])
      for (const schema of list) {
        const sk = `s:${sc.id}:${schema}`
        const sx = !!open[sk]
        nodes.push(row({
          k: sk, depth: depth + 1, label: schema, icon: <Icon name="folder" size={13} className="faint" />, caret: true, expanded: sx,
          selected: focus === sc.id && sc.schema === schema && !activeTab,
          extra: sc.schema === schema ? <span className="count">default</span> : undefined,
          onToggle: () => (sx ? toggle(sk, false) : void openSchema(sc, schema)),
          onClick: () => pickSchema(sc, schema),
          onDoubleClick: () => (sx ? toggle(sk, false) : void openSchema(sc, schema)),
          onMenu: (e) => { pickSchema(sc, schema); menuAt(e, newItemsMenu(sc, schema)) }
        }))
        if (sx) nodes.push(...renderObjects(sc, schema, depth + 2))
      }
      return nodes
    }
    nodes.push(...renderObjects(sc, sc.schema ?? '', depth + 1))
    return nodes
  }

  const renderConn = (c: Connection, depth: number): ReactNode[] => {
    const scs = scopesOf(c.id)
    const connected = scs.length > 0
    const lost = scs.some((s) => s.lost)
    const k = `c:${c.id}`
    const expanded = connected && !!open[k]
    const t = tagOf(c.tagId)
    const drv = DRIVERS.find((d) => d.id === c.driver)!
    if (filter && !fuzzy(c.name, filter, 'contains') && !expanded) return []
    const nodes: ReactNode[] = [row({
      k, depth, label: c.name, caret: true, expanded,
      title: c.driver === 'sqlite' ? c.filePath : `${drv.name} · ${c.ssh?.enabled ? 'SSH · ' : ''}${c.host ?? ''}${c.port ? ':' + c.port : ''}`,
      icon: <span className="nav-drv" style={{ background: DRIVER_COLORS[c.driver], boxShadow: c.statusColor ? `0 0 0 2px ${c.statusColor}` : undefined }}>{drv.short}</span>,
      selected: !!focus && scs.some((s) => s.id === focus) && !activeTab,
      extra: <>
        {t && <span className="badge" style={{ background: t.color }}>{t.name}</span>}
        <span className="dot" style={{ marginLeft: 'auto', background: lost ? 'var(--danger)' : connected ? 'var(--success)' : 'transparent' }} title={lost ? 'Connection lost' : connected ? 'Connected' : 'Not connected'} />
        {pending[k] && <span className="count">…</span>}
      </>,
      draggable: true,
      onDragStart: (e) => e.dataTransfer.setData('text/conn', c.id),
      onToggle: () => (connected ? toggle(k) : void connect(c)),
      onClick: () => { if (scs[0]) focusOn(scs[0].id) },
      onDoubleClick: () => (connected ? toggle(k) : void connect(c)),
      onMenu: (e) => menuAt(e, connMenu(c))
    })]
    if (errors[k]) nodes.push(
      <div key={`err:${k}`} className="nav-note" style={{ paddingLeft: 18 + (depth + 1) * 14 }}>
        <div className="danger-text selectable" style={{ whiteSpace: 'pre-wrap' }}>{errors[k]}</div>
        <div className="row" style={{ marginTop: 4 }}><button className="btn sm" onClick={() => void connect(c)}>Retry</button><button className="btn sm" onClick={() => setForm({ step: 'form', initial: c })}>Edit</button></div>
      </div>
    )
    if (!expanded) return nodes
    if (c.driver === 'redis') {
      const sc = scs[0]
      nodes.push(row({ k: `rk:${c.id}`, depth: depth + 1, label: `Keys · db${sc?.database ?? 0}`, icon: <Icon name="key" size={13} className="faint" />, onClick: () => { if (sc) { focusOn(sc.id); openTab({ scope: sc.id, kind: 'redis', title: `${c.name} · db${sc.database ?? 0}` }) } }, onDoubleClick: () => { if (sc) openTab({ scope: sc.id, kind: 'redis', title: `${c.name} · db${sc.database ?? 0}` }) } }))
      return nodes
    }
    const list = dbs[c.id] ?? scs.map((s) => s.database ?? '').filter(Boolean)
    for (const db of list) nodes.push(...renderDatabase(c, db, depth + 1))
    if (!list.length) nodes.push(<div key={`ld:${c.id}`} className="faint nav-note" style={{ paddingLeft: 18 + (depth + 1) * 14 }}>Loading databases…</div>)
    return nodes
  }

  const sorted = [...conns].sort((a, b) => {
    const key = (c: Connection): string => (sortBy === 'tag' ? tagOf(c.tagId)?.name ?? '~' : sortBy === 'driver' ? c.driver : '') + c.name.toLowerCase()
    return key(a).localeCompare(key(b))
  })

  const renderGroup = (parentId: string | null, depth: number): ReactNode[] =>
    groups.filter((g) => (g.parentId ?? null) === parentId).flatMap((g) => {
      const k = `g:${g.id}`
      const expanded = open[k] ?? true
      const inside = sorted.filter((c) => c.groupId === g.id)
      return [
        row({
          k, depth, label: `${g.icon ? g.icon + ' ' : ''}${g.name}`, caret: true, expanded, icon: <Icon name="folder" size={13} className="faint" />,
          extra: <span className="count">{inside.length}</span>,
          onToggle: () => toggle(k, !expanded), onClick: () => toggle(k, !expanded),
          onDrop: (e) => { const id = e.dataTransfer.getData('text/conn'); if (id) void call('conn.patch', id, { groupId: g.id }).then(loadConns) },
          onMenu: (e) => menuAt(e, [
            { label: 'Rename Group…', onClick: async () => { const n = await promptDialog('Rename group', g.name); if (n?.trim()) setGroups(await call<Group[]>('group.save', { ...g, name: n.trim() })) } },
            { label: 'New Subgroup…', onClick: () => void newGroup(g.id) },
            { label: 'Export This Group…', onClick: () => setExportIds(conns.filter((c) => c.groupId === g.id).map((c) => c.id)) },
            { label: 'Delete Group…', danger: true, onClick: async () => { if (await confirmDialog(`Delete group "${g.name}"?`, 'Every connection inside this group is deleted too.', { ok: 'Delete', danger: true })) { await call('group.delete', g.id); void loadConns() } } }
          ])
        }),
        ...(expanded ? [...renderGroup(g.id, depth + 1), ...inside.flatMap((c) => renderConn(c, depth + 1))] : [])
      ]
    })

  const ungrouped = sorted.filter((c) => !c.groupId || !groups.some((g) => g.id === c.groupId))

  return (
    <div
      className="nav-tree"
      role="tree"
      aria-label="Connections"
      onContextMenu={(e) => { if (e.target === e.currentTarget) menuAt(e, rootMenu()) }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { const id = e.dataTransfer.getData('text/conn'); if (id && e.target === e.currentTarget) void call('conn.patch', id, { groupId: null }).then(loadConns) }}
      onKeyDown={(e) => {
        if (e.key !== 'Backspace' && e.key !== 'Delete') return
        const sc = focus ? scopes()[focus] : undefined
        if (sc?.selectedObjects.length && (e.target as HTMLElement).getAttribute('role') === 'treeitem') { e.preventDefault(); void (e.altKey ? truncate(sc, sc.selectedObjects) : dropObjects(sc, sc.selectedObjects)) }
      }}
    >
      {conns.length === 0 ? (
        <div className="empty">
          <Icon name="db" size={28} />
          <div>No connections yet.</div>
          <button className="btn primary sm" onClick={() => setForm({ step: 'driver' })}>New connection</button>
        </div>
      ) : (
        <>
          {renderGroup(null, 0)}
          {ungrouped.flatMap((c) => renderConn(c, 0))}
        </>
      )}
      <div style={{ height: 24 }} onContextMenu={(e) => menuAt(e, rootMenu())} />
      {form?.step === 'driver' && <DriverPicker onClose={() => setForm(null)} onPick={(driver) => setForm({ step: 'form', initial: { driver } })} onUrl={() => setForm({ step: 'url' })} />}
      {form?.step === 'url' && <UrlImport onClose={() => setForm(null)} onParsed={(c) => setForm({ step: 'form', initial: c as Partial<Connection> & { driver: DriverId } })} />}
      {form?.step === 'form' && (
        <ConnectionForm
          initial={form.initial}
          onClose={() => setForm(null)}
          onSaved={(c, go) => {
            setForm(null)
            void loadConns().then(() => {
              // a running scope keeps its old settings until reconnect
              for (const s of scopesOf(c.id)) setScope(s.id, { conn: c })
              if (go) void connect(c); else toast(`Saved "${c.name}"`, 'success')
            })
          }}
        />
      )}
      {exportIds && <ExportConnections ids={exportIds} onClose={() => setExportIds(null)} />}
    </div>
  )
}

/** The root "+" menu for the sidebar header. */
export const newConnection = (): void => void window.dispatchEvent(new CustomEvent('nav:newConnection'))
