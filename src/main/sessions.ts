// Open connections: password resolution, SSH tunnel, driver construction, console logging, keep-alive.
import { Client as SshClient } from 'ssh2'
import { createServer, type Server, type AddressInfo } from 'net'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import type { WebContents } from 'electron'
import type { Connection, ServerInfo } from '@shared/types'
import { DRIVERS } from '@shared/types'
import { getConnection, secretsOf, getSetting, setSetting } from './store'
import type { ConnectParams, SqlDriver } from './drivers/types'
import { PostgresDriver } from './drivers/postgres'
import { MysqlDriver } from './drivers/mysql'
import { SqliteDriver } from './drivers/sqlite'
import { RedisDriver } from './drivers/redis'
import { MongoDriver } from './drivers/mongo'

export type AnyDriver = (SqlDriver & { onSql: (s: string) => void }) | RedisDriver | MongoDriver

export interface Session {
  id: string
  conn: Connection
  driver: AnyDriver
  tunnel?: { ssh: SshClient; server: Server }
  owner?: WebContents
  password?: string
  keepAlive?: NodeJS.Timeout
}

const sessions = new Map<string, Session>()

export function session(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new Error('This connection is closed. Reconnect to continue.')
  return s
}

export const sqlDriver = (id: string): SqlDriver => {
  const d = session(id).driver
  if (!('dialect' in d)) throw new Error('Not a SQL connection')
  return d
}

const expandHome = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

/** Minimal ~/.ssh/config lookup: HostName, User, Port, IdentityFile for a matching Host line. */
function sshConfigFor(host: string): { hostName?: string; user?: string; port?: number; identityFile?: string } {
  const f = join(homedir(), '.ssh', 'config')
  if (!existsSync(f)) return {}
  const out: Record<string, string> = {}
  let match = false
  for (const raw of readFileSync(f, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [k, ...rest] = line.split(/\s+/)
    const v = rest.join(' ')
    if (/^host$/i.test(k)) { match = v.split(/\s+/).some((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(host)); continue }
    if (match && !out[k.toLowerCase()]) out[k.toLowerCase()] = v
  }
  return { hostName: out.hostname, user: out.user, port: out.port ? Number(out.port) : undefined, identityFile: out.identityfile ? expandHome(out.identityfile) : undefined }
}

function defaultKey(): string | undefined {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((k) => join(homedir(), '.ssh', k)).find(existsSync)
}

export async function openTunnel(c: Connection, sshPassword?: string, passphrase?: string): Promise<{ ssh: SshClient; server: Server; port: number }> {
  const s = c.ssh!
  const cfg = sshConfigFor(s.host)
  const keyPath = s.useKey ? (s.keyPath ? expandHome(s.keyPath) : cfg.identityFile ?? defaultKey()) : undefined
  const ssh = new SshClient()
  const hostKeyId = `ssh.knownHost.${s.host}:${s.port || 22}`
  await new Promise<void>((resolve, reject) => {
    ssh.once('ready', () => resolve()).once('error', reject).connect({
      host: cfg.hostName ?? s.host,
      port: s.port || cfg.port || 22,
      username: s.user || cfg.user,
      password: s.useKey ? undefined : sshPassword,
      privateKey: keyPath ? readFileSync(keyPath) : undefined,
      passphrase: passphrase || undefined,
      agent: s.useKey ? process.env.SSH_AUTH_SOCK : undefined,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      // trust on first use: remember the host key fingerprint, refuse if it changes later
      hostVerifier: (key: Buffer) => {
        const fp = 'SHA256:' + createHash('sha256').update(key).digest('base64')
        const known = getSetting<string | null>(hostKeyId, null)
        if (!known) { setSetting(hostKeyId, fp); return true }
        return known === fp
      }
    })
  }).catch((e) => {
    throw new Error(/host.*verif|handshake/i.test(String(e)) ? `SSH host key for ${s.host} changed (possible man-in-the-middle). Remove "${hostKeyId}" in settings if the change is expected.` : `SSH: ${e.message}`)
  })
  const dstHost = c.host || '127.0.0.1'
  const dstPort = c.port || DRIVERS.find((d) => d.id === c.driver)?.port || 0
  const server = createServer((sock) => {
    ssh.forwardOut('127.0.0.1', sock.remotePort ?? 0, dstHost, dstPort, (err, stream) => {
      if (err) { sock.destroy(err); return }
      sock.pipe(stream).pipe(sock)
      sock.on('error', () => stream.destroy())
      stream.on('error', () => sock.destroy())
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { ssh, server, port: (server.address() as AddressInfo).port }
}

export function resolvePassword(c: Connection, asked?: string): string | undefined {
  if (c.passwordMode === 'none') return undefined
  if (c.passwordMode === 'ask') return asked
  if (c.passwordMode === 'command' && c.passwordCommand) return execSync(c.passwordCommand, { encoding: 'utf8', timeout: 30000 }).trim()
  return secretsOf(c.id).password
}

const readFile = (p?: string): string | undefined => (p ? readFileSync(expandHome(p), 'utf8') : undefined)

/** Build a driver for a connection. Used by session.open and by conn.test (with unsaved form values). */
export async function buildDriver(c: Connection, secrets: { password?: string; sshPassword?: string; sshPassphrase?: string }): Promise<{ driver: AnyDriver; tunnel?: { ssh: SshClient; server: Server } }> {
  let host = c.host || '127.0.0.1'
  let port = c.port || DRIVERS.find((d) => d.id === c.driver)?.port || 0
  let tunnel: { ssh: SshClient; server: Server } | undefined
  if (c.ssh?.enabled && c.driver !== 'sqlite') {
    const t = await openTunnel(c, secrets.sshPassword, secrets.sshPassphrase)
    tunnel = { ssh: t.ssh, server: t.server }
    host = '127.0.0.1'
    port = t.port
  }
  const p: ConnectParams = {
    host, port, user: c.username, password: secrets.password, database: c.database, filePath: c.filePath,
    ssl: c.ssl && c.ssl.mode ? { mode: c.ssl.mode, ca: readFile(c.ssl.caPath), cert: readFile(c.ssl.certPath), key: readFile(c.ssl.keyPath) } : undefined
  }
  const driver: AnyDriver =
    c.driver === 'postgres' ? new PostgresDriver(p)
      : c.driver === 'mysql' || c.driver === 'mariadb' ? new MysqlDriver(p)
        : c.driver === 'sqlite' ? new SqliteDriver(p)
          : c.driver === 'redis' ? new RedisDriver(p)
            : new MongoDriver(p, /^mongodb(\+srv)?:\/\//.test(c.host ?? '') ? c.host : undefined)
  try {
    await driver.connect()
  } catch (e) {
    tunnel?.server.close()
    tunnel?.ssh.end()
    throw e
  }
  return { driver, tunnel }
}

export async function openSession(connectionId: string, owner: WebContents | undefined, asked?: { password?: string; sshPassword?: string }, override?: Partial<Connection>): Promise<{ sessionId: string; info: ServerInfo }> {
  const conn = { ...getConnection(connectionId), ...override }
  const stored = secretsOf(connectionId)
  const password = resolvePassword(conn, asked?.password)
  const { driver, tunnel } = await buildDriver(conn, { password, sshPassword: conn.ssh?.passwordMode === 'ask' ? asked?.sshPassword : stored.sshPassword, sshPassphrase: stored.sshPassphrase })
  const id = crypto.randomUUID()
  const s: Session = { id, conn, driver, tunnel, owner, password }
  driver.onSql = (sql) => logSql(s, sql)
  sessions.set(id, s)
  if (conn.bootstrapSql && 'dialect' in driver) for (const stmt of conn.bootstrapSql.split(/;\s*\n/).filter((x) => x.trim())) await driver.query(stmt)
  if (getSetting('connections.keepAlive', true)) s.keepAlive = setInterval(() => driver.ping().catch(() => owner?.send('session:lost', id)), 30000)
  owner?.once('destroyed', () => void closeSession(id))
  return { sessionId: id, info: await info(s) }
}

async function info(s: Session): Promise<ServerInfo> {
  const d = s.driver
  if ('dialect' in d) return { version: await d.serverVersion(), dialect: d.dialect, database: d.currentDatabase(), schema: d.defaultSchema() }
  if (d.kind === 'redis') return { version: await d.serverVersion(), database: String(d.db) }
  return { version: await d.serverVersion(), database: d.db }
}

export async function reconnect(id: string): Promise<ServerInfo> {
  const s = session(id)
  await s.driver.close().catch(() => {})
  s.tunnel?.server.close()
  s.tunnel?.ssh.end()
  const db = 'dialect' in s.driver ? s.driver.currentDatabase() : s.driver.db
  const { driver, tunnel } = await buildDriver({ ...s.conn, database: s.conn.driver === 'sqlite' ? s.conn.database : String(db ?? s.conn.database ?? '') }, { ...secretsOf(s.conn.id), password: s.password })
  driver.onSql = (sql) => logSql(s, sql)
  s.driver = driver
  s.tunnel = tunnel
  return info(s)
}

export async function closeSession(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  clearInterval(s.keepAlive)
  await s.driver.close().catch(() => {})
  s.tunnel?.server.close()
  s.tunnel?.ssh.end()
}

export const closeAll = (): Promise<void[]> => Promise.all([...sessions.keys()].map(closeSession))

function logSql(s: Session, sql: string): void {
  if (!s.owner || s.owner.isDestroyed()) return
  s.owner.send('console:log', { at: new Date().toISOString(), sql: sql.length > 20000 ? `-- statement of ${sql.length} characters omitted` : sql })
}

/** Safe-mode password check: compares with the password this session connected with. */
export const checkPassword = (id: string, pw: string): boolean => {
  const s = session(id)
  return (s.password ?? '') === pw
}
