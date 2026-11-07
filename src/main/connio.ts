// Export / import connections as an encrypted file, and Copy as URL (needs the stored secrets).
import { readFileSync, writeFileSync } from 'fs'
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'
import type { Connection, Group } from '@shared/types'
import { connectionToUrl } from '@shared/url'
import { register } from './rpc'
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
  }
})
