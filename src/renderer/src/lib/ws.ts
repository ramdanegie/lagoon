// Workspace state (one per window): connection, session, objects, tabs, console, pending-change registry.
import { create } from 'zustand'
import type { Connection, DbObject, Dialect, Result, ServerInfo, ObjectKind } from '@shared/types'
import { isReadOnly } from '@shared/split'
import { call, uid } from './api'

export type TabKind = 'table' | 'query' | 'ddl' | 'redis' | 'mongo' | 'metrics' | 'diagram' | 'users' | 'empty'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  schema?: string
  name?: string
  objKind?: ObjectKind
  preview?: boolean // replaced by the next object opened (single click)
  view?: 'data' | 'structure' | 'index'
  initialFilter?: { column: string; op: string; value: string }
  content?: string // query text / file path for saved queries
  filePath?: string
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

export interface ConsoleEntry { at: string; sql: string }

interface WsState {
  conn?: Connection
  sessionId?: string
  info?: ServerInfo
  dialect?: Dialect
  database?: string
  schema?: string
  objects: DbObject[]
  objectsLoading: boolean
  tabs: Tab[]
  active?: string
  activePane: 0 | 1
  split: boolean
  console: ConsoleEntry[]
  busy: number
  left: boolean
  right: boolean
  showConsole: boolean
  lost: boolean
  tabApis: Record<string, TabApi>
  pendingVersion: number
  sidebarSearch: boolean
  selectedObjects: DbObject[]
}

export const useWs = create<WsState>(() => ({
  objects: [], objectsLoading: false, tabs: [], console: [], busy: 0, left: true, right: false, showConsole: false, lost: false, tabApis: {}, pendingVersion: 0, activePane: 0, split: false, sidebarSearch: false, selectedObjects: []
}))

export const ws = (): WsState => useWs.getState()
export const setWs = (p: Partial<WsState>): void => useWs.setState(p)

export function bumpPending(): void { useWs.setState((s) => ({ pendingVersion: s.pendingVersion + 1 })) }
export function registerTabApi(id: string, api: TabApi | null): void {
  useWs.setState((s) => {
    const next = { ...s.tabApis }
    if (api) next[id] = api
    else delete next[id]
    return { tabApis: next }
  })
}

export const objectKey = (schema: string | undefined, name: string): string => `${ws().database ?? ''}.${schema ?? ''}.${name}`

export async function loadObjects(): Promise<void> {
  const { sessionId, schema, conn } = ws()
  if (!sessionId || !conn) return
  setWs({ objectsLoading: true })
  try {
    if (conn.driver === 'mongodb') {
      const c = await call<{ name: string; type: string }[]>('mongo.collections', sessionId)
      setWs({ objects: c.map((x) => ({ schema: '', name: x.name, kind: x.type === 'view' ? 'view' : 'collection' })) })
    } else if (conn.driver === 'redis') setWs({ objects: [] })
    else if (schema !== undefined) setWs({ objects: await call<DbObject[]>('db.objects', sessionId, schema) })
  } finally {
    setWs({ objectsLoading: false })
  }
}

// ---------- tabs ----------
export function openTab(t: Omit<Tab, 'id'> & { id?: string }, opts: { newTab?: boolean } = {}): string {
  const s = ws()
  const pane = t.pane ?? s.activePane
  const same = s.tabs.find((x) => x.kind === t.kind && x.kind !== 'query' && x.kind !== 'empty' && x.schema === t.schema && x.name === t.name && (x.pane ?? 0) === pane)
  if (same && !t.initialFilter) {
    setWs({ active: same.id, tabs: s.tabs.map((x) => (x.id === same.id && !t.preview ? { ...x, preview: false, view: t.view ?? x.view } : x.id === same.id && t.view ? { ...x, view: t.view } : x)) })
    return same.id
  }
  const id = t.id ?? uid()
  const tab: Tab = { ...t, id, pane }
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
  useWs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
}

export function closeTab(id: string): void {
  const s = ws()
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
  const n = ws().tabs.filter((t) => t.kind === 'query').length + 1
  return openTab({ kind: 'query', title: title ?? `SQL Query ${n}`, content, filePath })
}

// ---------- safe mode ----------
interface SafeReq { stmts: string[]; password: boolean; resolve: (ok: boolean) => void }
export const useSafe = create<{ req: SafeReq | null }>(() => ({ req: null }))

/** Resolve true when the statements may be sent under the connection's safe-mode level. */
export function guard(stmts: string[]): Promise<boolean> {
  const level = ws().conn?.safeMode ?? 0
  if (!stmts.length || level === 0) return Promise.resolve(true)
  const allRead = stmts.every(isReadOnly)
  if ((level === 2 || level === 4) && allRead) return Promise.resolve(true)
  return new Promise((resolve) => useSafe.setState({ req: { stmts, password: level >= 3, resolve } }))
}

/** Run statements through safe mode and the query RPC, tracking busy state. */
export async function runSql(stmts: string[], opts: { stopOnError?: boolean; source?: string; skipGuard?: boolean } = {}): Promise<Result[] | null> {
  const { sessionId } = ws()
  if (!sessionId) throw new Error('Not connected')
  if (!opts.skipGuard && !(await guard(stmts))) return null
  useWs.setState((s) => ({ busy: s.busy + 1 }))
  try {
    return await call<Result[]>('db.query', sessionId, stmts, opts)
  } finally {
    useWs.setState((s) => ({ busy: s.busy - 1 }))
  }
}

export async function busy<T>(p: Promise<T>): Promise<T> {
  useWs.setState((s) => ({ busy: s.busy + 1 }))
  try { return await p } finally { useWs.setState((s) => ({ busy: s.busy - 1 })) }
}
