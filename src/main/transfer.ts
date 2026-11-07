// Data Transfer: copy tables (structure and/or rows) to another connection, database or schema, or into a .sql file, as a background job.
// Also hosts the helpers Data Synchronization reuses: private job connections, paged reads and error-tolerant execution.
import { createWriteStream, rmSync } from 'fs'
import { once } from 'events'
import type { Column, Dialect } from '@shared/types'
import { qt, type CellValue } from '@shared/sqlgen'
import { insertManySql } from '@shared/importexport'
import { classify, convertValue, createSql, cursorSelect, fkOrder, isIdentity, mapType, pageSql, resetSequenceSql, type ReadSpec } from '@shared/transfer'
import { register } from './rpc'
import { openSession, closeSession, session, sqlDriver, buildDriver } from './sessions'
import { secretsOf } from './store'
import { startJob, checkPath, type JobCtl } from './jobs'
import type { SqlDriver } from './drivers/types'

// ---------- helpers shared with datasync.ts ----------

/** A private connection cloned from a session (same database), so a job's transaction never mixes with the UI's queries. */
export async function privateDriver(sessionId: string): Promise<{ d: SqlDriver; connId: string; close: () => Promise<void> }> {
  const s = session(sessionId)
  const db = 'dialect' in s.driver ? s.driver.currentDatabase() : undefined
  const { driver, tunnel } = await buildDriver({ ...s.conn, database: s.conn.driver === 'sqlite' ? s.conn.database : db ?? s.conn.database }, { ...secretsOf(s.conn.id), password: s.password })
  const close = async (): Promise<void> => { await driver.close().catch(() => {}); tunnel?.server.close(); tunnel?.ssh.end() }
  if (!('dialect' in driver)) { await close(); throw new Error('Not a SQL connection') }
  // SQLite "databases" are sibling files: follow the file the session switched to
  if (driver.dialect === 'sqlite' && db && driver.currentDatabase() !== db) await driver.useDatabase(db)
  return { d: driver, connId: s.conn.id, close }
}

export const beginSql = (d: Dialect): string => (d === 'mysql' ? 'START TRANSACTION' : 'BEGIN')

/**
 * Table rows in pages. PostgreSQL streams through a cursor in a read-only snapshot; MySQL/SQLite page by key
 * (keyset) when the key columns are selected, else by LIMIT/OFFSET. `ordered`: PG returns rows in key order.
 */
export async function* readPages(d: SqlDriver, q: ReadSpec, size: number, j: JobCtl, ordered = true): AsyncGenerator<unknown[][]> {
  if (d.dialect === 'postgres') {
    const cur = `lg_cur_${Math.random().toString(36).slice(2, 10)}`
    await d.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      await d.query(`DECLARE ${cur} NO SCROLL CURSOR FOR ${cursorSelect(d.dialect, q, ordered)}`)
      for (;;) {
        if (j.cancelled) throw new Error('Cancelled')
        const r = await d.query(`FETCH ${size} FROM ${cur}`)
        if (r.rows.length) yield r.rows
        if (r.rows.length < size) return
      }
    } finally {
      await d.query('ROLLBACK').catch(() => {})
    }
  }
  const keyIdx = q.keys.map((k) => q.cols.indexOf(k.name))
  const keyset = q.keys.length > 0 && keyIdx.every((i) => i >= 0)
  let after: unknown[] | null = null
  for (let offset = 0; ; offset += size) {
    if (j.cancelled) throw new Error('Cancelled')
    const r = await d.query(pageSql(d.dialect, q, after, size, offset))
    if (r.rows.length) yield r.rows
    if (r.rows.length < size) return
    if (keyset) { const last = r.rows[r.rows.length - 1]; after = keyIdx.map((i) => last[i]) }
  }
}

/** Where statements go: a live connection, or a .sql file. */
export interface Sink { dialect: Dialect; file: boolean; run: (sql: string) => Promise<void> }

export const dbSink = (d: SqlDriver): Sink => ({ dialect: d.dialect, file: false, run: async (sql) => void (await d.query(sql)) })

function fileSink(path: string, dialect: Dialect): Sink & { raw: (text: string) => Promise<void>; end: () => Promise<void>; abort: () => void } {
  const out = createWriteStream(path)
  let failed: Error | null = null
  out.on('error', (e) => { failed = e })
  const raw = async (text: string): Promise<void> => {
    if (failed) throw failed
    if (!out.write(text)) await once(out, 'drain')
  }
  return {
    dialect, file: true, raw,
    run: (sql) => raw(sql.replace(/;\s*$/, '') + ';\n'),
    end: () => new Promise((res, rej) => out.end(() => (failed ? rej(failed) : res()))),
    abort: () => { out.destroy(); rmSync(path, { force: true }) } // no half-written files left behind
  }
}

/** Run one statement; returns the error text instead of throwing. `savepoint` keeps an open transaction usable after a failure. */
export async function execSafe(s: Sink, sql: string, savepoint: boolean): Promise<string | null> {
  try {
    if (savepoint) await s.run('SAVEPOINT lg_sp')
    await s.run(sql)
    if (savepoint) await s.run('RELEASE SAVEPOINT lg_sp')
    return null
  } catch (e) {
    if (savepoint) await s.run('ROLLBACK TO SAVEPOINT lg_sp').catch(() => {})
    return (e as Error).message
  }
}

/** Multi-row INSERT; with continue-on-error a failed batch is retried row by row so only the bad rows are skipped. */
async function insertRows(s: Sink, schema: string, table: string, cols: string[], types: string[], rows: CellValue[][], o: { coe: boolean; tx: boolean }, onErr: (msg: string) => void): Promise<number> {
  const sql = (rs: CellValue[][]): string => insertManySql(s.dialect, schema, table, cols, rs, types)
  if (s.file || !o.coe) { await s.run(sql(rows)); return rows.length }
  if (!(await execSafe(s, sql(rows), o.tx))) return rows.length
  let n = 0
  for (const r of rows) {
    const e = await execSafe(s, sql([r]), o.tx)
    if (e) onErr(e)
    else n++
  }
  return n
}

// ---------- transfer ----------
export interface XTable { source: string; kind: string; target: string; create: 'drop' | 'create' | 'existing'; data: boolean; where?: string; columns?: string[] }
export interface XRun {
  source: { sessionId: string; schema: string }
  target: { sessionId: string; schema: string } | { file: string; dialect: Dialect }
  tables: XTable[]
  batch: number
  continueOnError: boolean
  transaction: boolean
  disableFk: boolean
}

const plural = (n: number, w: string): string => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`
const MAX_LOGGED = 20

async function runTransfer(j: JobCtl, o: XRun): Promise<{ message: string; output?: string }> {
  const log = (s: string): void => j.log(s + '\n')
  const src = await privateDriver(o.source.sessionId)
  let dst: Awaited<ReturnType<typeof privateDriver>> | null = null
  let file: ReturnType<typeof fileSink> | null = null
  let ok = false
  try {
    const sd = src.d.dialect
    let sink: Sink
    let tSchema = ''
    if ('file' in o.target) {
      file = fileSink(checkPath(o.target.file), o.target.dialect)
      sink = file
    } else {
      const sameDb = session(o.target.sessionId).conn.id === src.connId && (sd === 'mysql' || sqlDriver(o.target.sessionId).currentDatabase() === src.d.currentDatabase())
      tSchema = o.target.schema
      if (sameDb && tSchema === o.source.schema) {
        const self = o.tables.find((t) => t.target === t.source)
        if (self) throw new Error(`${self.source} would be copied onto itself. Give it another target name or pick another schema.`)
      }
      // one SQLite file, one connection: a second connection would hit "database is locked" while the first writes
      dst = sameDb && sd === 'sqlite' ? null : await privateDriver(o.target.sessionId)
      sink = dbSink(dst?.d ?? src.d)
    }
    const td = sink.dialect
    const target = dst?.d ?? (file ? null : src.d)

    // inspect the source tables
    interface Plan { t: XTable; cols: Column[]; pk: Column[]; parents: string[]; est: number | null }
    const plan = new Map<string, Plan>()
    for (const t of o.tables) {
      const all = await src.d.columns(o.source.schema, t.source)
      if (!all.length) throw new Error(`${t.source} was not found in the source.`)
      const cols = t.columns?.length ? all.filter((c) => t.columns!.includes(c.name)) : all
      const isTable = t.kind === 'table'
      const fks = isTable ? await src.d.foreignKeys(o.source.schema, t.source).catch(() => []) : []
      plan.set(t.source, {
        t, cols: isTable ? cols : cols.map((c) => ({ ...c, pk: false })), pk: isTable ? all.filter((c) => c.pk) : [],
        parents: fks.map((f) => f.refTable), est: t.data ? await src.d.estimateCount(o.source.schema, t.source).catch(() => null) : 0
      })
    }
    const order = fkOrder([...plan.keys()], Object.fromEntries([...plan].map(([k, p]) => [k, p.parents])))
    const existing = new Set(target ? (await target.objects(tSchema)).filter((x) => x.kind === 'table').map((x) => x.name) : [])

    if (file) await file.raw(`-- Lagoon data transfer (${td})\n-- Created: ${new Date().toISOString()}\n\n`)
    if (o.disableFk) {
      if (td === 'mysql') await sink.run('SET FOREIGN_KEY_CHECKS = 0')
      else if (td === 'sqlite') await sink.run('PRAGMA foreign_keys = OFF')
      else if (target) {
        const r = await target.query("SELECT current_setting('is_superuser')")
        if (r.rows[0]?.[0] === 'on') await sink.run('SET session_replication_role = replica')
        else log('Foreign key checks stay on: switching them off on PostgreSQL needs a superuser. Tables load parents first.')
      }
    }

    let errors = 0
    const failed = (what: string, e: unknown): void => {
      if (!o.continueOnError || j.cancelled) throw e
      errors++
      log(`${what}: failed: ${(e as Error).message}`)
    }

    // drops first, child tables before their parents
    for (const name of [...order].reverse()) {
      const p = plan.get(name)!
      if (p.t.create !== 'drop') continue
      try {
        await sink.run(`DROP TABLE IF EXISTS ${qt(td, tSchema, p.t.target)}`)
        existing.delete(p.t.target)
      } catch (e) { failed(p.t.target, e) }
    }

    let total = 0
    for (let idx = 0; idx < order.length; idx++) {
      if (j.cancelled) throw new Error('Cancelled')
      const p = plan.get(order[idx])!
      const tgt = p.t.target
      const label = p.t.source === tgt ? tgt : `${p.t.source} → ${tgt}`
      let inTx = false
      try {
        if (file) await file.raw(`\n-- ${label}\n`)
        if (p.t.create === 'existing' && target && !existing.has(tgt)) throw new Error(`The target table ${tgt} does not exist.`)
        const create = p.t.create === 'drop' || (p.t.create === 'create' && (!!file || !existing.has(tgt)))
        if (create) await sink.run(createSql(sd, td, tSchema, tgt, p.cols, { ifNotExists: p.t.create === 'create' }))

        // insert into the columns both sides have (an existing table may differ)
        let pairs: { s: Column; name: string; type: string }[]
        if (create || !target) pairs = p.cols.map((c) => ({ s: c, name: c.name, type: mapType(c.type, sd, td, c.pk) }))
        else {
          const tc = (await target.columns(tSchema, tgt)).filter((c) => c.extra !== 'generated')
          pairs = p.cols.flatMap((c) => {
            const m = tc.find((x) => x.name === c.name) ?? tc.find((x) => x.name.toLowerCase() === c.name.toLowerCase())
            return m ? [{ s: c, name: m.name, type: m.type }] : []
          })
          const skipped = p.cols.filter((c) => !pairs.some((x) => x.s === c)).map((c) => c.name)
          if (skipped.length) log(`${label}: no target column for ${skipped.join(', ')}; skipped`)
          if (!pairs.length) throw new Error('No matching columns on the target table.')
        }
        if (!p.t.data) { log(`${label}: ${create ? 'table created' : 'nothing to do'} (no rows copied)`); continue }

        const infos = pairs.map((x) => classify(x.type, td))
        const spec: ReadSpec = { schema: o.source.schema, table: p.t.source, cols: pairs.map((x) => x.s.name), keys: p.pk.map((c) => ({ name: c.name, type: c.type, text: classify(c.type, sd).text })), where: p.t.where }
        if (o.transaction) { await sink.run(beginSql(td)); inTx = true }
        let n = 0
        let bad = 0
        const onErr = (msg: string): void => { if (++bad <= MAX_LOGGED) log(`${label}: row skipped: ${msg}`) }
        for await (const rows of readPages(src.d, spec, o.batch, j, false)) {
          const vals = rows.map((r) => r.map((v, i) => convertValue(v, infos[i], td)))
          n += await insertRows(sink, tSchema, tgt, pairs.map((x) => x.name), pairs.map((x) => x.type), vals, { coe: o.continueOnError, tx: inTx }, onErr)
          j.progress((idx + (p.est ? Math.min(1, n / p.est) : 0)) / order.length, `${tgt}: ${n.toLocaleString('en-US')} rows`)
        }
        if (inTx) { await sink.run('COMMIT'); inTx = false }
        if (create && td === 'postgres') for (const c of p.cols) if (isIdentity(c, sd)) await sink.run(resetSequenceSql(tSchema, tgt, c.name))
        total += n
        errors += bad
        log(`${label}: ${plural(n, 'row')} copied${bad ? `, ${plural(bad, 'row')} failed` : ''}`)
      } catch (e) {
        if (inTx && !file) await sink.run('ROLLBACK').catch(() => {})
        failed(label, e)
      }
      j.progress((idx + 1) / order.length)
    }

    if (o.disableFk && file && td !== 'postgres') await sink.run(td === 'mysql' ? 'SET FOREIGN_KEY_CHECKS = 1' : 'PRAGMA foreign_keys = ON')
    if (file) await file.end()
    ok = true
    const message = `Copied ${plural(total, 'row')} into ${plural(order.length, 'table')}${errors ? ` with ${plural(errors, 'error')}` : ''}`
    log(message)
    return { message, output: file && 'file' in o.target ? o.target.file : undefined }
  } finally {
    if (file && !ok) file.abort()
    await src.close()
    await dst?.close()
  }
}

register({
  /**
   * Open a session for a picker in a tool window. No owner: a failing keep-alive here must not mark the
   * workspace's own connection as lost. `from`: reuse that session's password (same connection, password asked once).
   */
  'transfer.open': async (c, connId: string, asked?: { password?: string; sshPassword?: string }, from?: string) => {
    const s = from ? session(from) : undefined
    const r = await openSession(connId, undefined, s && s.conn.id === connId ? { ...asked, password: s.password } : asked)
    c.sender.once('destroyed', () => void closeSession(r.sessionId))
    return r
  },
  'transfer.run': (c, o: XRun) => {
    if (!o.tables?.length) throw new Error('Select at least one table.')
    if ('file' in o.target) checkPath(o.target.file)
    o.batch = Math.max(1, Math.min(50000, Math.floor(Number(o.batch) || 1000)))
    const where = 'file' in o.target ? (o.target.file.split(/[\\/]/).pop() ?? 'file') : `${session(o.target.sessionId).conn.name}`
    const what = o.tables.length === 1 ? o.tables[0].source : plural(o.tables.length, 'table')
    return startJob(c.sender, 'transfer', `Transfer ${what} to ${where}`, (j) => runTransfer(j, o))
  }
})
