import { type ReactNode, useEffect, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { call, focusScope, toast, useCommands, useSetting } from '../lib/api'
import { useWs, setWs, newQueryTab } from '../lib/ws'
import { Icon } from '../components/Icon'
import { confirmDialog, menuAt, menuBelow, promptDialog, type MenuItem } from '../components/ui'
import { SearchPanel } from './SearchPanel'
import { QueriesPanel } from './QueriesPanel'
import { Navigator, newConnection } from './Navigator'

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
  const [showCols, setShowCols] = useSetting('sidebar.showColumns', false)
  const [sysSchemas, setSysSchemas] = useSetting('table.showSystemSchemas', false)

  useCommands('sidebar', { 'edit.findSidebar': () => { setWs({ left: true }); setTimeout(() => document.getElementById('sidebar-search')?.focus()) } })

  if (s.sidebarSearch) return <SearchPanel onDone={() => setWs({ sidebarSearch: false })} />

  return (
    <div className="col grow" onFocusCapture={() => focusScope('sidebar')}>
      <div style={{ padding: 'var(--sp-4) var(--sp-4) var(--sp-3)' }} className="col">
        <div className="tabs" role="tablist" style={{ justifyContent: 'center', marginBottom: 'var(--sp-3)' }}>
          {(['items', 'queries', 'history'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'items' ? 'Connections' : t === 'queries' ? 'Queries' : 'History'}</button>
          ))}
        </div>
        <div className="row">
          <input id="sidebar-search" className="input grow sm" placeholder={tab === 'items' ? 'Search connections and tables' : tab === 'queries' ? 'Search queries' : 'Search history'} aria-label="Search sidebar" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
          {tab === 'items' && (
            <>
              <button className="btn ghost icon sm" aria-label="New connection" title="New connection" onClick={newConnection}><Icon name="plus" size={12} /></button>
              <button className="btn ghost icon sm" aria-label="Sidebar options" title="Sidebar options" onClick={(e) => menuBelow(e.currentTarget, [
                { label: 'Search in Database…', disabled: !s.dialect, onClick: () => setWs({ sidebarSearch: true }) },
                { sep: true },
                { label: 'Show columns', checked: showCols, onClick: () => setShowCols(!showCols) },
                { label: 'Load system schemas', checked: sysSchemas, onClick: () => setSysSchemas(!sysSchemas) }
              ])}><Icon name="more" size={12} /></button>
            </>
          )}
        </div>
      </div>
      <div className="grow" style={{ overflow: 'auto', padding: '0 var(--sp-3)' }}>
        {tab === 'items' && <Navigator filter={q} />}
        {tab === 'queries' && <QueriesPanel filter={q} />}
        {tab === 'history' && (s.conn ? <HistoryPanel filter={q} /> : <div className="empty">Select a connection to see its history.</div>)}
      </div>
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
