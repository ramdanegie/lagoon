// Window state. One window holds many *scopes* (an open connection + database, each with its own session) and
// one tab strip whose tabs each belong to a scope. `useWs()` merges window state with a scope:
//   - inside a tab (ScopeContext provider) → that tab's scope, so hidden tabs keep their own database
//   - elsewhere → the focused scope (last tab activated or tree node clicked)
// `ws()` / `setWs()` (non-hook) use the focused scope; actions run from the tab or node the user just touched.
import { createContext, useContext } from 'react'
import { create } from 'zustand'
import type { Connection, DbObject, Dialect, Result, ServerInfo, ObjectKind } from '@shared/types'
import { dialectOf } from '@shared/types'
import { isReadOnly } from '@shared/split'
import { call, toast, uid } from './api'

export type TabKind = 'table' | 'tables' | 'query' | 'ddl' | 'redis' | 'mongo' | 'metrics' | 'diagram' | 'users' | 'empty'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  scope?: string
  schema?: string
  name?: string
  objKind?: ObjectKind
  preview?: boolean // replaced by the next object opened (single click)
  view?: 'data' | 'structure' | 'index'
  initialFilter?: { column: string; op: string; value: string }
  content?: string // query text
  filePath?: string // a saved query (queries folder)
  diskPath?: string // any other .sql file opened from disk
  pane?: 0 | 1
  isNew?: boolean
}

/** What a tab exposes to the toolbar (Discard / Preview / Commit) and the window close guard. */
export interface TabApi {
  pendingCount: () => number
  previewSql: () => string[]
  commit: () => Promise<boolean>
  discard: () => void
}

export interface ConsoleEntry { at: string; sql: string; session?: string }

export interface Scope {
  id: string
  conn: Connection
  sessionId?: string
  info?: ServerInfo
  dialect?: Dialect
  database?: string
  schema?: string
  objects: DbObject[]
  objectsLoading: boolean
  selectedObjects: DbObject[]
  lost: boolean
  busy: number
}

interface Raw {
  scopes: Record<string, Scope>
  focus?: string
  tabs: Tab[]
  active?: string
  activePane: 0 | 1
  split: boolean
  console: ConsoleEntry[]
  left: boolean
  right: boolean
  showConsole: boolean
  tabApis: Record<string, TabApi>
  pendingVersion: number
  sidebarSearch: boolean
}

type ScopeFields = Omit<Scope, 'id' | 'conn'> & { conn?: Connection }
export type WsState = Omit<Raw, 'focus'> & Partial<ScopeFields> & { objects: DbObject[]; objectsLoading: boolean; selectedObjects: DbObject[]; lost: boolean; busy: number; scopeId?: string }

const SCOPE_KEYS = new Set(['conn', 'sessionId', 'info', 'dialect', 'database', 'schema', 'objects', 'objectsLoading', 'selectedObjects', 'lost', 'busy'])

const raw = create<Raw>(() => ({
  scopes: {}, tabs: [], console: [], left: true, right: false, showConsole: false, tabApis: {}, pendingVersion: 0, activePane: 0, split: false, sidebarSearch: false
}))

// merged views are cached per raw state object so selectors return stable references
const cache = new WeakMap<Raw, Map<string, WsState>>()
function view(r: Raw, scopeId?: string): WsState {
  const key = scopeId ?? r.focus ?? ''
  let m = cache.get(r)
  if (!m) { m = new Map(); cache.set(r, m) }
  let v = m.get(key)
  if (!v) {
    const sc = r.scopes[key]
    const { focus: _f, ...rest } = r
    void _f
    v = { ...rest, objects: [], objectsLoading: false, selectedObjects: [], lost: false, busy: 0, ...(sc ? { ...sc, scopeId: sc.id } : {}) } as WsState
    m.set(key, v)
  }
  return v
}

/** Apply a patch: scope fields go to `scopeId` (default: focused scope), the rest to the window. */
function apply(r: Raw, patch: Partial<WsState> & { focus?: string }, scopeId?: string): Partial<Raw> {
  const out: Partial<Raw> = {}
  const sp: Partial<Scope> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (SCOPE_KEYS.has(k)) (sp as Record<string, unknown>)[k] = v
    else if (k !== 'scopeId') (out as Record<string, unknown>)[k] = v
  }
  const target = scopeId ?? r.focus
  if (Object.keys(sp).length && target && r.scopes[target]) out.scopes = { ...r.scopes, [target]: { ...r.scopes[target], ...sp } }
  // activating a tab focuses its scope
  if (out.active && out.focus === undefined) {
    const t = (out.tabs ?? r.tabs).find((x) => x.id === out.active)
    if (t?.scope && r.scopes[t.scope]) out.focus = t.scope
  }
  return out
}

export const ScopeContext = createContext<string | undefined>(undefined)

type Sel<T> = (s: WsState) => T
interface UseWs {
  (): WsState
  <T>(sel: Sel<T>): T
  getState: () => WsState
  setState: (p: Partial<WsState> | ((s: WsState) => Partial<WsState>)) => void
}
export const useWs = ((sel?: Sel<unknown>) => {
  const scopeId = useContext(ScopeContext)
  return raw((r) => (sel ? sel(view(r, scopeId)) : view(r, scopeId)))
}) as UseWs
useWs.getState = () => view(raw.getState())
useWs.setState = (p) => raw.setState((r) => apply(r, typeof p === 'function' ? p(view(r)) : p))

export const ws = (): WsState => useWs.getState()
export const setWs = (p: Partial<WsState>): void => useWs.setState(p)
export const scopes = (): Record<string, Scope> => raw.getState().scopes
export const useScopes = (): Record<string, Scope> => raw((r) => r.scopes)
export const useFocus = (): string | undefined => raw((r) => r.focus)
export const focusOn = (scopeId: string | undefined, schema?: string): void =>
  raw.setState((r) => ({ focus: scopeId, ...(scopeId && schema !== undefined && r.scopes[scopeId] ? { scopes: { ...r.scopes, [scopeId]: { ...r.scopes[scopeId], schema } } } : {}) }))
export const setScope = (scopeId: string, patch: Partial<Scope>): void => raw.setState((r) => (r.scopes[scopeId] ? { scopes: { ...r.scopes, [scopeId]: { ...r.scopes[scopeId], ...patch } } } : {}))

export function bumpPending(): void { raw.setState((s) => ({ pendingVersion: s.pendingVersion + 1 })) }
export function registerTabApi(id: string, api: TabApi | null): void {
  raw.setState((s) => {
    const next = { ...s.tabApis }
    if (api) next[id] = api
    else delete next[id]
    return { tabApis: next }
  })
}

export const objectKey = (schema: string | undefined, name: string): string => `${ws().database ?? ''}.${schema ?? ''}.${name}`

export async function loadObjects(scopeId = raw.getState().focus): Promise<void> {
  const sc = scopeId ? scopes()[scopeId] : undefined
  if (!sc?.sessionId) return
  setScope(sc.id, { objectsLoading: true })
  try {
    if (sc.conn.driver === 'mongodb') {
      const c = await call<{ name: string; type: string }[]>('mongo.collections', sc.sessionId)
      setScope(sc.id, { objects: c.map((x) => ({ schema: '', name: x.name, kind: x.type === 'view' ? 'view' : 'collection' })) })
    } else if (sc.conn.driver === 'redis') setScope(sc.id, { objects: [] })
    else if (sc.schema !== undefined) setScope(sc.id, { objects: await call<DbObject[]>('db.objects', sc.sessionId, sc.schema) })
  } finally {
    setScope(sc.id, { objectsLoading: false })
  }
  window.dispatchEvent(new CustomEvent('ws:objects', { detail: sc.id }))
}

// ---------- scopes ----------
export const scopeIdOf = (connId: string, database?: string): string => `${connId}::${database ?? ''}`
const askedPw = new Map<string, { password?: string; sshPassword?: string }>()

export interface OpenScopeOpts {
  database?: string
  ask?: (title: string) => Promise<string | null> // password prompt
}

/** Connect (or reuse) a connection + database as a scope with its own session, focus it, load its objects. */
export async function openScope(conn: Connection, opts: OpenScopeOpts = {}): Promise<string> {
  const existing = Object.values(scopes()).find((s) => s.conn.id === conn.id && (opts.database === undefined ? true : s.database === opts.database))
  if (existing?.sessionId && !existing.lost) { focusOn(existing.id); return existing.id }
  let asked = askedPw.get(conn.id) ?? {}
  if (!askedPw.has(conn.id)) {
    if (conn.passwordMode === 'ask') {
      const pw = await opts.ask?.(`Password for ${conn.name}`)
      if (pw === null || pw === undefined) throw new Error('Connection cancelled.')
      asked = { ...asked, password: pw }
    }
    if (conn.ssh?.enabled && !conn.ssh.useKey && conn.ssh.passwordMode === 'ask') {
      const pw = await opts.ask?.(`SSH password for ${conn.ssh.user}@${conn.ssh.host}`)
      if (pw === null || pw === undefined) throw new Error('Connection cancelled.')
      asked = { ...asked, sshPassword: pw }
    }
  }
  // SQLite "databases" are sibling files of the connection's file
  const sep = conn.filePath?.includes('\\') && !conn.filePath.includes('/') ? '\\' : '/'
  const override = opts.database === undefined ? undefined
    : conn.driver === 'sqlite' ? { filePath: (conn.filePath ?? '').split(sep).slice(0, -1).concat(opts.database).join(sep) }
      : { database: opts.database }
  const r = await call<{ sessionId: string; info: ServerInfo }>('session.open', conn.id, asked, override)
  if (conn.passwordMode === 'ask' || conn.ssh?.passwordMode === 'ask') askedPw.set(conn.id, asked)
  const id = scopeIdOf(conn.id, r.info.database)
  const first = !Object.values(scopes()).some((s) => s.conn.id === conn.id)
  raw.setState((st) => ({
    scopes: { ...st.scopes, [id]: { id, conn, sessionId: r.sessionId, info: r.info, dialect: dialectOf(conn.driver), database: r.info.database, schema: r.info.schema, objects: [], objectsLoading: false, selectedObjects: [], lost: false, busy: 0 } },
    focus: id
  }))
  await loadObjects(id)
  if (first) await afterFirstConnect(id)
  return id
}

/** First database of a connection: Redis opens its key browser, SQL restores the saved editor tabs. */
async function afterFirstConnect(scopeId: string): Promise<void> {
  const sc = scopes()[scopeId]
  if (!sc) return
  if (sc.conn.driver === 'redis') { openTab({ scope: scopeId, kind: 'redis', title: `${sc.conn.name} · db${sc.database ?? 0}` }); return }
  if (!sc.dialect) return
  const mode = (await call<Record<string, unknown>>('settings.all'))['editor.restoreTabs'] ?? 'first'
  if (mode === 'none') return
  const saved = await call<{ title: string | null; content: string }[]>('editorTabs.get', sc.conn.id)
  for (const t of mode === 'first' ? saved.slice(0, 1) : saved) if (t.content.trim()) openTab({ scope: scopeId, kind: 'query', title: t.title ?? 'SQL Query', content: t.content })
}

/** Apply an edited connection to every open scope of it (host/credential changes need a reconnect). */
export const updateConnInScopes = (conn: Connection): void => { for (const s of Object.values(scopes())) if (s.conn.id === conn.id) setScope(s.id, { conn }) }

/** Close one scope: its tabs (caller confirms pending changes) and its session. */
export async function closeScope(scopeId: string): Promise<void> {
  const sc = scopes()[scopeId]
  if (!sc) return
  for (const t of raw.getState().tabs.filter((x) => x.scope === scopeId)) closeTab(t.id)
  raw.setState((st) => {
    const next = { ...st.scopes }
    delete next[scopeId]
    const rest = Object.keys(next)
    return { scopes: next, focus: st.focus === scopeId ? rest[rest.length - 1] : st.focus }
  })
  if (sc.sessionId) await call('session.close', sc.sessionId).catch(() => {})
}

export async function closeConnection(connId: string): Promise<void> {
  for (const s of Object.values(scopes()).filter((x) => x.conn.id === connId)) await closeScope(s.id)
  askedPw.delete(connId)
}

export const scopeOfSession = (sessionId: string): Scope | undefined => Object.values(scopes()).find((s) => s.sessionId === sessionId)

// ---------- tabs ----------
export function openTab(t: Omit<Tab, 'id'> & { id?: string }, opts: { newTab?: boolean } = {}): string {
  const s = raw.getState()
  const scope = t.scope ?? s.focus
  const pane = t.pane ?? s.activePane
  const same = s.tabs.find((x) => x.kind === t.kind && x.kind !== 'query' && x.kind !== 'empty' && x.scope === scope && x.schema === t.schema && x.name === t.name && (x.pane ?? 0) === pane)
  if (same && !t.initialFilter) {
    setWs({ active: same.id, tabs: s.tabs.map((x) => (x.id === same.id && !t.preview ? { ...x, preview: false, view: t.view ?? x.view } : x.id === same.id && t.view ? { ...x, view: t.view } : x)) })
    return same.id
  }
  const id = t.id ?? uid()
  const tab: Tab = { ...t, id, pane, scope }
  // reuse rule: a clean preview tab is replaced; tabs with pending changes or SQL editors are kept
  const reusable = !opts.newTab && t.preview ? s.tabs.find((x) => x.preview && (x.pane ?? 0) === pane && !(s.tabApis[x.id]?.pendingCount() > 0)) : undefined
  if (reusable) {
    registerTabApi(reusable.id, null)
    setWs({ tabs: s.tabs.map((x) => (x.id === reusable.id ? tab : x)), active: id })
  } else {
    const idx = s.tabs.findIndex((x) => x.id === s.active)
    const tabs = [...s.tabs]
    tabs.splice(idx < 0 ? tabs.length : idx + 1, 0, tab)
    setWs({ tabs, active: id })
  }
  return id
}

export function updateTab(id: string, patch: Partial<Tab>): void {
  raw.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
}

export function closeTab(id: string): void {
  const s = raw.getState()
  const idx = s.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  const tabs = s.tabs.filter((t) => t.id !== id)
  registerTabApi(id, null)
  const closing = s.tabs[idx]
  const samePane = tabs.filter((t) => (t.pane ?? 0) === (closing.pane ?? 0))
  const next = s.active === id ? (samePane[Math.min(idx, samePane.length - 1)] ?? tabs[tabs.length - 1])?.id : s.active
  setWs({ tabs, active: next, split: s.split && tabs.some((t) => t.pane === 1) })
}

export const newQueryTab = (content = '', title?: string, filePath?: string): string => {
  const focus = raw.getState().focus
  if (!focus || !scopes()[focus]) { toast('Open a connection first: double-click it in the sidebar.'); return '' }
  const n = raw.getState().tabs.filter((t) => t.kind === 'query').length + 1
  return openTab({ kind: 'query', title: title ?? `SQL Query ${n}`, content, filePath })
}

// ---------- safe mode ----------
interface SafeReq { stmts: string[]; password: boolean; sessionId?: string; connName?: string; database?: string; level: number; resolve: (ok: boolean) => void }
export const useSafe = create<{ req: SafeReq | null }>(() => ({ req: null }))

/** Resolve true when the statements may be sent under the connection's safe-mode level. */
export function guard(stmts: string[], scopeId = raw.getState().focus): Promise<boolean> {
  const sc = scopeId ? scopes()[scopeId] : undefined
  const level = sc?.conn.safeMode ?? 0
  if (!stmts.length || level === 0) return Promise.resolve(true)
  const allRead = stmts.every(isReadOnly)
  if ((level === 2 || level === 4) && allRead) return Promise.resolve(true)
  return new Promise((resolve) => useSafe.setState({ req: { stmts, password: level >= 3, sessionId: sc?.sessionId, connName: sc?.conn.name, database: sc?.database, level, resolve } }))
}

/** Run statements through safe mode and the query RPC, tracking busy state. */
export async function runSql(stmts: string[], opts: { stopOnError?: boolean; source?: string; skipGuard?: boolean; scope?: string } = {}): Promise<Result[] | null> {
  const scopeId = opts.scope ?? raw.getState().focus
  const sc = scopeId ? scopes()[scopeId] : undefined
  if (!sc?.sessionId) throw new Error('Not connected')
  if (!opts.skipGuard && !(await guard(stmts, sc.id))) return null
  setScope(sc.id, { busy: (scopes()[sc.id]?.busy ?? 0) + 1 })
  try {
    return await call<Result[]>('db.query', sc.sessionId, stmts, opts)
  } finally {
    setScope(sc.id, { busy: Math.max(0, (scopes()[sc.id]?.busy ?? 1) - 1) })
  }
}

export async function busy<T>(p: Promise<T>): Promise<T> {
  const id = raw.getState().focus
  if (id) setScope(id, { busy: (scopes()[id]?.busy ?? 0) + 1 })
  try { return await p } finally { if (id) setScope(id, { busy: Math.max(0, (scopes()[id]?.busy ?? 1) - 1) }) }
}

/** Scope of the component (inside a tab) or the focused one. */
export const useScopeId = (): string | undefined => {
  const fromTab = useContext(ScopeContext)
  const focus = useFocus()
  return fromTab ?? focus
}
