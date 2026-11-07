import { type ReactNode, useEffect, useState } from 'react'
import type { Connection, DriverId, Tag } from '@shared/types'
import { DRIVERS, SSL_MODES, SAFE_MODES } from '@shared/types'
import { parseConnectionUrl } from '@shared/url'
import { call, errText, fail, setting, toast } from '../lib/api'
import { Modal } from '../components/ui'
import { TagManager } from './TagManager'

export const DRIVER_COLORS: Record<DriverId, string> = { postgres: '#336791', mysql: '#00758f', mariadb: '#a0705a', sqlite: '#4a7fa5', redis: '#d0382b', mongodb: '#3f9a4b' }
const COLORS = ['', '#8e8e93', '#34c759', '#007aff', '#ff9500', '#ff3b30', '#af52de', '#5ac8fa', '#ffcc00']

export function DriverPicker({ onPick, onClose, onUrl }: { onPick: (d: DriverId) => void; onClose: () => void; onUrl: () => void }): ReactNode {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<DriverId>('postgres')
  const list = DRIVERS.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <Modal
      title="New connection"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn ghost" onClick={onUrl} style={{ marginRight: 'auto' }}>Import from URL…</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onPick(sel)} disabled={!list.some((d) => d.id === sel)}>Create</button>
        </>
      }
    >
      <input className="input" autoFocus placeholder="Search engines" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && list[0] && onPick(list.some((d) => d.id === sel) ? sel : list[0].id)} />
      <div className="driver-grid" role="listbox" aria-label="Database engines">
        {list.map((d) => (
          <div key={d.id} role="option" aria-selected={sel === d.id} tabIndex={0} className={`driver-tile ${sel === d.id ? 'on' : ''}`} onClick={() => setSel(d.id)} onDoubleClick={() => onPick(d.id)} onKeyDown={(e) => e.key === 'Enter' && onPick(d.id)}>
            <div className="conn-item" style={{ padding: 0, margin: 0 }}><div className="drv" style={{ background: DRIVER_COLORS[d.id] }}>{d.short}</div></div>
            <div>{d.name}</div>
          </div>
        ))}
        {!list.length && <div className="empty" style={{ gridColumn: '1 / -1' }}>No engine matches "{q}"</div>}
      </div>
    </Modal>
  )
}

export function UrlImport({ onClose, onParsed }: { onClose: () => void; onParsed: (c: Partial<Connection>) => void }): ReactNode {
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const go = (): void => {
    try { onParsed(parseConnectionUrl(url)) } catch (e) { setErr(errText(e)) }
  }
  return (
    <Modal title="Import connection from URL" onClose={onClose} width={560} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={go} disabled={!url.trim()}>Import</button></>}>
      <input className="input mono" autoFocus placeholder="postgresql://user:password@127.0.0.1:5432/database" value={url} onChange={(e) => { setUrl(e.target.value); setErr('') }} onKeyDown={(e) => e.key === 'Enter' && go()} aria-invalid={!!err} />
      {err ? <div className="danger-text">{err}</div> : <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>SSH format: driver+ssh://ssh_user@ssh_host:22/user:password@db_host:port/database</div>}
    </Modal>
  )
}

const blank = (driver: DriverId): Connection => ({
  id: '', name: '', driver, host: driver === 'sqlite' ? undefined : '127.0.0.1', port: DRIVERS.find((d) => d.id === driver)?.port,
  passwordMode: 'store', safeMode: setting('security.defaultSafeMode', 0), tagId: null, ssl: SSL_MODES[driver] ? { mode: SSL_MODES[driver]![0] } : undefined,
  ssh: { enabled: false, host: '', port: 22, user: '', useKey: false, passwordMode: 'store' }
})

export function ConnectionForm({ initial, onClose, onSaved }: { initial: Partial<Connection> & { driver: DriverId }; onClose: () => void; onSaved: (c: Connection, connect: boolean) => void }): ReactNode {
  const [c, setC] = useState<Connection>({ ...blank(initial.driver), ...initial, ssh: { ...blank(initial.driver).ssh!, ...initial.ssh } })
  const [tags, setTags] = useState<Tag[]>([])
  const [tagMgr, setTagMgr] = useState(false)
  const [testing, setTesting] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [stored, setStored] = useState({ password: false, sshPassword: false })
  useEffect(() => { void call<Tag[]>('tag.list').then(setTags) }, [tagMgr])
  useEffect(() => { if (c.id) void call<typeof stored>('conn.hasSecret', c.id).then(setStored) }, [c.id])
  const set = (patch: Partial<Connection>): void => { setC((x) => ({ ...x, ...patch })); setTesting('idle') }
  const setSsh = (patch: Partial<NonNullable<Connection['ssh']>>): void => set({ ssh: { ...c.ssh!, ...patch } })
  const isFile = c.driver === 'sqlite'
  const isKv = c.driver === 'redis'
  const driverName = DRIVERS.find((d) => d.id === c.driver)?.name
  const valid = isFile ? !!c.filePath : !!c.host

  const test = async (): Promise<void> => {
    setTesting('busy')
    try {
      const v = await call<string>('conn.test', c)
      setTesting('ok')
      setTestMsg(`Connected · server ${v}`)
    } catch (e) {
      setTesting('fail')
      setTestMsg(errText(e))
    }
  }
  const save = async (connect: boolean): Promise<void> => {
    try {
      const saved = await call<Connection>('conn.save', { ...c, name: c.name.trim() || (isFile ? c.filePath?.split(/[\\/]/).pop() : c.host) || driverName })
      onSaved(saved, connect)
    } catch (e) { fail(e) }
  }
  const pickFile = async (key: 'filePath' | 'keyPath' | 'sslKey' | 'sslCert' | 'sslCa', save = false): Promise<void> => {
    const r = key === 'filePath' && save
      ? [await call<string | undefined>('dialog.save', { title: 'New SQLite database', defaultPath: 'database.sqlite3' })].filter(Boolean) as string[]
      : await call<string[]>('dialog.open', { properties: ['openFile', 'showHiddenFiles'] })
    if (!r[0]) return
    if (key === 'filePath') set({ filePath: r[0] })
    else if (key === 'keyPath') setSsh({ keyPath: r[0] })
    else set({ ssl: { ...c.ssl!, [key === 'sslKey' ? 'keyPath' : key === 'sslCert' ? 'certPath' : 'caPath']: r[0] } })
  }

  return (
    <Modal
      title={<><span>{c.id ? 'Edit' : 'New'} {driverName} connection</span></>}
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className={`grow ellipsis ${testing === 'fail' ? 'danger-text' : 'muted'}`} style={{ color: testing === 'ok' ? 'var(--success)' : undefined, fontSize: 'var(--fs-sm)' }} title={testMsg} role="status">
            {testing === 'busy' ? 'Testing…' : testMsg}
          </span>
          <button className="btn" onClick={test} disabled={!valid || testing === 'busy'}>Test</button>
          <button className="btn" onClick={() => save(false)} disabled={!valid}>Save</button>
          <button className="btn primary" onClick={() => save(true)} disabled={!valid}>Connect</button>
        </>
      }
    >
      <div className="fieldset" style={{ borderTop: `3px solid ${c.statusColor || 'var(--border)'}` }}>
        <div className="field"><label htmlFor="cf-name">Name</label><input id="cf-name" className="input" autoFocus value={c.name} placeholder={isFile ? 'My database' : 'Production DB'} onChange={(e) => set({ name: e.target.value })} /></div>
        <div className="field">
          <label>Status color</label>
          <div className="row" role="radiogroup" aria-label="Status color">
            {COLORS.map((col) => (
              <button key={col || 'none'} role="radio" aria-checked={(c.statusColor ?? '') === col} title={col || 'No color'} className="btn icon sm" style={{ borderRadius: '50%', width: 18, height: 18, background: col || 'transparent', outline: (c.statusColor ?? '') === col ? '2px solid var(--focus)' : undefined, outlineOffset: 1 }} onClick={() => set({ statusColor: col || undefined })} />
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="cf-tag">Tag</label>
          <div className="row">
            <select id="cf-tag" className="select grow" value={c.tagId ?? ''} onChange={(e) => e.target.value === '__manage' ? setTagMgr(true) : set({ tagId: e.target.value || null })}>
              <option value="">No tag</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="__manage">Add or remove tags…</option>
            </select>
            <label htmlFor="cf-safe" className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Safe mode</label>
            <select id="cf-safe" className="select" value={c.safeMode} onChange={(e) => set({ safeMode: Number(e.target.value) })}>
              {SAFE_MODES.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="fieldset">
        {isFile ? (
          <div className="field">
            <label htmlFor="cf-file">Database file</label>
            <div className="row">
              <input id="cf-file" className="input grow mono" value={c.filePath ?? ''} onChange={(e) => set({ filePath: e.target.value })} placeholder="/path/to/database.sqlite" />
              <button className="btn" onClick={() => pickFile('filePath')}>Open…</button>
              <button className="btn" onClick={() => pickFile('filePath', true)}>New…</button>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="cf-host">Host</label>
              <div className="row">
                <input id="cf-host" className="input grow mono" value={c.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder={c.driver === 'mongodb' ? '127.0.0.1 or mongodb+srv://…' : '127.0.0.1'} />
                <label htmlFor="cf-port" className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Port</label>
                <input id="cf-port" className="input mono" style={{ width: 80 }} value={c.port ?? ''} onChange={(e) => set({ port: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : undefined })} />
              </div>
            </div>
            <div className="field"><label htmlFor="cf-user">User</label><input id="cf-user" className="input mono" value={c.username ?? ''} placeholder={isKv ? 'default (optional)' : ''} onChange={(e) => set({ username: e.target.value })} /></div>
            <div className="field">
              <label htmlFor="cf-pass">Password</label>
              <div className="row">
                <input id="cf-pass" className="input grow mono" type="password" disabled={c.passwordMode !== 'store'} placeholder={stored.password && c.passwordMode === 'store' ? '•••••••• (saved, type to change)' : c.passwordMode === 'ask' ? 'Asked when connecting' : ''} value={c.password ?? ''} onChange={(e) => set({ password: e.target.value })} />
                <select className="select" aria-label="Password storage" value={c.passwordMode} onChange={(e) => set({ passwordMode: e.target.value as Connection['passwordMode'] })}>
                  <option value="store">Store securely</option>
                  <option value="ask">Ask every time</option>
                  <option value="none">No password</option>
                  {['postgres', 'mysql', 'mariadb'].includes(c.driver) && <option value="command">From shell command</option>}
                </select>
              </div>
            </div>
            {c.passwordMode === 'command' && (
              <div className="field"><label htmlFor="cf-pcmd">Command</label><input id="cf-pcmd" className="input mono" placeholder="aws rds generate-db-auth-token …" value={c.passwordCommand ?? ''} onChange={(e) => set({ passwordCommand: e.target.value })} /></div>
            )}
            <div className="field"><label htmlFor="cf-db">{isKv ? 'Database index' : 'Database'}</label><input id="cf-db" className="input mono" value={c.database ?? ''} placeholder={isKv ? '0' : c.driver === 'postgres' ? 'postgres' : 'optional'} onChange={(e) => set({ database: e.target.value })} /></div>
          </>
        )}
        {!isKv && c.driver !== 'mongodb' && (
          <div className="field">
            <label htmlFor="cf-boot">Startup SQL</label>
            <textarea id="cf-boot" className="textarea" rows={2} placeholder="Runs after every connect, e.g. SET search_path TO app;" value={c.bootstrapSql ?? ''} onChange={(e) => set({ bootstrapSql: e.target.value })} />
          </div>
        )}
      </div>

      {!isFile && (
        <div className="fieldset">
          <label className="check"><input type="checkbox" checked={!!c.ssh?.enabled} onChange={(e) => setSsh({ enabled: e.target.checked })} /> Connect through an SSH tunnel</label>
          {c.ssh?.enabled && (
            <>
              <div className="field">
                <label htmlFor="cf-sshhost">SSH host</label>
                <div className="row">
                  <input id="cf-sshhost" className="input grow mono" value={c.ssh.host} onChange={(e) => setSsh({ host: e.target.value })} placeholder="bastion.example.com or a ~/.ssh/config alias" />
                  <label htmlFor="cf-sshport" className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Port</label>
                  <input id="cf-sshport" className="input mono" style={{ width: 64 }} value={c.ssh.port || ''} onChange={(e) => setSsh({ port: Number(e.target.value.replace(/\D/g, '')) || 22 })} />
                </div>
              </div>
              <div className="field"><label htmlFor="cf-sshuser">SSH user</label><input id="cf-sshuser" className="input mono" value={c.ssh.user} onChange={(e) => setSsh({ user: e.target.value })} /></div>
              <div className="field">
                <label>Auth</label>
                <label className="check"><input type="checkbox" checked={c.ssh.useKey} onChange={(e) => setSsh({ useKey: e.target.checked })} /> Use a private key (falls back to ~/.ssh/config and the SSH agent)</label>
              </div>
              {c.ssh.useKey ? (
                <>
                  <div className="field">
                    <label htmlFor="cf-key">Private key</label>
                    <div className="row"><input id="cf-key" className="input grow mono" value={c.ssh.keyPath ?? ''} placeholder="Leave empty to use ~/.ssh/config" onChange={(e) => setSsh({ keyPath: e.target.value })} /><button className="btn" onClick={() => pickFile('keyPath')}>Choose…</button></div>
                  </div>
                  <div className="field"><label htmlFor="cf-pass2">Passphrase</label><input id="cf-pass2" type="password" className="input mono" value={c.sshPassphrase ?? ''} onChange={(e) => set({ sshPassphrase: e.target.value })} placeholder="optional" /></div>
                </>
              ) : (
                <div className="field">
                  <label htmlFor="cf-sshpass">SSH password</label>
                  <div className="row">
                    <input id="cf-sshpass" type="password" className="input grow mono" disabled={c.ssh.passwordMode !== 'store'} value={c.sshPassword ?? ''} placeholder={stored.sshPassword ? '•••••••• (saved)' : ''} onChange={(e) => set({ sshPassword: e.target.value })} />
                    <select className="select" aria-label="SSH password storage" value={c.ssh.passwordMode} onChange={(e) => setSsh({ passwordMode: e.target.value as Connection['passwordMode'] })}>
                      <option value="store">Store securely</option><option value="ask">Ask every time</option><option value="none">No password</option>
                    </select>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {SSL_MODES[c.driver] && (
        <div className="fieldset">
          <div className="field">
            <label htmlFor="cf-ssl">SSL mode</label>
            <select id="cf-ssl" className="select" value={c.ssl?.mode ?? SSL_MODES[c.driver]![0]} onChange={(e) => set({ ssl: { ...c.ssl, mode: e.target.value } })}>
              {SSL_MODES[c.driver]!.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          {c.ssl?.mode && c.ssl.mode !== 'DISABLED' && (
            <div className="field">
              <label>Certificates</label>
              <div className="row">
                {(['sslKey', 'sslCert', 'sslCa'] as const).map((k) => {
                  const path = k === 'sslKey' ? c.ssl?.keyPath : k === 'sslCert' ? c.ssl?.certPath : c.ssl?.caPath
                  return <button key={k} className={`btn sm ${path ? 'on' : ''}`} title={path ?? 'Not set'} onClick={() => pickFile(k)}>{k === 'sslKey' ? 'Key…' : k === 'sslCert' ? 'Cert…' : 'CA cert…'}{path ? ' ✓' : ''}</button>
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {tagMgr && <TagManager onClose={() => setTagMgr(false)} />}
    </Modal>
  )
}

export async function connectFlow(c: Connection): Promise<void> {
  await call('window.open', { view: 'workspace', conn: c.id })
}

export const notifySaved = (c: Connection): void => toast(`Saved "${c.name}"`, 'success')
