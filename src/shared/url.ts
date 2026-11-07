// Connection URLs: driver://user:pass@host:port/db?opts and driver+ssh://sshuser:sshpass@sshhost:sshport/user:pass@host:port/db?opts
import type { Connection, DriverId } from './types'

const SCHEMES: Record<string, DriverId> = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', mariadb: 'mariadb', sqlite: 'sqlite', redis: 'redis', rediss: 'redis', mongodb: 'mongodb', 'mongodb+srv': 'mongodb' }
const SAFE = ['silent', 'alert1', 'alert2', 'safe1', 'safe2']

function hostPart(s: string): { user?: string; password?: string; host?: string; port?: number } {
  const at = s.lastIndexOf('@')
  const cred = at >= 0 ? s.slice(0, at) : ''
  const hp = at >= 0 ? s.slice(at + 1) : s
  const [user, password] = cred ? cred.split(':').map(decodeURIComponent) : []
  const m = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(hp)
  return { user: user || undefined, password: password ?? undefined, host: m?.[1] ? decodeURIComponent(m[1]) : undefined, port: m?.[2] ? Number(m[2]) : undefined }
}

export function parseConnectionUrl(url: string): Partial<Connection> {
  const m = /^([a-z0-9+]+):\/\/(.*)$/i.exec(url.trim())
  if (!m) throw new Error('Not a connection URL. Expected driver://user:password@host:port/database')
  let scheme = m[1].toLowerCase()
  const ssh = scheme.endsWith('+ssh')
  if (ssh) scheme = scheme.slice(0, -4)
  const driver = SCHEMES[scheme]
  if (!driver) throw new Error(`Unsupported driver "${scheme}"`)
  const [pathPart, query = ''] = m[2].split('?')
  const q = new URLSearchParams(query)
  const c: Partial<Connection> = { driver, passwordMode: 'store', safeMode: 0 }
  if (driver === 'sqlite') {
    c.filePath = decodeURIComponent(pathPart.replace(/^\/?/, '/'))
  } else if (scheme === 'mongodb+srv') {
    c.host = url.trim()
  } else {
    let rest = pathPart
    if (ssh) {
      const slash = rest.indexOf('/')
      const s = hostPart(rest.slice(0, slash < 0 ? undefined : slash))
      c.ssh = { enabled: true, host: s.host ?? '', port: s.port ?? 22, user: s.user ?? '', useKey: !s.password, passwordMode: s.password ? 'store' : 'none' }
      c.sshPassword = s.password
      rest = slash < 0 ? '' : rest.slice(slash + 1)
    }
    const slash = rest.indexOf('/')
    const h = hostPart(slash < 0 ? rest : rest.slice(0, slash))
    Object.assign(c, { host: h.host, port: h.port, username: h.user, password: h.password })
    const db = slash < 0 ? '' : decodeURIComponent(rest.slice(slash + 1))
    if (db) c.database = db
    if (scheme === 'rediss') c.ssl = { mode: 'REQUIRED' }
  }
  if (q.get('name')) c.name = q.get('name')!
  if (q.get('statusColor')) c.statusColor = '#' + q.get('statusColor')!.replace(/^#/, '')
  if (q.get('env')) c.tagId = q.get('env')!
  if (q.get('safeMode')) c.safeMode = Math.max(0, SAFE.indexOf(q.get('safeMode')!))
  if (q.get('sslmode')) c.ssl = { mode: q.get('sslmode')!.toUpperCase().replace('_', '-') }
  if (!c.name) c.name = c.host ?? c.filePath?.split('/').pop() ?? driver
  return c
}

export function connectionToUrl(c: Connection, secrets: { password?: string; sshPassword?: string } = {}): string {
  const scheme = c.driver === 'postgres' ? 'postgresql' : c.driver
  const enc = encodeURIComponent
  const q = new URLSearchParams({ name: c.name })
  if (c.statusColor) q.set('statusColor', c.statusColor.replace('#', ''))
  if (c.tagId) q.set('env', c.tagId)
  if (c.safeMode) q.set('safeMode', SAFE[c.safeMode])
  if (c.ssl?.mode) q.set('sslmode', c.ssl.mode.toLowerCase())
  if (c.driver === 'sqlite') return `sqlite://${c.filePath ?? ''}?${q}`
  const cred = c.username ? `${enc(c.username)}${secrets.password ? ':' + enc(secrets.password) : ''}@` : ''
  const target = `${cred}${c.host ?? ''}${c.port ? ':' + c.port : ''}/${enc(c.database ?? '')}`
  if (c.ssh?.enabled) {
    const sc = `${enc(c.ssh.user)}${secrets.sshPassword ? ':' + enc(secrets.sshPassword) : ''}@${c.ssh.host}:${c.ssh.port || 22}`
    return `${scheme}+ssh://${sc}/${target}?${q}`
  }
  return `${scheme}://${target}?${q}`
}
