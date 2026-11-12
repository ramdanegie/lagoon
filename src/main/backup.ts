// Backup / restore through the engines' own CLI tools (pg_dump, pg_restore, psql, mysqldump, mysql), plus tool detection.
import { spawn, execFile } from 'child_process'
import { existsSync, readdirSync, realpathSync, createReadStream, createWriteStream, openSync, readSync, closeSync, rmSync, statSync } from 'fs'
import { join, dirname, delimiter, basename } from 'path'
import { createGzip, createGunzip } from 'zlib'
import { pipeline } from 'stream/promises'
import type { Connection } from '@shared/types'
import { DRIVERS } from '@shared/types'
import { toolArgs } from '@shared/importexport'
import { register } from './rpc'
import { buildDriver, openTunnel, resolvePassword } from './sessions'
import { getConnection, secretsOf } from './store'
import type { SqlDriver } from './drivers/types'
import { startJob, checkPath, isApproved, type JobCtl } from './jobs'

type Family = 'pg' | 'my'
interface Asked { password?: string; sshPassword?: string }

const familyOf = (c: Connection): Family => {
  if (c.driver === 'postgres') return 'pg'
  if (c.driver === 'mysql' || c.driver === 'mariadb') return 'my'
  const name = DRIVERS.find((d) => d.id === c.driver)?.name ?? c.driver
  throw new Error(`Backup and restore are not supported for ${name}.${c.driver === 'sqlite' ? ' Copy the database file, or export it to SQL instead.' : ''}`)
}

const BIN: Record<Family, { dump: string[]; restore: string[]; plain: string[] }> = {
  pg: { dump: ['pg_dump'], restore: ['pg_restore'], plain: ['psql'] },
  my: { dump: ['mysqldump', 'mariadb-dump'], restore: ['mysql', 'mariadb'], plain: [] }
}
const exe = (dir: string, names: string[]): string | undefined =>
  names.map((n) => join(dir, process.platform === 'win32' ? `${n}.exe` : n)).find((p) => existsSync(p))

function searchDirs(): string[] {
  const sub = (parent: string, prefix: string): string[] => {
    try { return readdirSync(parent).filter((n) => n.startsWith(prefix)).map((n) => join(parent, n, 'bin')) } catch { return [] }
  }
  // apps started from Finder get a bare PATH, so the usual install locations are searched too
  return [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', ...sub('/opt/homebrew/opt', 'postgresql'), ...sub('/opt/homebrew/opt', 'libpq'),
    ...sub('/opt/homebrew/opt', 'mysql'), ...sub('/opt/homebrew/opt', 'mariadb'), '/usr/local/bin', ...sub('/Applications/Postgres.app/Contents/Versions', '')].filter(Boolean)
}

const known = new Set<string>() // dump binaries found by detection
const version = (p: string): Promise<string> =>
  new Promise((r) => execFile(p, ['--version'], { timeout: 5000 }, (e, out) => r(e ? '' : String(out).trim())))

export async function findTools(f: Family): Promise<{ path: string; version: string }[]> {
  const seen = new Set<string>()
  const out: { path: string; version: string }[] = []
  for (const dir of searchDirs()) {
    const p = exe(dir, BIN[f].dump)
    if (!p) continue
    let real: string
    try { real = realpathSync(p) } catch { continue }
    if (seen.has(real)) continue
    seen.add(real)
    const v = await version(p)
    if (v) { known.add(p); out.push({ path: p, version: v }) }
  }
  // newest first: a dump tool must be at least as new as the server
  return out.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
}

/** Same rules as opening a session (sessions.ts keeps its resolver private). */
const passwordOf = resolvePassword
const sshPasswordOf = (c: Connection, asked?: Asked): string | undefined => (c.ssh?.passwordMode === 'ask' ? asked?.sshPassword : secretsOf(c.id).sshPassword)

/** A short-lived driver for listing / creating databases from the Welcome window. */
async function withDriver<T>(id: string, asked: Asked | undefined, fn: (d: SqlDriver) => Promise<T>): Promise<T> {
  const c = getConnection(id)
  familyOf(c)
  const { driver, tunnel } = await buildDriver(c, { password: passwordOf(c, asked?.password), sshPassword: sshPasswordOf(c, asked), sshPassphrase: secretsOf(id).sshPassphrase })
  try {
    return await fn(driver as SqlDriver)
  } finally {
    await driver.close().catch(() => {})
    tunnel?.server.close()
    tunnel?.ssh.end()
  }
}

const PG_SSL: Record<string, string> = { DISABLED: 'disable', ALLOW: 'allow', PREFERRED: 'prefer', REQUIRED: 'require', 'VERIFY-CA': 'verify-ca', 'VERIFY-FULL': 'verify-full' }

const size = (n: number): string => (n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`)

export interface ToolRun { connectionId: string; database: string; tool: string; options: string; file: string; gzip?: boolean; asked?: Asked }

/** Spawn the tool with the password in env, stream its output to the job log, honour Stop. */
export async function runTool(j: JobCtl, o: ToolRun, mode: 'backup' | 'restore'): Promise<{ message: string; output?: string }> {
  const c = getConnection(o.connectionId)
  const f = familyOf(c)
  const pw = passwordOf(c, o.asked?.password)
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (f === 'pg') {
    if (pw !== undefined) env.PGPASSWORD = pw
    if (c.ssl?.mode) env.PGSSLMODE = PG_SSL[c.ssl.mode] ?? 'prefer'
    if (c.ssl?.caPath) env.PGSSLROOTCERT = c.ssl.caPath
    if (c.ssl?.certPath) env.PGSSLCERT = c.ssl.certPath
    if (c.ssl?.keyPath) env.PGSSLKEY = c.ssl.keyPath
    env.PGCONNECT_TIMEOUT = '20'
  } else if (pw !== undefined) env.MYSQL_PWD = pw

  const tunnel = c.ssh?.enabled ? await openTunnel(c, sshPasswordOf(c, o.asked), secretsOf(c.id).sshPassphrase) : undefined
  const tail: string[] = []
  const log = (s: string): void => { j.log(s); tail.push(...s.split('\n').filter((l) => l.trim())); tail.splice(0, Math.max(0, tail.length - 5)) }
  let timer: NodeJS.Timeout | undefined
  try {
    const target = { host: tunnel ? '127.0.0.1' : c.host || '127.0.0.1', port: tunnel?.port ?? c.port ?? (f === 'pg' ? 5432 : 3306), user: c.username, database: o.database }
    const dir = dirname(o.tool)
    let bin: string
    let args: string[]
    let input: { gz: boolean } | undefined // restore input piped into stdin
    if (mode === 'backup') {
      bin = o.tool
      args = toolArgs(f === 'pg' ? 'pg_dump' : 'mysqldump', target, o.options)
    } else {
      const head = Buffer.alloc(5)
      const fd = openSync(o.file, 'r')
      readSync(fd, head, 0, 5, 0)
      closeSync(fd)
      const gz = head[0] === 0x1f && head[1] === 0x8b
      if (f === 'pg' && head.toString('latin1') === 'PGDMP') {
        bin = exe(dir, BIN.pg.restore) ?? ''
        args = [...toolArgs('pg_restore', target, o.options), o.file]
      } else {
        bin = exe(dir, f === 'pg' ? BIN.pg.plain : BIN.my.restore) ?? ''
        if (f === 'pg' && !bin) throw new Error('This is a plain SQL file, which pg_restore cannot read, and psql was not found next to the selected tool. Use Import ▸ From SQL Dump instead.')
        if (f === 'pg') log('Plain SQL file: running it with psql.\n')
        args = toolArgs(f === 'pg' ? 'psql' : 'mysql', target, o.options)
        input = { gz }
      }
      if (!bin) throw new Error(`${f === 'pg' ? 'pg_restore' : 'mysql'} was not found next to ${o.tool}.`)
    }
    log(`$ ${basename(bin)} ${args.join(' ')}\n`)
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    j.onCancel = () => child.kill()
    child.stderr.on('data', (b: Buffer) => log(b.toString()))
    const exited = new Promise<number | null>((res, rej) => { child.on('error', rej); child.on('close', res) })
    let io: Promise<void>
    if (mode === 'backup') {
      const out = createWriteStream(o.file)
      timer = setInterval(() => j.progress(0, `${size(out.bytesWritten)} written`), 1000)
      io = o.gzip ? pipeline(child.stdout, createGzip(), out) : pipeline(child.stdout, out)
    } else {
      child.stdout.on('data', (b: Buffer) => log(b.toString()))
      if (input) {
        const size = statSync(o.file).size || 1
        const rs = createReadStream(o.file)
        timer = setInterval(() => j.progress(rs.bytesRead / size, `${Math.round((100 * rs.bytesRead) / size)}% read`), 500)
        io = input.gz ? pipeline(rs, createGunzip(), child.stdin) : pipeline(rs, child.stdin)
      } else {
        child.stdin.end()
        io = Promise.resolve()
      }
    }
    io.catch(() => child.kill()) // disk full, unreadable file…
    const code = await exited
    if (j.cancelled) throw new Error('Cancelled')
    if (code !== 0) throw new Error(tail.at(-1) ?? `${basename(bin)} exited with code ${code}`)
    await io
    if (mode === 'backup') return { message: `Saved ${basename(o.file)} (${size(statSync(o.file).size)})`, output: o.file }
    return { message: `Restored ${basename(o.file)} into ${o.database}` }
  } catch (e) {
    if (mode === 'backup') rmSync(o.file, { force: true }) // never leave a truncated backup behind
    throw e
  } finally {
    clearInterval(timer)
    tunnel?.server.close()
    tunnel?.ssh.end()
  }
}

function checkTool(id: string, tool: string): void {
  const o = getConnection(id).options
  if (!known.has(tool) && !isApproved(tool) && tool !== o?.pgDumpPath && tool !== o?.mysqldumpPath) throw new Error('Pick a dump tool from the list first.')
  if (!existsSync(tool)) throw new Error(`Tool not found: ${tool}`)
}

register({
  'backup.tools': (_c, driver: Connection['driver']) => findTools(driver === 'postgres' ? 'pg' : 'my'),
  /** A tool the user picked with "Choose…": must have come through the file picker. */
  'backup.addTool': async (_c, path: string) => {
    checkPath(path)
    const v = await version(path)
    if (!v) throw new Error(`${basename(path)} did not answer --version; pick pg_dump or mysqldump.`)
    known.add(path)
    return { path, version: v }
  },
  'backup.databases': (_c, id: string, asked?: Asked) => withDriver(id, asked, (d) => d.databases()),
  'backup.createDatabase': (_c, id: string, name: string, asked?: Asked) => withDriver(id, asked, (d) => d.createDatabase(name)),
  'backup.run': (c, o: ToolRun) => {
    checkPath(o.file)
    checkTool(o.connectionId, o.tool)
    return startJob(c.sender, 'backup', `Backup ${o.database}`, (j) => runTool(j, o, 'backup'))
  },
  'restore.run': (c, o: ToolRun) => {
    checkPath(o.file)
    checkTool(o.connectionId, o.tool)
    return startJob(c.sender, 'restore', `Restore into ${o.database}`, (j) => runTool(j, o, 'restore'))
  },
  /** Safe mode in the Welcome window (no session yet): compare with the stored password. */
  'conn.checkStoredPassword': (_c, id: string, pw: string) => (secretsOf(id).password ?? '') === pw
})
