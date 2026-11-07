import { type ReactNode, useEffect, useState } from 'react'
import { call, fail, useSetting } from '../lib/api'
import { newQueryTab, setWs, ws } from '../lib/ws'
import { Icon } from '../components/Icon'
import { confirmDialog, menuAt, menuBelow, promptDialog, type MenuItem } from '../components/ui'
import { fuzzy } from './Sidebar'

export interface QueryNode { name: string; path: string; dir: boolean; keywords?: string[]; created?: number; modified?: number; children?: QueryNode[]; shared?: boolean }

/** Saved queries cache for autocomplete keyword binding. */
let cache: QueryNode[] = []
export const savedQueries = (): QueryNode[] => cache
export async function refreshQueries(): Promise<QueryNode[]> {
  cache = await call<QueryNode[]>('queries.tree')
  window.dispatchEvent(new CustomEvent('queries:changed'))
  return cache
}
export const flatQueries = (nodes: QueryNode[] = cache): QueryNode[] => nodes.flatMap((n) => (n.dir ? flatQueries(n.children) : [n]))

export async function openSavedQuery(path: string, run = false): Promise<void> {
  const existing = ws().tabs.find((t) => t.filePath === path)
  if (existing && !run) { setWs({ active: existing.id }); return }
  const q = await call<{ name: string; sql: string }>('queries.read', path)
  const id = newQueryTab(q.sql, q.name, path)
  if (run) setTimeout(() => window.dispatchEvent(new CustomEvent('query:run', { detail: id })), 300)
}

export function QueriesPanel({ filter }: { filter: string }): ReactNode {
  const [tree, setTree] = useState<QueryNode[]>(cache)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [sortBy, setSortBy] = useSetting<'name' | 'created' | 'modified'>('queries.sortBy', 'name')
  const [shared, setShared] = useSetting<string[]>('queries.sharedFolders', [])
  const load = (): void => void refreshQueries().then(setTree).catch(fail)
  useEffect(() => { load(); const h = (): void => setTree([...cache]); window.addEventListener('queries:changed', h); return () => window.removeEventListener('queries:changed', h) }, [shared.length])

  const sorter = (a: QueryNode, b: QueryNode): number => (a.dir !== b.dir ? (a.dir ? -1 : 1) : sortBy === 'name' ? a.name.localeCompare(b.name) : (b[sortBy] ?? 0) - (a[sortBy] ?? 0))

  const newQuery = async (folder?: string): Promise<void> => {
    const name = await promptDialog('New saved query', '', { ok: 'Create' })
    if (!name?.trim()) return
    const kw = await promptDialog('Keywords (optional)', '', { message: 'Comma-separated words. Typing one in the editor offers this whole query.' })
    const path = await call<string>('queries.write', null, name.trim(), '', (kw ?? '').split(',').map((s) => s.trim()).filter(Boolean), folder)
    load()
    void openSavedQuery(path)
  }

  const menu = (n?: QueryNode): MenuItem[] => [
    ...(n && !n.dir ? [
      { label: 'Open', onClick: () => void openSavedQuery(n.path) },
      { label: 'Run', onClick: () => void openSavedQuery(n.path, true) },
      { label: 'Copy SQL', onClick: async () => { const q = await call<{ sql: string }>('queries.read', n.path); await navigator.clipboard.writeText(q.sql) } },
      { label: 'Insert into New Tab', onClick: async () => { const q = await call<{ sql: string }>('queries.read', n.path); newQueryTab(q.sql) } },
      { label: 'Edit Keywords…', onClick: async () => {
        const q = await call<{ name: string; sql: string; keywords: string[] }>('queries.read', n.path)
        const kw = await promptDialog('Keywords', q.keywords.join(', '))
        if (kw !== null) { await call('queries.write', n.path, q.name, q.sql, kw.split(',').map((s) => s.trim()).filter(Boolean)); load() }
      } },
      { sep: true }
    ] : []),
    ...(n ? [
      { label: 'Rename…', onClick: async () => { const nn = await promptDialog('Rename', n.name); if (nn?.trim()) { await call('queries.rename', n.path, nn.trim()).catch(fail); load() } } },
      { label: 'Show in Folder', onClick: () => void call('shell.reveal', n.path) },
      ...(n.shared && n.dir && shared.includes(n.path) ? [{ label: 'Remove Shared Folder', onClick: () => setShared(shared.filter((p) => p !== n.path)) }] : [{ label: 'Delete…', danger: true, onClick: async () => { if (await confirmDialog(`Delete "${n.name}"?`, n.dir ? 'The folder and every query inside it are deleted.' : undefined, { ok: 'Delete', danger: true })) { await call('queries.delete', n.path); load() } } }]),
      { sep: true }
    ] : []),
    { label: 'New Query…', onClick: () => void newQuery(n?.dir ? n.path : undefined) },
    { label: 'New Folder…', onClick: async () => { const f = await promptDialog('New folder'); if (f?.trim()) { await call('queries.mkdir', n?.dir ? n.path : null, f.trim()).catch(fail); load() } } },
    { label: 'Add Shared Folder…', onClick: async () => { const [p] = await call<string[]>('dialog.open', { properties: ['openDirectory'] }); if (p && !shared.includes(p)) setShared([...shared, p]) } },
    { label: 'Sort By', submenu: (['name', 'created', 'modified'] as const).map((k) => ({ label: k === 'name' ? 'Name' : k === 'created' ? 'Date Created' : 'Date Modified', checked: sortBy === k, onClick: () => setSortBy(k) })) }
  ]

  const render = (nodes: QueryNode[], depth: number): ReactNode =>
    [...nodes].sort(sorter).filter((n) => n.dir || fuzzy(n.name, filter) || n.keywords?.some((k) => fuzzy(k, filter))).map((n) => (
      <div key={n.path}>
        <div
          className="list-item"
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!n.dir}
          onDragStart={(e) => e.dataTransfer.setData('text/query', n.path)}
          onDragOver={(e) => n.dir && e.preventDefault()}
          onDrop={(e) => { const p = e.dataTransfer.getData('text/query'); if (p && n.dir) void call('queries.move', p, n.path).then(load).catch(fail) }}
          onClick={() => n.dir && setOpen((o) => ({ ...o, [n.path]: !o[n.path] }))}
          onDoubleClick={() => !n.dir && void openSavedQuery(n.path)}
          onContextMenu={(e) => menuAt(e, menu(n))}
          title={n.keywords?.length ? `Keywords: ${n.keywords.join(', ')}` : n.name}
        >
          <Icon name={n.dir ? (open[n.path] || filter ? 'chevronDown' : 'chevronRight') : 'sql'} size={n.dir ? 9 : 13} className="faint" />
          {n.dir && <Icon name="folder" size={13} className="faint" />}
          <span className="ellipsis">{n.name}</span>
          {n.keywords?.length ? <span className="count">{n.keywords[0]}</span> : null}
        </div>
        {n.dir && (open[n.path] || filter) && render(n.children ?? [], depth + 1)}
      </div>
    ))

  return (
    <div onContextMenu={(e) => menuAt(e, menu())} style={{ minHeight: '100%' }}>
      {tree.length ? render(tree, 0) : <div className="empty">No saved queries yet.<button className="btn sm" onClick={() => void newQuery()}>New query</button></div>}
      <button className="btn ghost sm" style={{ margin: 'var(--sp-3)' }} onClick={(e) => menuBelow(e.currentTarget, menu())}><Icon name="plus" size={11} /> New</button>
    </div>
  )
}
