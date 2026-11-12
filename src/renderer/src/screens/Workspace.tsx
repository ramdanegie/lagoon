import { type ReactNode, lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Connection, ServerInfo, Tag } from '@shared/types'
import { DRIVERS, SAFE_MODES } from '@shared/types'
import { call, fail, focusScope, isMac, on, setting, tip, toast, useCommands } from '../lib/api'
import { useWs, setWs, ws, scopes, useFocus, loadObjects, closeTab, newQueryTab, openTab, updateTab, ScopeContext, useScopes, openScope, scopeOfSession, setScope, closeConnection, updateConnInScopes, type Tab } from '../lib/ws'
import { newConnection } from './Navigator'
import { startTour } from '../components/Tour'
import { Icon } from '../components/Icon'
import { Resizer, confirmDialog, menuAt, menuBelow, promptDialog } from '../components/ui'
import { Sidebar } from './Sidebar'
import { TableView } from './TableView'
import { SafeModeHost, PreviewModal } from './SafeMode'
import { Palette, DatabasePicker, ConnectionPicker } from './Palette'
import { ConnectionForm } from './ConnectionForm'
import { Tools } from './Tools'

const QueryEditor = lazy(() => import('./QueryEditor').then((m) => ({ default: m.QueryEditor })))
const DdlTab = lazy(() => import('./DdlTab').then((m) => ({ default: m.DdlTab })))
const RedisBrowser = lazy(() => import('./RedisBrowser').then((m) => ({ default: m.RedisBrowser })))
const MongoView = lazy(() => import('./MongoView').then((m) => ({ default: m.MongoView })))
const MetricsBoard = lazy(() => import('./MetricsBoard').then((m) => ({ default: m.MetricsBoard })))
const Diagram = lazy(() => import('./Diagram').then((m) => ({ default: m.Diagram })))
const UserManagement = lazy(() => import('./UserManagement').then((m) => ({ default: m.UserManagement })))
const TablesOverview = lazy(() => import('./TablesOverview').then((m) => ({ default: m.TablesOverview })))
const RedisLive = lazy(() => import('./RedisLive').then((m) => ({ default: m.RedisLive })))

const BackupDialog = lazy(() => import('./Backup').then((m) => ({ default: m.BackupDialog })))
const RestoreDialog = lazy(() => import('./Backup').then((m) => ({ default: m.RestoreDialog })))
import appIcon from '../assets/icon.png'

async function resolveConnection(connectionId?: string, file?: string): Promise<Connection> {
  if (connectionId) return call<Connection>('conn.get', connectionId)
  const all = await call<Connection[]>('conn.list')
  const found = all.find((c) => c.driver === 'sqlite' && c.filePath === file)
  return found ?? call<Connection>('conn.save', { id: '', name: file!.split(/[\\/]/).pop(), driver: 'sqlite', filePath: file, passwordMode: 'none', safeMode: 0 })
}

export function Workspace({ connectionId, file }: { connectionId?: string; file?: string }): ReactNode {
  const s = useWs()
  const scopesMap = useScopes()
  const [overlay, setOverlay] = useState<'palette' | 'db' | 'conn' | 'preview' | 'edit' | 'backup' | 'restore' | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [allConns, setAllConns] = useState<Connection[]>([])
  useEffect(() => { if (overlay === 'backup' || overlay === 'restore') void call<Connection[]>('conn.list').then(setAllConns) }, [overlay])
  const [widths, setWidths] = useState({ left: 260, right: 300, console: 160 })
  const consoleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void call<Tag[]>('tag.list').then(setTags)
    const offLog = on('console:log', (e: { at: string; sql: string; session?: string }) => useWs.setState((st) => ({ console: [...st.console.slice(-999), e] })))
    const offLost = on('session:lost', (id: string) => { const sc = scopeOfSession(id); if (sc) setScope(sc.id, { lost: true }) })
    // opened for a specific connection or a .sqlite file (command line, Finder, connection switcher)
    if (connectionId || file) {
      void resolveConnection(connectionId, file).then((c) => { window.dispatchEvent(new CustomEvent('connections:changed')); return openScope(c, { ask: (t) => promptDialog(t, '', { password: true, ok: 'Connect' }) }) }).catch(fail)
    }
    // files from Finder / Open With / the command line, including ones that arrived before this window loaded
    const take = (): void => void call<string[]>('app.takeFiles').then(openFiles)
    take()
    const offFiles = on('files:incoming', take)
    return () => { offLog(); offLost(); offFiles() }
  }, [])
  const focus = useFocus()
  useEffect(() => { void openWaitingSql() }, [focus])

  useEffect(() => { consoleRef.current?.scrollTo(0, consoleRef.current.scrollHeight) }, [s.console.length, s.showConsole])
  useEffect(() => { document.querySelectorAll('.tab.active').forEach((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' })) }, [s.active, s.tabs.length])

  const activeTab = s.tabs.find((t) => t.id === s.active)
  const activeApi = s.active ? s.tabApis[s.active] : undefined
  const pending = activeApi?.pendingCount() ?? 0
  const tag = tags.find((t) => t.id === s.conn?.tagId)

  const commitActive = async (): Promise<boolean> => {
    const api = ws().active ? ws().tabApis[ws().active!] : undefined
    if (!api || !api.pendingCount()) return false
    return api.commit()
  }

  const reloadWorkspace = async (): Promise<void> => {
    await loadObjects()
    window.dispatchEvent(new CustomEvent('ws:reload'))
  }

  const setSafeMode = async (level: number): Promise<void> => {
    const cur = ws().conn!.safeMode
    if (cur >= 3 && level < cur) {
      const pw = await promptDialog('Leaving safe mode', '', { password: true, message: 'Enter the database password to lower the safe mode level.' })
      if (pw === null || !(await call<boolean>('session.checkPassword', ws().sessionId, pw))) { if (pw !== null) toast('Wrong password', 'error'); return }
    }
    const conn = await call<Connection>('conn.patch', ws().conn!.id, { safeMode: level })
    updateConnInScopes(conn)
  }

  useCommands('workspace', {
    'edit.commit': () => { void commitActive(); return true },
    'edit.preview': () => { if (activeApi) setOverlay('preview') },
    'edit.discard': () => activeApi?.discard(),
    'nav.openAnything': () => setOverlay('palette'),
    'conn.openDatabase': () => setOverlay('db'),
    'conn.openConnection': () => setOverlay('conn'),
    'conn.edit': () => setOverlay('edit'),
    'conn.new': () => newConnection(),
    'file.open': () => void pickFiles(),
    'file.backup': () => setOverlay('backup'),
    'file.restore': () => setOverlay('restore'),
    'nav.newQuery': () => void newQueryTab(),
    'nav.newTab': () => { if (setting('general.cmdTOpens', 'query') === 'empty') openTab({ kind: 'empty', title: 'New tab' }, { newTab: true }); else newQueryTab() },
    'file.closeTab': () => { if (s.active) void closeWithGuard(s.active) },
    'view.left': () => setWs({ left: !ws().left }),
    'view.right': () => setWs({ right: !ws().right }),
    'view.console': () => setWs({ showConsole: !ws().showConsole }),
    'conn.reloadWorkspace': () => void reloadWorkspace(),
    'conn.reloadTab': () => window.dispatchEvent(new CustomEvent('ws:reload')),
    'conn.reconnect': () => void reconnect(),
    'conn.disconnect': () => { const c = ws().conn; if (c) void closeConnection(c.id) },
    'nav.nextTab': () => cycleTab(1),
    'nav.prevTab': () => cycleTab(-1),
    'nav.splitRight': () => setWs({ split: !ws().split, activePane: ws().split ? 0 : 1 }),
    'nav.nextPane': () => setWs({ activePane: ws().activePane === 0 && ws().split ? 1 : 0 }),
    'nav.prevPane': () => setWs({ activePane: ws().activePane === 0 && ws().split ? 1 : 0 }),
    'query.runCurrent': () => { if (!activeTab || activeTab.kind !== 'query') { if (ws().dialect) newQueryTab(); return true } return false },
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`nav.tab${i + 1}`, () => { const t = paneTabs(ws().activePane)[i === 8 ? paneTabs(ws().activePane).length - 1 : i]; if (t) setWs({ active: t.id }) }]))
  })

  const paneTabs = (pane: number): Tab[] => ws().tabs.filter((t) => (t.pane ?? 0) === pane)
  const cycleTab = (d: number): void => {
    const list = paneTabs(ws().activePane)
    const i = list.findIndex((t) => t.id === ws().active)
    if (list.length) setWs({ active: list[(i + d + list.length) % list.length].id })
  }

  const reconnect = async (): Promise<void> => {
    try {
      const info = await call<ServerInfo>('session.reconnect', ws().sessionId)
      setWs({ info, lost: false })
      toast('Reconnected', 'success')
    } catch (e) { fail(e) }
  }

  const closeWithGuard = async (id: string): Promise<void> => {
    const api = ws().tabApis[id]
    if (api && api.pendingCount() > 0 && !(await confirmDialog('Discard pending changes?', `This tab has ${api.pendingCount()} uncommitted change(s).`, { ok: 'Discard', danger: true }))) return
    closeTab(id)
  }

  const tabMenu = (t: Tab): Parameters<typeof menuAt>[1] => [
    { label: 'New Tab', onClick: () => newQueryTab() },
    { label: 'Rename Tab…', onClick: async () => { const n = await promptDialog('Rename tab', t.title); if (n?.trim()) updateTab(t.id, { title: n.trim() }) } },
    { label: 'Keep Open', disabled: !t.preview, onClick: () => updateTab(t.id, { preview: false }) },
    { label: 'Move to Other Pane', onClick: () => { updateTab(t.id, { pane: (t.pane ?? 0) === 0 ? 1 : 0 }); setWs({ split: true }) } },
    { sep: true },
    { label: 'Close Tab', onClick: () => void closeWithGuard(t.id) },
    { label: 'Close Other Tabs', onClick: () => ws().tabs.filter((x) => x.id !== t.id && !(ws().tabApis[x.id]?.pendingCount() > 0)).forEach((x) => closeTab(x.id)) },
    { label: 'Close Tabs to the Right', onClick: () => ws().tabs.slice(ws().tabs.findIndex((x) => x.id === t.id) + 1).filter((x) => !(ws().tabApis[x.id]?.pendingCount() > 0)).forEach((x) => closeTab(x.id)) },
    { label: 'Close All Tabs', onClick: () => ws().tabs.filter((x) => !(ws().tabApis[x.id]?.pendingCount() > 0)).forEach((x) => closeTab(x.id)) }
  ]

  const drv = DRIVERS.find((d) => d.id === s.conn?.driver)
  const renderTab = (t: Tab): ReactNode => {
    switch (t.kind) {
      case 'table': return <TableView key={t.id} tab={t} />
      case 'query': return <Suspense fallback={null}><QueryEditor key={t.id} tab={t} /></Suspense>
      case 'ddl': return <Suspense fallback={null}><DdlTab key={t.id} tab={t} /></Suspense>
      case 'redis': return <Suspense fallback={null}><RedisBrowser key={t.id} tab={t} /></Suspense>
      case 'mongo': return <Suspense fallback={null}><MongoView key={t.id} tab={t} /></Suspense>
      case 'metrics': return <Suspense fallback={null}><MetricsBoard key={t.id} tab={t} /></Suspense>
      case 'diagram': return <Suspense fallback={null}><Diagram key={t.id} tab={t} /></Suspense>
      case 'users': return <Suspense fallback={null}><UserManagement key={t.id} tab={t} /></Suspense>
      case 'tables': return <Suspense fallback={null}><TablesOverview key={t.id} tab={t} /></Suspense>
      case 'redisLive': return <Suspense fallback={null}><RedisLive key={t.id} tab={t} /></Suspense>
      default: return <div className="empty">Empty tab</div>
    }
  }

  const multiScope = Object.keys(scopesMap).length > 1
  const scopeTitle = (t: Tab): string => {
    const sc = t.scope ? scopesMap[t.scope] : undefined
    return sc ? `${t.title}\n${sc.conn.name} · ${sc.database ?? ''}${t.schema ? ' · ' + t.schema : ''}` : t.title
  }

  const pane = (n: 0 | 1): ReactNode => {
    const list = s.tabs.filter((t) => (t.pane ?? 0) === n)
    const activeInPane = list.find((t) => t.id === s.active) ?? list.find((t) => t.id === (n === s.activePane ? s.active : undefined)) ?? list[list.length - 1]
    return (
      <div className="main-area" onMouseDown={() => { if (s.activePane !== n) setWs({ activePane: n, active: activeInPane?.id ?? s.active }) }} style={{ outline: s.split && s.activePane === n ? '1px solid var(--accent)' : undefined, outlineOffset: -1 }}>
        <div className="tabbar" role="tablist" data-tour={n === 0 ? 'tabs' : undefined} onWheel={(e) => { if (!e.deltaX) e.currentTarget.scrollLeft += e.deltaY }}>
          {list.map((t) => {
            const dirty = (s.tabApis[t.id]?.pendingCount() ?? 0) > 0
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={activeInPane?.id === t.id}
                className={`tab ${activeInPane?.id === t.id ? 'active' : ''} ${t.preview ? 'preview' : ''}`}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void closeWithGuard(t.id) } else setWs({ active: t.id, activePane: n }) }}
                onDoubleClick={() => updateTab(t.id, { preview: false })}
                onContextMenu={(e) => menuAt(e, tabMenu(t))}
                title={scopeTitle(t)}
              >
                <Icon name={t.kind === 'query' ? 'sql' : t.kind === 'tables' ? 'db' : t.kind === 'table' ? (t.objKind === 'view' ? 'view' : 'table') : t.kind === 'redis' ? 'key' : t.kind === 'redisLive' ? 'console' : t.kind === 'mongo' ? 'collection' : t.kind === 'metrics' ? 'chart' : t.kind === 'diagram' ? 'diagram' : t.kind === 'users' ? 'user' : 'function'} size={12} />
                <span className="title ellipsis">{t.title}</span>
                {multiScope && t.scope && scopesMap[t.scope] && <span className="scope-label">{scopesMap[t.scope].database || scopesMap[t.scope].conn.name}</span>}
                {dirty && <span className="dirty" aria-label="Unsaved changes" />}
                <button className="close" aria-label={`Close ${t.title}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeWithGuard(t.id)}><Icon name="x" size={10} /></button>
              </div>
            )
          })}
          <button className="btn ghost icon" style={{ margin: 3 }} title={tip('New SQL query', 'nav.newQuery')} aria-label="New SQL query" onClick={() => { setWs({ activePane: n }); newQueryTab() }}><Icon name="plus" size={12} /></button>
        </div>
        <div className="content">
          {list.length === 0 && !Object.keys(scopesMap).length ? (
            <div className="hero">
              <img src={appIcon} alt="" width={112} height={112} draggable={false} />
              <div className="hero-title">Lagoon</div>
              <div className="muted">A calm place for your databases</div>
              <div className="hero-actions">
                <button className="btn primary" onClick={newConnection}><Icon name="plus" /> Create connection</button>
                <button className="btn" onClick={() => void openSqliteFile()}><Icon name="file" /> Open SQLite file…</button>
                <button className="btn" onClick={() => setOverlay('backup')}><Icon name="download" /> Backup database</button>
                <button className="btn" onClick={() => setOverlay('restore')}><Icon name="upload" /> Restore database</button>
              </div>
              <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>Double-click a connection in the sidebar to open it.</div>
              <button className="btn ghost sm" onClick={startTour}><Icon name="star" size={12} /> Take the feature tour</button>
            </div>
          ) : list.length === 0 ? (
            <div className="empty" style={{ alignContent: 'center', height: '100%' }}>
              <Icon name={drv?.dialect ? 'table' : 'db'} size={32} />
              <div>Open an item from the sidebar, or</div>
              <div className="row"><button className="btn" onClick={() => setOverlay('palette')}>Open anything <span className="kbd">{tip('', 'nav.openAnything').replace(/[()]/g, '')}</span></button>{drv?.dialect && <button className="btn" onClick={() => newQueryTab()}>New SQL query</button>}</div>
            </div>
          ) : (
            list.map((t) => (
              <ScopeContext.Provider key={t.id} value={t.scope}>
                <div style={{ display: activeInPane?.id === t.id ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
                  {t.scope && !scopesMap[t.scope] ? <div className="empty">This database was closed. Open it again from the sidebar.</div> : renderTab(t)}
                </div>
              </ScopeContext.Provider>
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="ws" onFocusCapture={() => focusScope('workspace')}>
      <div className={`toolbar drag ${isMac ? 'mac' : ''}`} role="toolbar" aria-label="Workspace">
        <div className="row nodrag">
          <button className={`btn icon ghost ${s.left ? 'on' : ''}`} title={tip('Left sidebar', 'view.left')} aria-label="Toggle left sidebar" onClick={() => setWs({ left: !s.left })}><Icon name="sidebarLeft" /></button>
          <button className="btn icon ghost" title={tip('Switch connection', 'conn.openConnection')} aria-label="Switch connection" onClick={() => setOverlay('conn')}><Icon name="plug" /></button>
          <div className="seg" role="group" aria-label="Pending changes" data-tour="pending">
            <button disabled={!pending} title={tip('Discard changes', 'edit.discard')} onClick={() => activeApi?.discard()}><Icon name="x" size={12} /></button>
            <button disabled={!pending} title={tip('Preview SQL', 'edit.preview')} onClick={() => setOverlay('preview')}><Icon name="eye" size={12} />{pending ? <span style={{ fontSize: 'var(--fs-xs)' }}>{pending}</span> : null}</button>
            <button disabled={!pending} title={tip('Commit changes', 'edit.commit')} onClick={() => void commitActive()}><Icon name="check" size={12} /></button>
          </div>
          <button
            className="btn icon ghost"
            data-tour="safe"
            title={`Safe mode: ${SAFE_MODES[s.conn?.safeMode ?? 0]}`}
            aria-label="Safe mode"
            style={{ color: (s.conn?.safeMode ?? 0) > 0 ? 'var(--warning)' : undefined }}
            onClick={(e) => menuBelow(e.currentTarget, SAFE_MODES.map((m, i) => ({ label: `${m}${['', ' · confirm every query', ' · confirm writes', ' · password for every query', ' · password for writes'][i]}`, checked: s.conn?.safeMode === i, onClick: () => void setSafeMode(i) })))}
          >
            <Icon name={(s.conn?.safeMode ?? 0) > 0 ? 'lock' : 'unlock'} />
          </button>
          {drv?.dialect && <button className="btn icon ghost" title={tip('Open database', 'conn.openDatabase')} aria-label="Open database" onClick={() => setOverlay('db')}><Icon name="db" /></button>}
          {(!drv || drv.id !== 'redis') && <button className="btn icon ghost" data-tour="new-query" title={tip('New SQL query', 'nav.newQuery')} aria-label="New query" disabled={!drv} onClick={() => newQueryTab()}><Icon name="sql" /></button>}
        </div>
        <div
          className="status-bar nodrag"
          role="button"
          tabIndex={0}
          style={{ background: s.conn?.statusColor ? `color-mix(in srgb, ${s.conn.statusColor} 22%, var(--bg-input))` : undefined, borderColor: s.conn?.statusColor }}
          onClick={(e) => (!s.conn ? newConnection() : s.lost ? void reconnect() : menuBelow(e.currentTarget, [
            { header: `${drv?.name} ${s.info?.version ?? ''}` },
            { label: s.conn?.driver === 'sqlite' ? s.conn.filePath : `${s.conn?.username ?? ''}@${s.conn?.host}:${s.conn?.port ?? ''}`, disabled: true },
            { sep: true },
            { label: 'Edit connection…', onClick: () => setOverlay('edit') },
            { label: 'Reconnect', onClick: () => void reconnect() },
            { label: 'Disconnect', onClick: () => { if (s.conn) void closeConnection(s.conn.id) } }
          ]))}
          title={!s.conn ? 'No connection selected' : s.lost ? 'Connection lost. Click to reconnect.' : 'Connection details'}
        >
          {!s.conn && <span className="muted">No connection selected</span>}
          {tag && <span className="badge" style={{ background: tag.color }}>{tag.name}</span>}
          {s.conn && <span className="ellipsis" style={{ fontWeight: 500 }}>{s.conn.name}</span>}
          {s.conn && <span className="faint">·</span>}
          <span className="ellipsis muted">{s.conn?.driver === 'redis' ? `db${s.database ?? 0}` : s.database}{s.schema && s.dialect === 'postgres' ? ` · ${s.schema}` : ''}</span>
          {s.lost && <span className="danger-text" style={{ marginLeft: 'auto' }}>Disconnected · click to reconnect</span>}
          {s.busy > 0 && <span className="progress" aria-label="Running" />}
        </div>
        <div className="row nodrag">
          <Tools />
          <button className="btn icon ghost" title={tip('Reload', 'conn.reloadWorkspace')} aria-label="Reload" onClick={() => void reloadWorkspace()}><Icon name="refresh" /></button>
          {drv?.dialect && <button className="btn icon ghost" title="Metrics board" aria-label="Metrics board" onClick={() => openTab({ kind: 'metrics', title: 'Metrics' })}><Icon name="chart" /></button>}
          <button className="btn icon ghost" data-tour="palette" title={tip('Open anything', 'nav.openAnything')} aria-label="Open anything" onClick={() => setOverlay('palette')}><Icon name="search" /></button>
          <div className="seg" role="group" aria-label="Panels" data-tour="panels">
            <button className={s.showConsole ? 'on' : ''} title={tip('Console log', 'view.console')} aria-label="Toggle console" onClick={() => setWs({ showConsole: !s.showConsole })}><Icon name="console" size={13} /></button>
            <button className={s.right ? 'on' : ''} title="Row details (Space)" aria-label="Toggle right sidebar" onClick={() => setWs({ right: !s.right })}><Icon name="sidebarRight" size={13} /></button>
          </div>
        </div>
      </div>
      <div className="ws-body">
        {s.left && (
          <>
            <div className="sidebar" style={{ width: widths.left }}><Sidebar /></div>
            <Resizer onDrag={(d) => setWidths((w) => ({ ...w, left: Math.max(160, Math.min(520, w.left + d)) }))} />
          </>
        )}
        <div className="col grow">
          <div className="row grow" style={{ alignItems: 'stretch', gap: 0 }}>
            {pane(0)}
            {s.split && <><div style={{ width: 1, background: 'var(--border)' }} />{pane(1)}</>}
          </div>
          {s.showConsole && (
            <>
              <Resizer vertical onDrag={(d) => setWidths((w) => ({ ...w, console: Math.max(60, Math.min(600, w.console - d)) }))} />
              <div className="row" style={{ height: 24, padding: '0 var(--sp-4)', borderTop: '1px solid var(--border)', background: 'var(--bg-elev)', fontSize: 'var(--fs-xs)' }}>
                <span className="muted">Console · {s.console.length} statements</span>
                <span className="grow" />
                <button className="btn sm ghost" onClick={() => setWs({ console: [] })}>Clear</button>
              </div>
              <div className="console" ref={consoleRef} style={{ height: widths.console }} aria-label="Console log">
                {s.console.map((c, i) => <div key={i}><span className="time">{c.at.slice(11, 23)}</span>{c.sql}</div>)}
              </div>
            </>
          )}
        </div>
      </div>
      {overlay === 'palette' && <Palette onClose={() => setOverlay(null)} />}
      {overlay === 'db' && <DatabasePicker onClose={() => setOverlay(null)} />}
      {overlay === 'conn' && <ConnectionPicker onClose={() => setOverlay(null)} />}
      {overlay === 'edit' && s.conn && <ConnectionForm initial={s.conn} onClose={() => setOverlay(null)} onSaved={(c) => { setOverlay(null); updateConnInScopes(c); window.dispatchEvent(new CustomEvent('connections:changed')); toast('Saved. Reconnect to apply host or credential changes.') }} />}
      <Suspense fallback={null}>
        {overlay === 'backup' && <BackupDialog connections={allConns} onClose={() => setOverlay(null)} />}
        {overlay === 'restore' && <RestoreDialog connections={allConns} onClose={() => setOverlay(null)} />}
      </Suspense>
      {overlay === 'preview' && activeApi && <PreviewModal sql={activeApi.previewSql()} onClose={() => setOverlay(null)} onCommit={() => void commitActive()} onDiscard={() => activeApi.discard()} />}
      <SafeModeHost />
    </div>
  )
}

async function openSqlite(f: string): Promise<void> {
  try {
    const c = await resolveConnection(undefined, f)
    window.dispatchEvent(new CustomEvent('connections:changed'))
    await openScope(c)
  } catch (e) { fail(e) }
}

async function openSqliteFile(): Promise<void> {
  const [f] = await call<string[]>('dialog.open', { properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] }, { name: 'All files', extensions: ['*'] }] })
  if (f) await openSqlite(f)
}

const SQLITE = /\.(sqlite3?|db3?)$/i
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const sqlWaiting: string[] = [] // .sql files that arrived while no SQL database was open

/** SQLite files connect; anything else opens as SQL text in a query tab of the current database. */
async function openFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (SQLITE.test(p)) await openSqlite(p)
    else if (!sqlWaiting.includes(p)) sqlWaiting.push(p)
  }
  await openWaitingSql()
}

async function openWaitingSql(): Promise<void> {
  if (!sqlWaiting.length) return
  const id = ws().scopeId
  if (!id || !scopes()[id]?.dialect) { toast(`Double-click a database connection to open ${sqlWaiting.map(baseName).join(', ')} in it.`); return }
  for (const p of sqlWaiting.splice(0)) {
    const open = ws().tabs.find((t) => t.diskPath === p)
    if (open) { setWs({ active: open.id }); continue }
    try {
      openTab({ kind: 'query', title: baseName(p), content: await call<string>('file.read', p), diskPath: p }, { newTab: true })
    } catch (e) { fail(e) }
  }
}

async function pickFiles(): Promise<void> {
  const files = await call<string[]>('dialog.open', { properties: ['openFile', 'multiSelections'], filters: [{ name: 'SQL and SQLite files', extensions: ['sql', 'sqlite', 'sqlite3', 'db', 'db3'] }, { name: 'All files', extensions: ['*'] }] })
  if (files.length) await openFiles(files)
}
