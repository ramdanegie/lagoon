// Read saved connections from other database apps so they can be imported. Pure parsing (no Electron) so tests can load it.
import { createDecipheriv } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import type { Connection, DriverId } from '@shared/types'

export type ForeignApp = 'tableplus' | 'dbeaver' | 'navicat'
export type Imported = Omit<Connection, 'id'> & { group?: string }
export interface ForeignResult { connections: Imported[]; skipped: string[] }

/** Where each app keeps its connections by default (Navicat only exports them, as a .ncx file). */
export function defaultPath(app: ForeignApp, platform = process.platform, home = homedir(), appData = process.env.APPDATA ?? ''): string | undefined {
  if (app === 'tableplus') return platform === 'darwin' ? join(home, 'Library/Application Support/com.tinyapp.TablePlus/Data/Connections.plist') : undefined
  if (app === 'dbeaver') {
    const base = platform === 'darwin' ? join(home, 'Library/DBeaverData') : platform === 'win32' ? join(appData, 'DBeaverData') : join(home, '.local/share/DBeaverData')
    return join(base, 'workspace6/General/.dbeaver/data-sources.json')
  }
  return undefined
}

const ent = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) =>
    ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e.toLowerCase() as 'lt'] ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)))

/** Minimal XML property list reader: dict, array, key, string, integer, real, true, false (date/data become strings). */
export function parsePlist(xml: string): unknown {
  const stack: (Record<string, unknown> | unknown[])[] = []
  const keys: (string | undefined)[] = []
  let root: unknown
  let key: string | undefined
  const put = (v: unknown): void => {
    const top = stack[stack.length - 1]
    if (!top) root = v
    else if (Array.isArray(top)) top.push(v)
    else if (key !== undefined) { top[key] = v; key = undefined }
  }
  for (const [, close, tag, self, text] of xml.matchAll(/<(\/?)(dict|array|key|string|integer|real|true|false|date|data)\s*(\/?)>([^<]*)/g)) {
    if (tag === 'dict' || tag === 'array') {
      if (close) { const v = stack.pop(); key = keys.pop(); put(v) }
      else if (self) put(tag === 'dict' ? {} : [])
      else { keys.push(key); key = undefined; stack.push(tag === 'dict' ? {} : []) }
    } else if (close) continue
    else if (tag === 'key') key = ent(text)
    else if (tag === 'true' || tag === 'false') put(tag === 'true')
    else if (tag === 'integer' || tag === 'real') put(Number(text.trim()))
    else put(self ? '' : ent(text))
  }
  return root
}

const port = (v: unknown): number | undefined => (v === undefined || v === '' || v === null || isNaN(Number(v)) ? undefined : Number(v))
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const sameAs = (a: Imported, b: Pick<Connection, 'driver' | 'host' | 'port' | 'username' | 'database' | 'filePath'>): boolean =>
  a.driver === b.driver && (a.host ?? '') === (b.host ?? '') && (a.port ?? 0) === (b.port ?? 0) && (a.username ?? '') === (b.username ?? '') && (a.database ?? '') === (b.database ?? '') && (a.filePath ?? '') === (b.filePath ?? '')

/** Drop connections that already exist (same driver, host, port, user, database or file). */
export function withoutDuplicates(r: ForeignResult, existing: Connection[]): ForeignResult & { duplicates: number } {
  const connections = r.connections.filter((c) => !existing.some((e) => sameAs(c, e)))
  return { ...r, connections, duplicates: r.connections.length - connections.length }
}

// ---------- TablePlus (macOS Connections.plist; passwords stay in the Keychain) ----------
const TP_DRIVERS: Record<string, DriverId> = { PostgreSQL: 'postgres', MySQL: 'mysql', MariaDB: 'mariadb', SQLite: 'sqlite', Redis: 'redis', MongoDB: 'mongodb' }

export function fromTablePlus(xml: string): ForeignResult {
  const list = parsePlist(xml)
  if (!Array.isArray(list)) throw new Error('Not a TablePlus connections file')
  const out: ForeignResult = { connections: [], skipped: [] }
  for (const c of list as Record<string, unknown>[]) {
    const name = str(c.ConnectionName) ?? 'Untitled'
    const driver = TP_DRIVERS[String(c.Driver)]
    if (!driver) { out.skipped.push(`${name} (${String(c.Driver)} is not supported)`); continue }
    const user = str(c.DatabaseUser)
    const ssh = c.isOverSSH === true
    out.connections.push({
      name, driver,
      host: driver === 'sqlite' ? undefined : str(c.DatabaseHost),
      port: driver === 'sqlite' ? undefined : port(c.DatabasePort),
      username: user,
      database: driver === 'sqlite' ? undefined : str(c.DatabaseName),
      filePath: driver === 'sqlite' ? str(c.DatabasePath) : undefined,
      passwordMode: user || driver === 'redis' ? 'ask' : 'none',
      statusColor: /^#[0-9a-f]{6}$/i.test(String(c.statusColor)) ? String(c.statusColor) : undefined,
      safeMode: c.Enviroment === 'production' ? 1 : 0,
      ssh: ssh ? { enabled: true, host: str(c.ServerAddress) ?? '', port: port(c.ServerPort) ?? 22, user: str(c.ServerUser) ?? '', useKey: c.isUsePrivateKey === true, keyPath: c.isUsePrivateKey === true ? str(c.ServerPrivateKeyName) : undefined, passwordMode: c.isUsePrivateKey === true ? 'none' : 'ask' } : undefined
    })
  }
  return out
}

// ---------- DBeaver (data-sources.json + credentials-config.json) ----------
// DBeaver encrypts saved credentials with a fixed, publicly documented key; this only reads the user's own file.
const DBEAVER_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex')

export function decryptDbeaverCredentials(buf: Buffer): Record<string, Record<string, { user?: string; password?: string }>> {
  const d = createDecipheriv('aes-128-cbc', DBEAVER_KEY, buf.subarray(0, 16))
  return JSON.parse(Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString('utf8'))
}

const DB_PROVIDERS: Record<string, DriverId> = { postgresql: 'postgres', mysql: 'mysql', mariadb: 'mariadb', sqlite: 'sqlite', redis: 'redis', mongodb: 'mongodb' }

export function fromDbeaver(json: string, credentials?: Buffer): ForeignResult {
  const data = JSON.parse(json) as { connections?: Record<string, { provider: string; driver?: string; name?: string; folder?: string; 'save-password'?: boolean; configuration?: Record<string, unknown> & { handlers?: Record<string, { enabled?: boolean; properties?: Record<string, string> }> } }> }
  if (!data.connections) throw new Error('Not a DBeaver data-sources.json file')
  let creds: ReturnType<typeof decryptDbeaverCredentials> = {}
  try { if (credentials?.length) creds = decryptDbeaverCredentials(credentials) } catch { /* unreadable: import without passwords */ }
  const out: ForeignResult = { connections: [], skipped: [] }
  for (const [id, c] of Object.entries(data.connections)) {
    const name = c.name ?? id
    let driver = DB_PROVIDERS[c.provider]
    if (driver === 'mysql' && /maria/i.test(c.driver ?? '')) driver = 'mariadb'
    if (!driver) { out.skipped.push(`${name} (${c.provider} is not supported)`); continue }
    const cfg = c.configuration ?? {}
    // connections set up by URL keep host/port/database only in the JDBC URL
    const url = /\/\/([^:/?]+)(?::(\d+))?\/?([^?;]*)/.exec(String(cfg.url ?? '')) ?? []
    const sqlitePath = str(cfg.database) ?? String(cfg.url ?? '').replace(/^jdbc:sqlite:/, '')
    const cr = creds[id]?.['#connection'] ?? {}
    const sshCr = creds[id]?.['network/ssh_tunnel'] ?? {}
    const tunnel = cfg.handlers?.ssh_tunnel
    const sp = tunnel?.properties ?? {}
    const keyAuth = sp.authType === 'PUBLIC_KEY'
    out.connections.push({
      name, driver,
      host: driver === 'sqlite' ? undefined : str(cfg.host) ?? url[1],
      port: driver === 'sqlite' ? undefined : port(cfg.port) ?? port(url[2]),
      username: str(cr.user) ?? str(cfg.user),
      database: driver === 'sqlite' ? undefined : str(cfg.database) ?? str(url[3]),
      filePath: driver === 'sqlite' ? str(sqlitePath) : undefined,
      password: str(cr.password),
      passwordMode: str(cr.password) ? 'store' : c['save-password'] === false || str(cr.user) || str(cfg.user) ? 'ask' : 'none',
      safeMode: cfg.type === 'prod' ? 1 : 0,
      group: str(c.folder),
      ssh: tunnel?.enabled ? { enabled: true, host: sp.host ?? '', port: port(sp.port) ?? 22, user: str(sshCr.user) ?? '', useKey: keyAuth, keyPath: keyAuth ? str(sp.keyPath) : undefined, passwordMode: keyAuth ? 'none' : str(sshCr.password) ? 'store' : 'ask' } : undefined,
      sshPassword: keyAuth ? undefined : str(sshCr.password)
    })
  }
  return out
}

// ---------- Navicat (.ncx export) ----------
// Navicat 12+ exports passwords AES-encrypted with a fixed, publicly documented key; older exports are left out.
export function decryptNavicat(hex: string): string | undefined {
  if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length % 32) return undefined
  try {
    const d = createDecipheriv('aes-128-cbc', Buffer.from('libcckeylibcckey'), Buffer.from('libcciv libcciv '))
    return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

const NCX_DRIVERS: Record<string, DriverId> = { POSTGRESQL: 'postgres', MYSQL: 'mysql', MARIADB: 'mariadb', SQLITE: 'sqlite', REDIS: 'redis', MONGODB: 'mongodb' }

export function fromNavicat(xml: string): ForeignResult {
  if (!/<Connections[\s>]/.test(xml)) throw new Error('Not a Navicat connections (.ncx) file')
  const out: ForeignResult = { connections: [], skipped: [] }
  for (const [, attrs] of xml.matchAll(/<Connection\s([^>]*?)\/?>/g)) {
    const a: Record<string, string> = {}
    for (const [, k, v] of attrs.matchAll(/([\w:]+)="([^"]*)"/g)) a[k] = ent(v)
    const name = a.ConnectionName || 'Untitled'
    const driver = NCX_DRIVERS[(a.ConnType ?? '').toUpperCase()]
    if (!driver) { out.skipped.push(`${name} (${a.ConnType} is not supported)`); continue }
    const password = a.SavePassword === 'false' ? undefined : decryptNavicat(a.Password)
    const ssh = a.SSH === 'true'
    const keyAuth = a.SSH_AuthenMethod === 'PUBLICKEY'
    const sshPassword = ssh && !keyAuth ? decryptNavicat(a.SSH_Password) : undefined
    out.connections.push({
      name, driver,
      host: driver === 'sqlite' ? undefined : str(a.Host),
      port: driver === 'sqlite' ? undefined : port(a.Port),
      username: str(a.UserName),
      database: driver === 'sqlite' ? undefined : str(a.Database) ?? str(a.InitialDatabase),
      filePath: driver === 'sqlite' ? str(a.DatabaseFileName) : undefined,
      password,
      passwordMode: password ? 'store' : str(a.UserName) ? 'ask' : 'none',
      safeMode: 0,
      ssl: a.SSL === 'true' ? { mode: 'REQUIRED' } : undefined,
      ssh: ssh ? { enabled: true, host: a.SSH_Host ?? '', port: port(a.SSH_Port) ?? 22, user: a.SSH_UserName ?? '', useKey: keyAuth, keyPath: keyAuth ? str(a.SSH_PrivateKey) : undefined, passwordMode: keyAuth ? 'none' : sshPassword ? 'store' : 'ask' } : undefined,
      sshPassword
    })
  }
  return out
}
