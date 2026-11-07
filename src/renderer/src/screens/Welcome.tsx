import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import type { Connection, DriverId, Group, Tag } from '@shared/types'
import { DRIVERS } from '@shared/types'
import { call, fail, toast, useCommands, useSetting } from '../lib/api'
import { Icon } from '../components/Icon'
import { Modal, confirmDialog, menuAt, promptDialog, type MenuItem } from '../components/ui'
import { ConnectionForm, DriverPicker, UrlImport, DRIVER_COLORS } from './ConnectionForm'
import { BackupDialog, RestoreDialog } from './Backup'
import appIcon from '../assets/icon.png'

type FormState = { step: 'driver' } | { step: 'url' } | { step: 'form'; initial: Partial<Connection> & { driver: DriverId } } | null

export function Welcome(): ReactNode {
  const [conns, setConns] = useState<Connection[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [sortBy, setSortBy] = useSetting<'name' | 'tag' | 'driver'>('welcome.sortBy', 'name')
  const [exportIds, setExportIds] = useState<string[] | null>(null)
  const [tool, setTool] = useState<'backup' | 'restore' | null>(null)

  const load = useCallback(async () => {
    const [c, g, t] = await Promise.all([call<Connection[]>('conn.list'), call<Group[]>('group.list'), call<Tag[]>('tag.list')])
    setConns(c); setGroups(g); setTags(t)
  }, [])
  useEffect(() => { void load(); document.title = 'Lagoon' }, [load])

  useCommands('welcome', {
    'conn.new': () => setForm({ step: 'driver' }),
    'edit.find': () => document.getElementById('welcome-search')?.focus(),
    'file.backup': () => setTool('backup'),
    'file.restore': () => setTool('restore'),
    'file.open': () => void openSqliteFile()
  })

  const tagOf = (id?: string | null): Tag | undefined => tags.find((t) => t.id === id)
  const sorted = useMemo(() => {
    const f = conns.filter((c) => !q || `${c.name} ${c.host ?? ''} ${c.database ?? ''} ${c.filePath ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    const key = (c: Connection): string => (sortBy === 'tag' ? tagOf(c.tagId)?.name ?? '~' : sortBy === 'driver' ? c.driver : '') + c.name.toLowerCase()
    return f.sort((a, b) => key(a).localeCompare(key(b)))
  }, [conns, q, sortBy, tags])

  const connect = async (c: Connection): Promise<void> => {
    await call('window.open', { view: 'workspace', conn: c.id })
    void call('window.close')
  }

  async function openSqliteFile(): Promise<void> {
    const [f] = await call<string[]>('dialog.open', { properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] }, { name: 'All files', extensions: ['*'] }] })
    if (f) { await call('window.open', { view: 'workspace', file: f }); void call('window.close') }
  }

  const importFile = async (): Promise<void> => {
    const [f] = await call<string[]>('dialog.open', { properties: ['openFile'], filters: [{ name: 'Lagoon connections', extensions: ['lagoonconn', 'json'] }] })
    if (!f) return
    let pw = ''
    if (await call<boolean>('conn.isEncryptedFile', f)) { pw = (await promptDialog('File password', '', { password: true, message: 'This connections file is protected by a password.' })) ?? ''; if (!pw) return }
    try { toast(`Imported ${await call<number>('conn.importFile', f, pw)} connection(s)`, 'success'); void load() } catch (e) { fail(e) }
  }

  const newGroup = async (parentId: string | null = null): Promise<void> => {
    const name = await promptDialog('New group', '', { ok: 'Create' })
    if (name?.trim()) setGroups(await call<Group[]>('group.save', { name: name.trim(), parentId }))
  }

  const listMenu = (c?: Connection, g?: Group): MenuItem[] => [
    ...(c ? [
      { label: 'Connect', onClick: () => void connect(c) },
      { sep: true },
      { label: 'Edit…', onClick: () => setForm({ step: 'form', initial: c }) },
      { label: 'Duplicate', onClick: async () => { await call('conn.duplicate', c.id); void load() } },
      { label: 'Copy as URL', onClick: async () => { await navigator.clipboard.writeText(await call<string>('conn.toUrl', c.id)); toast('URL copied (includes the password)') } },
      { label: 'Move to group', submenu: [{ label: 'No group', checked: !c.groupId, onClick: () => void call('conn.patch', c.id, { groupId: null }).then(load) }, ...groups.map((x) => ({ label: x.name, checked: c.groupId === x.id, onClick: () => void call('conn.patch', c.id, { groupId: x.id }).then(load) }))] },
      { sep: true }
    ] : []),
    ...(g ? [
      { label: 'Rename group…', onClick: async () => { const n = await promptDialog('Rename group', g.name); if (n?.trim()) setGroups(await call<Group[]>('group.save', { ...g, name: n.trim() })) } },
      { label: 'New subgroup…', onClick: () => void newGroup(g.id) },
      { label: 'Delete group…', danger: true, onClick: async () => { if (await confirmDialog(`Delete group "${g.name}"?`, 'Every connection inside this group is deleted too.', { ok: 'Delete', danger: true })) { await call('group.delete', g.id); void load() } } },
      { sep: true }
    ] : []),
    { label: 'New', submenu: [{ label: 'Connection…', onClick: () => setForm({ step: 'driver' }) }, { label: 'Group…', onClick: () => void newGroup() }, { label: 'Connection from URL…', onClick: () => setForm({ step: 'url' }) }] },
    { label: 'Import connections', submenu: [{ label: 'From URL…', onClick: () => setForm({ step: 'url' }) }, { label: 'From file…', onClick: () => void importFile() }] },
    { label: 'Export connections', submenu: [
      { label: 'All…', onClick: () => setExportIds(conns.map((x) => x.id)) },
      ...(g ? [{ label: 'This group…', onClick: () => setExportIds(conns.filter((x) => x.groupId === g.id).map((x) => x.id)) }] : []),
      ...(c ? [{ label: 'This connection…', onClick: () => setExportIds([c.id]) }] : [])
    ] },
    { label: 'Sort by', submenu: (['name', 'tag', 'driver'] as const).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), checked: sortBy === k, onClick: () => setSortBy(k) })) },
    ...(c ? [{ sep: true }, { label: 'Delete…', danger: true, onClick: async () => { if (await confirmDialog(`Delete "${c.name}"?`, 'The saved connection and its stored password are removed.', { ok: 'Delete', danger: true })) { await call('conn.delete', c.id); void load() } } }] : [])
  ]

  const renderConn = (c: Connection): ReactNode => {
    const t = tagOf(c.tagId)
    const drv = DRIVERS.find((d) => d.id === c.driver)!
    return (
      <div
        key={c.id}
        className={`conn-item ${sel === c.id ? 'selected' : ''}`}
        tabIndex={0}
        role="option"
        aria-selected={sel === c.id}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/conn', c.id)}
        onClick={() => setSel(c.id)}
        onDoubleClick={() => void connect(c)}
        onKeyDown={(e) => { if (e.key === 'Enter') void connect(c); if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) listMenu(c).at(-1)?.onClick?.() }}
        onContextMenu={(e) => { setSel(c.id); menuAt(e, listMenu(c)) }}
      >
        <div className="drv" style={{ background: DRIVER_COLORS[c.driver], boxShadow: c.statusColor ? `0 0 0 2px ${c.statusColor}` : undefined }}>{drv.short}</div>
        <div className="grow">
          <div className="row"><span className="ellipsis" style={{ fontWeight: 500 }}>{c.name}</span>{t && <span className="badge" style={{ background: t.color }}>{t.name}</span>}</div>
          <div className="meta ellipsis mono">
            {c.driver === 'sqlite' ? c.filePath : `${c.ssh?.enabled ? 'SSH · ' : ''}${c.host}${c.port ? ':' + c.port : ''}${c.database ? ' / ' + c.database : ''}`}
          </div>
        </div>
      </div>
    )
  }

  const renderGroup = (parentId: string | null, depth: number): ReactNode =>
    groups.filter((g) => (g.parentId ?? null) === parentId).map((g) => {
      const inside = sorted.filter((c) => c.groupId === g.id)
      return (
        <div key={g.id} style={{ marginLeft: depth * 12 }}>
          <div
            className="section-title"
            onClick={() => setCollapsed((s) => ({ ...s, [g.id]: !s[g.id] }))}
            onContextMenu={(e) => menuAt(e, listMenu(undefined, g))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const id = e.dataTransfer.getData('text/conn'); if (id) void call('conn.patch', id, { groupId: g.id }).then(load) }}
          >
            <Icon name={collapsed[g.id] ? 'chevronRight' : 'chevronDown'} size={10} />
            <span>{g.icon ?? ''} {g.name}</span>
            <span className="faint">{inside.length}</span>
          </div>
          {!collapsed[g.id] && <>{renderGroup(g.id, depth + 1)}{inside.map(renderConn)}</>}
        </div>
      )
    })

  const ungrouped = sorted.filter((c) => !c.groupId || !groups.some((g) => g.id === c.groupId))

  return (
    <div className="welcome">
      <div className="welcome-left drag">
        <img className="logo" src={appIcon} alt="" width={96} height={96} draggable={false} />
        <div style={{ fontWeight: 600, fontSize: 'var(--fs-lg)' }}>Lagoon</div>
        <div className="muted" style={{ fontSize: 'var(--fs-sm)', marginBottom: 'var(--sp-5)' }}>A calm place for your databases</div>
        <button className="btn nodrag" onClick={() => setForm({ step: 'driver' })}><Icon name="plus" /> Create connection</button>
        <button className="btn nodrag" onClick={() => void openSqliteFile()}><Icon name="file" /> Open SQLite file…</button>
        <button className="btn nodrag" onClick={() => setTool('backup')}><Icon name="download" /> Backup database</button>
        <button className="btn nodrag" onClick={() => setTool('restore')}><Icon name="upload" /> Restore database</button>
      </div>
      <div className="welcome-right" onContextMenu={(e) => menuAt(e, listMenu())} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const id = e.dataTransfer.getData('text/conn'); if (id) void call('conn.patch', id, { groupId: null }).then(load) }}>
        <div className="welcome-top drag">
          <div className="row grow nodrag" style={{ position: 'relative' }}>
            <Icon name="search" className="faint" />
            <input id="welcome-search" className="input grow" placeholder="Search connections" aria-label="Search connections" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn icon nodrag" title="New connection" aria-label="New connection" onClick={() => setForm({ step: 'driver' })}><Icon name="plus" /></button>
        </div>
        <div className="grow" style={{ overflow: 'auto', padding: 'var(--sp-3) 0' }} role="listbox" aria-label="Saved connections">
          {conns.length === 0 ? (
            <div className="empty">
              <Icon name="db" size={36} />
              <div>No saved connections yet.</div>
              <button className="btn primary" onClick={() => setForm({ step: 'driver' })}>Create your first connection</button>
            </div>
          ) : sorted.length === 0 ? (
            <div className="empty">Nothing matches "{q}".</div>
          ) : (
            <>
              {renderGroup(null, 0)}
              {groups.length > 0 && ungrouped.length > 0 && <div className="section-title">Local</div>}
              {ungrouped.map(renderConn)}
            </>
          )}
        </div>
      </div>
      {form?.step === 'driver' && <DriverPicker onClose={() => setForm(null)} onPick={(driver) => setForm({ step: 'form', initial: { driver } })} onUrl={() => setForm({ step: 'url' })} />}
      {form?.step === 'url' && <UrlImport onClose={() => setForm(null)} onParsed={(c) => setForm({ step: 'form', initial: c as Partial<Connection> & { driver: DriverId } })} />}
      {form?.step === 'form' && (
        <ConnectionForm
          initial={form.initial}
          onClose={() => setForm(null)}
          onSaved={(c, go) => { setForm(null); void load(); setSel(c.id); if (go) void connect(c); else toast(`Saved "${c.name}"`, 'success') }}
        />
      )}
      {exportIds && <ExportConnections ids={exportIds} onClose={() => setExportIds(null)} />}
      {tool === 'backup' && <BackupDialog onClose={() => setTool(null)} connections={conns} />}
      {tool === 'restore' && <RestoreDialog onClose={() => setTool(null)} connections={conns} />}
    </div>
  )
}

function ExportConnections({ ids, onClose }: { ids: string[]; onClose: () => void }): ReactNode {
  const [db, setDb] = useState(false)
  const [ssh, setSsh] = useState(false)
  const [pw, setPw] = useState('')
  const go = async (): Promise<void> => {
    const path = await call<string | undefined>('dialog.save', { defaultPath: 'connections.lagoonconn', filters: [{ name: 'Lagoon connections', extensions: ['lagoonconn'] }] })
    if (!path) return
    try { toast(`Exported ${await call<number>('conn.exportFile', path, ids, { dbPasswords: db, sshPasswords: ssh, password: pw })} connection(s)`, 'success'); onClose() } catch (e) { fail(e) }
  }
  return (
    <Modal title={`Export ${ids.length} connection(s)`} onClose={onClose} width={440} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={(db || ssh) && !pw}>Save…</button></>}>
      <label className="check"><input type="checkbox" checked={db} onChange={(e) => setDb(e.target.checked)} /> Include database passwords</label>
      <label className="check"><input type="checkbox" checked={ssh} onChange={(e) => setSsh(e.target.checked)} /> Include SSH passwords</label>
      <div className="field"><label htmlFor="ex-pw">File password</label><input id="ex-pw" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={db || ssh ? 'Required when passwords are included' : 'Optional'} /></div>
      <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>SSH keys and SSL certificate files are not included; pick them again after importing.</div>
    </Modal>
  )
}
