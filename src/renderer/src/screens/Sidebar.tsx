import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Column, DbObject, HistoryEntry } from '@shared/types'
import { qt, truncateSql, dropObjectSql, cloneTableSql } from '@shared/sqlgen'
import { call, fail, focusScope, toast, useCommands, useSetting } from '../lib/api'
import { useWs, setWs, ws, openTab, loadObjects, newQueryTab, runSql, guard } from '../lib/ws'
import { pluginMenuItems } from '../lib/plugins'
import { Icon, kindIcon } from '../components/Icon'
import { confirmDialog, menuAt, menuBelow, promptDialog, type MenuItem } from '../components/ui'
import { SearchPanel } from './SearchPanel'
import { openTool } from './Tools'
import { QueriesPanel } from './QueriesPanel'

/** Fuzzy subsequence match; ^ and $ anchor to start/end like most SQL clients. */
export function fuzzy(name: string, q: string, mode: 'fuzzy' | 'contains' = 'fuzzy'): boolean {
  if (!q) return true
  const n = name.toLowerCase()
  let s = q.toLowerCase()
  const start = s.startsWith('^')
  const end = s.endsWith('$')
  s = s.replace(/^\^|\$$/g, '')
  if (start && end) return n === s
  if (start) return n.startsWith(s)
  if (end) return n.endsWith(s)
  if (mode === 'contains') return n.includes(s)
  let i = 0
  for (const ch of n) if (ch === s[i]) i++
  return i === s.length
}

export function Sidebar(): ReactNode {
  const s = useWs()
  const [tab, setTab] = useState<'items' | 'queries' | 'history'>('items')
  const [q, setQ] = useState('')
  const [schemas, setSchemas] = useState<string[]>([])
  const [match] = useSetting<'fuzzy' | 'contains'>('sidebar.match', 'fuzzy')
  const [showCols, setShowCols] = useSetting('sidebar.showColumns', false)
  const [sysSchemas, setSysSchemas] = useSetting('table.showSystemSchemas', false)
  const [pins, setPins] = useSetting<string[]>(`pins.${s.conn?.id}`, [])
  const [open, setOpen] = useState<Record<string, boolean>>({ tables: true, functions: true, sequences: false })
  const [cols, setCols] = useState<Record<string, Column[]>>({})
  const [anchor, setAnchor] = useState<string | null>(null)
  const sql = !!s.dialect
  const isMongo = s.conn?.driver === 'mongodb'

  useEffect(() => {
    if (!sql || !s.sessionId) return
    void call<string[]>('db.schemas', s.sessionId, sysSchemas).then(setSchemas).catch(fail)
  }, [s.sessionId, s.database, sysSchemas])

  useCommands('sidebar', { 'edit.findSidebar': () => { setWs({ left: true }); setTimeout(() => document.getElementById('sidebar-search')?.focus()) } })

  const keyOf = (o: DbObject): string => `${o.schema}.${o.name}`
  const visible = useMemo(() => s.objects.filter((o) => fuzzy(o.name, q, match)), [s.objects, q, match])
  const sel = new Set(s.selectedObjects.map(keyOf))

  const openObj = (o: DbObject, preview: boolean, newTab = false): void => {
    if (o.kind === 'function' || o.kind === 'procedure' || o.kind === 'sequence') openTab({ kind: 'ddl', title: o.name, schema: o.schema, name: o.name, objKind: o.kind, preview }, { newTab })
    else if (o.kind === 'collection' || (isMongo && o.kind === 'view')) openTab({ kind: 'mongo', title: o.name, name: o.name, objKind: o.kind, preview }, { newTab })
    else openTab({ kind: 'table', title: o.name, schema: o.schema, name: o.name, objKind: o.kind, preview, view: 'data' }, { newTab })
  }

  const select = (o: DbObject, e: React.MouseEvent): void => {
    const list = visible
    if (e.shiftKey && anchor) {
      const a = list.findIndex((x) => keyOf(x) === anchor)
      const b = list.findIndex((x) => keyOf(x) === keyOf(o))
      setWs({ selectedObjects: list.slice(Math.min(a, b), Math.max(a, b) + 1) })
    } else if (e.metaKey || e.ctrlKey) {
      setWs({ selectedObjects: sel.has(keyOf(o)) ? s.selectedObjects.filter((x) => keyOf(x) !== keyOf(o)) : [...s.selectedObjects, o] })
      setAnchor(keyOf(o))
    } else {
      setWs({ selectedObjects: [o] })
      setAnchor(keyOf(o))
    }
  }

  const dropObjects = async (objs: DbObject[], ask = true): Promise<void> => {
    if (!objs.length) return
    if (isMongo) {
      if (ask && !(await confirmDialog(`Drop ${objs.length} collection(s)?`, objs.map((o) => o.name).join('\n'), { ok: 'Drop', danger: true }))) return
      if (!(await guard(objs.map((o) => `db.${o.name}.drop()`)))) return
      for (const o of objs) await call('mongo.dropCollection', s.sessionId, o.name).catch(fail)
    } else {
      const stmts = objs.map((o) => dropObjectSql(s.dialect!, o.kind, o.schema, o.name))
      if (ask && !(await confirmDialog(`Delete ${objs.length} item(s)?`, stmts.join('\n'), { ok: 'Delete', danger: true }))) return
      const r = await runSql(stmts, { stopOnError: true })
      const err = r?.find((x) => x.error)
      if (err) fail(err.error)
    }
    setWs({ selectedObjects: [] })
    void loadObjects()
  }

  const truncate = async (objs: DbObject[], ask = true): Promise<void> => {
    const tables = objs.filter((o) => o.kind === 'table' || o.kind === 'collection')
    if (!tables.length) return
    if (isMongo) {
      if (ask && !(await confirmDialog(`Empty ${tables.length} collection(s)?`, '', { ok: 'Empty', danger: true }))) return
      if (!(await guard(tables.map((o) => `db.${o.name}.deleteMany({})`)))) return
      for (const o of tables) await call('mongo.truncateCollection', s.sessionId, o.name).catch(fail)
      return
    }
    let cascade = false
    let restart = false
    if (ask) {
      const opts = s.dialect === 'postgres' ? await promptDialog(`Truncate ${tables.length} table(s)?`, '', { ok: 'Truncate', message: 'Options (optional): type "cascade", "restart" or both.' }) : (await confirmDialog(`Truncate ${tables.length} table(s)?`, tables.map((t) => t.name).join('\n'), { ok: 'Truncate', danger: true })) ? '' : null
      if (opts === null) return
      cascade = /cascade/i.test(opts)
      restart = /restart/i.test(opts)
    }
    const r = await runSql(tables.map((o) => truncateSql(s.dialect!, o.schema, o.name, { cascade, restartIdentity: restart })))
    const err = r?.find((x) => x.error)
    if (err) fail(err.error)
    else if (r) window.dispatchEvent(new CustomEvent('ws:reload'))
  }

  const copyScript = async (o: DbObject, what: 'create' | 'drop' | 'truncate' | 'select'): Promise<void> => {
    const d = s.dialect!
    const text = what === 'create' ? await call<string>('db.ddl', s.sessionId, o.schema, o.name, o.kind)
      : what === 'drop' ? dropObjectSql(d, o.kind, o.schema, o.name)
        : what === 'truncate' ? truncateSql(d, o.schema, o.name)
          : `SELECT * FROM ${qt(d, o.schema, o.name)} LIMIT 100;`
    await navigator.clipboard.writeText(text)
    toast('Copied to clipboard')
  }

  const itemMenu = (o: DbObject): MenuItem[] => {
    const many = sel.has(keyOf(o)) && s.selectedObjects.length > 1 ? s.selectedObjects : [o]
    const isTable = o.kind === 'table'
    const pinned = pins.includes(keyOf(o))
    return [
      { label: 'Open', onClick: () => openObj(o, false) },
      { label: 'Open in New Tab', onClick: () => openObj(o, false, true) },
      ...(sql && (isTable || o.kind === 'view' || o.kind === 'matview') ? [{ label: 'Open Structure', onClick: () => openTab({ kind: 'table', title: o.name, schema: o.schema, name: o.name, objKind: o.kind, view: 'structure' }) }] : []),
      ...(sql && isTable ? [{ label: 'Show Diagram', onClick: () => openTab({ kind: 'diagram', title: `Diagram · ${o.schema}`, schema: o.schema }) }] : []),
      { sep: true },
      { label: 'Copy Name', onClick: () => void navigator.clipboard.writeText(many.map((x) => x.name).join('\n')) },
      ...(sql ? [{ label: 'Copy Script As', submenu: [
        { label: 'CREATE', onClick: () => void copyScript(o, 'create') },
        { label: 'DROP', onClick: () => void copyScript(o, 'drop') },
        ...(isTable ? [{ label: 'TRUNCATE', onClick: () => void copyScript(o, 'truncate') }, { label: 'SELECT first 100', onClick: () => void copyScript(o, 'select') }] : [])
      ] }] : []),
      { label: pinned ? 'Unpin from Top' : 'Pin to Top', onClick: () => setPins(pinned ? pins.filter((p) => p !== keyOf(o)) : [...pins, keyOf(o)]) },
      ...(sql ? [
        { sep: true },
        { label: 'Export…', onClick: () => openTool({ kind: 'export', items: many }) },
        ...(isTable ? [{ label: 'Import', submenu: (['csv', 'json', 'sql'] as const).map((f) => ({ label: `From ${f.toUpperCase()}…`, onClick: () => openTool({ kind: 'import', format: f, table: o }) })) }] : [])
      ] : []),
      { sep: true },
      ...(sql && isTable ? [{ label: 'Clone…', onClick: async () => {
        const name = await promptDialog('Clone table', `${o.name}_clone`, { ok: 'Clone', message: 'New table name. Add " -empty" to copy the structure only.' })
        if (!name?.trim()) return
        const empty = / -empty$/.test(name)
        const r = await runSql(cloneTableSql(s.dialect!, o.schema, o.name, name.replace(/ -empty$/, '').trim(), !empty), { stopOnError: true })
        if (r?.some((x) => x.error)) fail(r.find((x) => x.error)!.error); else void loadObjects()
      } }] : []),
      ...(isTable || o.kind === 'collection' ? [{ label: 'Truncate…', onClick: () => void truncate(many) }] : []),
      { label: many.length > 1 ? `Delete ${many.length} Items…` : 'Delete…', danger: true, onClick: () => void dropObjects(many) },
      ...pluginMenuItems('sidebarItem', () => ({ table: { schema: o.schema, name: o.name, kind: o.kind }, sessionId: s.sessionId }))
    ]
  }

  const newMenu = (): MenuItem[] => isMongo
    ? [{ label: 'New Collection…', onClick: async () => { const n = await promptDialog('New collection'); if (n?.trim()) { await call('mongo.createCollection', s.sessionId, n.trim()).catch(fail); void loadObjects() } } }]
    : [
        { label: 'New Table', onClick: () => openTab({ kind: 'table', title: 'New table', schema: s.schema, name: '', isNew: true, view: 'structure' }, { newTab: true }) },
        { label: 'New View', onClick: () => openTab({ kind: 'ddl', title: 'New view', schema: s.schema, objKind: 'view', isNew: true }, { newTab: true }) },
        ...(s.dialect === 'postgres' ? [{ label: 'New Materialized View', onClick: () => openTab({ kind: 'ddl', title: 'New materialized view', schema: s.schema, objKind: 'matview', isNew: true }, { newTab: true }) }] : []),
        ...(s.dialect !== 'sqlite' ? [{ label: 'New Function / Procedure', onClick: () => openTab({ kind: 'ddl', title: 'New function', schema: s.schema, objKind: 'function', isNew: true }, { newTab: true }) }] : []),
        ...(s.dialect === 'postgres' ? [{ label: 'New Schema…', onClick: async () => { const n = await promptDialog('New schema'); if (n?.trim()) { const r = await runSql([`CREATE SCHEMA "${n.trim().replace(/"/g, '""')}"`]); if (r?.[0]?.error) fail(r[0].error); else setSchemas(await call('db.schemas', s.sessionId, sysSchemas)) } } }] : [])
      ]

  const toggleCols = async (o: DbObject): Promise<void> => {
    const k = keyOf(o)
    setOpen((x) => ({ ...x, [k]: !x[k] }))
    if (!cols[k]) setCols({ ...cols, [k]: await call<Column[]>('db.columns', s.sessionId, o.schema, o.name) })
  }

  const renderItem = (o: DbObject): ReactNode => {
    const k = keyOf(o)
    const active = s.tabs.find((t) => t.id === s.active)
    const isActive = active?.name === o.name && active?.schema === o.schema
    return (
      <div key={k}>
        <div
          className={`list-item ${sel.has(k) || isActive ? 'selected' : ''}`}
          role="treeitem"
          aria-selected={sel.has(k)}
          tabIndex={-1}
          title={`${o.schema ? o.schema + '.' : ''}${o.name}`}
          onClick={(e) => { select(o, e); if (!e.metaKey && !e.ctrlKey && !e.shiftKey) openObj(o, true) }}
          onDoubleClick={() => openObj(o, false)}
          onContextMenu={(e) => { if (!sel.has(k)) setWs({ selectedObjects: [o] }); menuAt(e, itemMenu(o)) }}
        >
          {showCols && sql && (o.kind === 'table' || o.kind === 'view') ? (
            <button className="btn ghost icon sm" style={{ width: 14 }} aria-label="Show columns" onClick={(e) => { e.stopPropagation(); void toggleCols(o) }}><Icon name={open[k] ? 'chevronDown' : 'chevronRight'} size={9} /></button>
          ) : null}
          <Icon name={kindIcon(o.kind)} size={13} className="faint" />
          <span className="ellipsis">{o.name}</span>
          {pins.includes(k) && <Icon name="pin" size={10} className="faint" />}
        </div>
        {open[k] && cols[k]?.map((c) => (
          <div key={c.name} className="list-item" style={{ paddingLeft: 40, fontSize: 'var(--fs-sm)' }}>
            {c.pk ? <Icon name="key" size={10} className="faint" /> : <span style={{ width: 10 }} />}
            <span className="ellipsis">{c.name}</span>
            <span className="count mono">{c.type}</span>
          </div>
        ))}
      </div>
    )
  }

  const section = (id: string, title: string, items: DbObject[]): ReactNode =>
    items.length > 0 && (
      <div key={id} role="group">
        <div className="section-title" onClick={() => setOpen((x) => ({ ...x, [id]: !x[id] }))}>
          <Icon name={open[id] !== false ? 'chevronDown' : 'chevronRight'} size={9} />{title}<span className="faint">{items.length}</span>
        </div>
        {open[id] !== false && items.map(renderItem)}
      </div>
    )

  if (s.sidebarSearch) return <SearchPanel onDone={() => setWs({ sidebarSearch: false })} />

  if (s.conn?.driver === 'redis') {
    return <div className="empty"><Icon name="key" size={28} /><div>Keys are listed in the Redis tab.</div><button className="btn" onClick={() => openTab({ kind: 'redis', title: `db${ws().database ?? 0}` })}>Open keys</button></div>
  }

  const pinned = visible.filter((o) => pins.includes(keyOf(o)))
  return (
    <div className="col grow" onFocusCapture={() => focusScope('sidebar')}>
      <div style={{ padding: 'var(--sp-4) var(--sp-4) var(--sp-3)' }} className="col">
        <div className="tabs" role="tablist" style={{ justifyContent: 'center', marginBottom: 'var(--sp-3)' }}>
          {(['items', 'queries', 'history'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'items' ? 'Items' : t === 'queries' ? 'Queries' : 'History'}</button>
          ))}
        </div>
        <div className="row">
          <input id="sidebar-search" className="input grow sm" placeholder={tab === 'items' ? 'Search items' : tab === 'queries' ? 'Search queries' : 'Search history'} aria-label="Search sidebar" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
          {tab === 'items' && sql && (
            <button className="btn ghost icon sm" aria-label="Sidebar options" title="Sidebar options" onClick={(e) => menuBelow(e.currentTarget, [
              { label: 'Search in Database…', onClick: () => setWs({ sidebarSearch: true }) },
              { sep: true },
              { label: 'Show columns', checked: showCols, onClick: () => setShowCols(!showCols) },
              { label: 'Load system schemas', checked: sysSchemas, onClick: () => setSysSchemas(!sysSchemas) },
              { label: 'Refresh', onClick: () => void loadObjects() }
            ])}><Icon name="more" size={12} /></button>
          )}
        </div>
      </div>
      <div
        className="grow"
        style={{ overflow: 'auto', padding: '0 var(--sp-3)' }}
        role="tree"
        tabIndex={0}
        onKeyDown={(e) => {
          if (tab !== 'items') return
          const cur = s.selectedObjects[0]
          if ((e.key === 'Backspace' || e.key === 'Delete') && s.selectedObjects.length) { e.preventDefault(); void (e.altKey ? truncate(s.selectedObjects) : dropObjects(s.selectedObjects)) }
          if (e.key === ' ' && cur) { e.preventDefault(); openObj(cur, false) }
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && visible.length) {
            e.preventDefault()
            const i = cur ? visible.findIndex((x) => keyOf(x) === keyOf(cur)) : -1
            const n = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
            setWs({ selectedObjects: [n] }); setAnchor(keyOf(n)); openObj(n, true)
          }
        }}
      >
        {tab === 'items' && (
          s.objectsLoading && !s.objects.length ? <div className="empty">Loading…</div>
            : !s.objects.length ? <div className="empty">{isMongo ? 'No collections' : 'No tables in this schema'}<button className="btn sm" onClick={(e) => menuBelow(e.currentTarget, newMenu())}>Create…</button></div>
              : !visible.length ? <div className="empty">No match for "{q}"</div>
                : <>
                    {pinned.length > 0 && section('pinned', 'Pinned', pinned)}
                    {section('tables', isMongo ? 'Collections' : 'Tables', visible.filter((o) => ['table', 'view', 'matview', 'collection'].includes(o.kind)))}
                    {section('functions', 'Functions', visible.filter((o) => o.kind === 'function' || o.kind === 'procedure'))}
                    {section('sequences', 'Sequences', visible.filter((o) => o.kind === 'sequence'))}
                  </>
        )}
        {tab === 'queries' && <QueriesPanel filter={q} />}
        {tab === 'history' && <HistoryPanel filter={q} />}
      </div>
      {tab === 'items' && (
        <div className="row" style={{ padding: 'var(--sp-3) var(--sp-4)', borderTop: '1px solid var(--border)' }}>
          <button className="btn ghost icon sm" aria-label="New item" title="New table, view, function…" onClick={(e) => menuBelow(e.currentTarget, newMenu())}><Icon name="plus" size={12} /></button>
          {sql && schemas.length > 0 && (
            <select className="select sm grow" aria-label="Schema" value={s.schema} onChange={(e) => { setWs({ schema: e.target.value, selectedObjects: [] }); void loadObjects() }}>
              {schemas.map((x) => <option key={x}>{x}</option>)}
            </select>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryPanel({ filter }: { filter: string }): ReactNode {
  const conn = useWs((s) => s.conn)
  const [list, setList] = useState<HistoryEntry[]>([])
  const [selId, setSelId] = useState<number | null>(null)
  const load = (): void => { if (conn) void call<HistoryEntry[]>('history.list', conn.id, filter).then(setList) }
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t) }, [conn?.id, filter])
  if (!list.length) return <div className="empty">{filter ? 'No match' : 'Queries you run appear here.'}</div>
  const menu = (h: HistoryEntry): MenuItem[] => [
    { label: 'Open in New Tab', onClick: () => newQueryTab(h.sql) },
    { label: 'Copy', onClick: () => void navigator.clipboard.writeText(h.sql) },
    { label: 'Save to Queries…', onClick: async () => { const n = await promptDialog('Save query as', ''); if (n?.trim()) { await call('queries.write', null, n.trim(), h.sql, []); toast('Saved to Queries') } } },
    { label: 'Save As File…', onClick: async () => { const p = await call<string | undefined>('dialog.save', { defaultPath: 'query.sql' }); if (p) await call('file.write', p, h.sql) } },
    { sep: true },
    { label: 'Delete', onClick: () => void call('history.delete', h.id).then(load) },
    { label: 'Clear All History…', danger: true, onClick: async () => { if (await confirmDialog('Clear all history for this connection?', undefined, { ok: 'Clear', danger: true })) { await call('history.clear', conn!.id); load() } } }
  ]
  return (
    <div
      tabIndex={0}
      onKeyDown={(e) => { if ((e.key === 'Backspace' || e.key === 'Delete') && selId !== null) void call('history.delete', selId).then(load) }}
    >
      {list.map((h) => (
        <div key={h.id} className={`list-item ${selId === h.id ? 'selected' : ''}`} style={{ height: 'auto', padding: 'var(--sp-3) var(--sp-4)', alignItems: 'flex-start', flexDirection: 'column', gap: 2 }} onClick={() => setSelId(h.id)} onDoubleClick={() => newQueryTab(h.sql)} onContextMenu={(e) => { setSelId(h.id); menuAt(e, menu(h)) }} title={h.sql}>
          <span className="mono ellipsis" style={{ width: '100%', fontSize: 'var(--fs-xs)', color: h.error ? 'var(--danger)' : undefined }}>{h.sql.replace(/\s+/g, ' ').slice(0, 200)}</span>
          <span className="faint" style={{ fontSize: 10 }}>{new Date(h.executedAt).toLocaleString()} · {h.source}{h.durationMs != null ? ` · ${h.durationMs} ms` : ''}</span>
        </div>
      ))}
    </div>
  )
}
