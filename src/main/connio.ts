// Export / import connections as an encrypted file, and Copy as URL (needs the stored secrets).
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'
import type { Connection, Group } from '@shared/types'
import { connectionToUrl } from '@shared/url'
import { register } from './rpc'
import { defaultPath, fromDbeaver, fromNavicat, fromTablePlus, withoutDuplicates, type ForeignApp } from './foreign'
import { getConnection, listConnections, listGroups, saveConnection, saveGroup, secretsOf } from './store'

const MAGIC = 'LGNCONN1'

function seal(json: string, password: string): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(password, salt, 32)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(json, 'utf8'), c.final()])
  return Buffer.concat([Buffer.from(MAGIC), salt, iv, c.getAuthTag(), body])
}

function open(buf: Buffer, password: string): string {
  if (buf.subarray(0, MAGIC.length).toString() !== MAGIC) return buf.toString('utf8') // plain JSON export
  let o = MAGIC.length
  const salt = buf.subarray(o, (o += 16))
  const iv = buf.subarray(o, (o += 12))
  const tag = buf.subarray(o, (o += 16))
  const d = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv)
  d.setAuthTag(tag)
  try {
    return Buffer.concat([d.update(buf.subarray(o)), d.final()]).toString('utf8')
  } catch {
    throw new Error('Wrong file password')
  }
}

register({
  'conn.toUrl': (_c, id: string) => connectionToUrl(getConnection(id), secretsOf(id)),
  'conn.isEncryptedFile': (_c, path: string) => readFileSync(path).subarray(0, MAGIC.length).toString() === MAGIC,
  /** scope: ids to export. Key files are never embedded; their paths are dropped. */
  'conn.exportFile': (_c, path: string, ids: string[], opts: { dbPasswords: boolean; sshPasswords: boolean; password: string }) => {
    const conns = listConnections().filter((c) => ids.includes(c.id)).map((c) => {
      const s = secretsOf(c.id)
      return { ...c, password: opts.dbPasswords ? s.password : undefined, sshPassword: opts.sshPasswords ? s.sshPassword : undefined, ssh: c.ssh ? { ...c.ssh, keyPath: undefined } : undefined, ssl: c.ssl ? { mode: c.ssl.mode } : undefined }
    })
    const groupIds = new Set(conns.map((c) => c.groupId).filter(Boolean))
    const groups = listGroups().filter((g) => groupIds.has(g.id))
    const json = JSON.stringify({ app: 'Lagoon', version: 1, groups, connections: conns })
    writeFileSync(path, opts.password ? seal(json, opts.password) : Buffer.from(json))
    return conns.length
  },
  'conn.importFile': (_c, path: string, password = '') => {
    const data = JSON.parse(open(readFileSync(path), password)) as { groups: Group[]; connections: Connection[] }
    const gmap = new Map<string, string>()
    for (const g of data.groups ?? []) {
      const before = new Set(listGroups().map((x) => x.id))
      const after = saveGroup({ name: g.name, icon: g.icon })
      gmap.set(g.id, after.find((x) => !before.has(x.id))!.id)
    }
    for (const c of data.connections ?? []) saveConnection({ ...c, id: '', groupId: c.groupId ? gmap.get(c.groupId) ?? null : null })
    return (data.connections ?? []).length
  },
  /** The app's own connections file if it is where the app keeps it by default. */
  'conn.foreignDefault': (_c, app: ForeignApp) => { const p = defaultPath(app); return p && existsSync(p) ? p : undefined },
  /** Import connections saved by TablePlus, DBeaver or Navicat; ones that already exist here are left out. */
  'conn.importForeign': (_c, app: ForeignApp, path: string) => {
    const raw = readFileSync(path)
    // TablePlus may keep a binary plist; macOS converts it
    const text = raw.subarray(0, 6).toString() === 'bplist' ? execFileSync('plutil', ['-convert', 'xml1', '-o', '-', path]).toString('utf8') : raw.toString('utf8')
    const creds = join(dirname(path), 'credentials-config.json')
    const parsed = app === 'tableplus' ? fromTablePlus(text) : app === 'dbeaver' ? fromDbeaver(text, existsSync(creds) ? readFileSync(creds) : undefined) : fromNavicat(text)
    const r = withoutDuplicates(parsed, listConnections())
    const groups = new Map(listGroups().map((g) => [g.name, g.id]))
    for (const { group, ...c } of r.connections) {
      if (group && !groups.has(group)) {
        const before = new Set(listGroups().map((g) => g.id))
        groups.set(group, saveGroup({ name: group }).find((g) => !before.has(g.id))!.id)
      }
      saveConnection({ ...c, id: '', groupId: group ? groups.get(group) ?? null : null })
    }
    return { imported: r.connections.length, duplicates: r.duplicates, skipped: r.skipped }
  }
})
