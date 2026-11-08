// Export / import saved connections (encrypted file).
import { type ReactNode, useState } from 'react'
import { call, fail, toast } from '../lib/api'
import { Modal, promptDialog } from '../components/ui'

/** Pick a .lagoonconn file and import it; returns how many connections were added. */
export async function importConnectionsFile(): Promise<number> {
  const [f] = await call<string[]>('dialog.open', { properties: ['openFile'], filters: [{ name: 'Lagoon connections', extensions: ['lagoonconn', 'json'] }] })
  if (!f) return 0
  let pw = ''
  if (await call<boolean>('conn.isEncryptedFile', f)) {
    pw = (await promptDialog('File password', '', { password: true, message: 'This connections file is protected by a password.' })) ?? ''
    if (!pw) return 0
  }
  try {
    const n = await call<number>('conn.importFile', f, pw)
    toast(`Imported ${n} connection(s)`, 'success')
    window.dispatchEvent(new CustomEvent('connections:changed'))
    return n
  } catch (e) {
    fail(e)
    return 0
  }
}

type ForeignApp = 'tableplus' | 'dbeaver' | 'navicat'
const FOREIGN: Record<ForeignApp, { name: string; filter: { name: string; extensions: string[] }; how: string }> = {
  tableplus: { name: 'TablePlus', filter: { name: 'TablePlus connections', extensions: ['plist'] }, how: 'Pick Connections.plist from TablePlus\'s Data folder.' },
  dbeaver: { name: 'DBeaver', filter: { name: 'DBeaver data sources', extensions: ['json'] }, how: 'Pick data-sources.json from the workspace\'s .dbeaver folder.' },
  navicat: { name: 'Navicat', filter: { name: 'Navicat connections', extensions: ['ncx'] }, how: 'In Navicat use File ▸ Export Connections (tick Export Password), then pick the .ncx file.' }
}

/** Import another app's saved connections: its default file when found, else one the user picks. */
export async function importForeignConnections(app: ForeignApp): Promise<number> {
  const { name, filter, how } = FOREIGN[app]
  const path = (await call<string | undefined>('conn.foreignDefault', app))
    ?? (await call<string[]>('dialog.open', { title: `Import from ${name}`, message: how, properties: ['openFile'], filters: [filter, { name: 'All files', extensions: ['*'] }] }))[0]
  if (!path) return 0
  try {
    const r = await call<{ imported: number; duplicates: number; skipped: string[] }>('conn.importForeign', app, path)
    const notes = [r.duplicates ? `${r.duplicates} already in Lagoon` : '', r.skipped.length ? `skipped ${r.skipped.join(', ')}` : ''].filter(Boolean).join('; ')
    toast(`Imported ${r.imported} connection(s) from ${name}${notes ? ` (${notes})` : ''}`, r.imported ? 'success' : undefined)
    window.dispatchEvent(new CustomEvent('connections:changed'))
    return r.imported
  } catch (e) {
    fail(e)
    return 0
  }
}

export function ExportConnections({ ids, onClose }: { ids: string[]; onClose: () => void }): ReactNode {
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
