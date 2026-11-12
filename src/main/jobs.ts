// Background jobs: import (CSV / JSON / SQL dump) and export (CSV / JSON / SQL / Excel). Progress goes to the starting window.
import { BrowserWindow, Notification, dialog, type WebContents } from 'electron'
import { createWriteStream, readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import type { Column, Connection, DbObject, Dialect, JobProgress } from '@shared/types'
import { selectSql, createTableSql, isNumericType, qt, type CellValue } from '@shared/sqlgen'
import { splitStatements } from '@shared/split'
import { parseDelimited, parseJsonRecords, jsonColumns, uniqueNames, csvRow, typedValue, importValue, exportValue, insertManySql, importBatchSql, expandPattern, markupText, exportExt, EXPORT_FORMATS, type Conflict, type CsvOut, type ExportFormat } from '@shared/importexport'
import { masker, type MaskRule } from '@shared/masking'
import { register } from './rpc'
import { session, buildDriver } from './sessions'
import { secretsOf } from './store'
import type { SqlDriver } from './drivers/types'

// ---------- job registry ----------
export interface JobCtl { cancelled: boolean; onCancel?: () => void; progress: (v: number, message?: string) => void; log: (text: string) => void }
const jobs = new Map<string, { p: JobProgress; ctl: JobCtl; sender: WebContents }>()
const LABEL = { running: 'Running', done: 'Finished', failed: 'Failed', cancelled: 'Stopped' }

export function startJob(sender: WebContents, kind: string, title: string, run: (j: JobCtl) => Promise<{ message?: string; output?: string } | void>): string {
  const id = crypto.randomUUID()
  const p: JobProgress = { id, kind, title, progress: 0, state: 'running' }
  let last = 0
  const send = (force = false): void => {
    if (!force && Date.now() - last < 150) return
    last = Date.now()
    if (!sender.isDestroyed()) sender.send('job:progress', { ...p })
  }
  const ctl: JobCtl = {
    cancelled: false,
    progress: (v, message) => { p.progress = Math.max(0, Math.min(1, v)); if (message !== undefined) p.message = message; send() },
    log: (text) => { if (!sender.isDestroyed()) sender.send('job:log', id, text) }
  }
  jobs.set(id, { p, ctl, sender })
  for (const [k, v] of jobs) if (jobs.size > 50 && v.p.state !== 'running') jobs.delete(k)
  send(true)
  void (async () => {
    try {
      const r = await run(ctl)
      Object.assign(p, ctl.cancelled ? { state: 'cancelled', message: 'Stopped by user' } : { state: 'done', progress: 1, ...r })
    } catch (e) {
      Object.assign(p, ctl.cancelled ? { state: 'cancelled', message: 'Stopped by user' } : { state: 'failed', message: (e as Error).message })
    }
    send(true)
    if (!BrowserWindow.getFocusedWindow() && Notification.isSupported()) new Notification({ title: `${p.title} · ${LABEL[p.state]}`, body: p.message ?? '' }).show()
  })()
  return id
}

// Paths the user picked in a native dialog. Jobs only read/write these (a compromised renderer can't aim them elsewhere).
const approved = new Set<string>()
export const isApproved = (p: string): boolean => approved.has(p)
/** For main-side callers only: a path the user picked earlier (saved automation folders). */
export const approve = (p: string): void => void approved.add(p)
export function checkPath(p: string): string {
  if (!approved.has(p)) throw new Error('Choose the file with the file picker first.')
  return p
}

/** A private connection cloned from the workspace session, so a job's transaction never mixes with the UI's queries. */
export async function jobDriver(sessionId: string): Promise<{ d: SqlDriver; close: () => Promise<void> }> {
  const s = session(sessionId)
  const db = 'dialect' in s.driver ? s.driver.currentDatabase() : undefined
  const { driver, tunnel } = await buildDriver({ ...s.conn, database: s.conn.driver === 'sqlite' ? s.conn.database : db ?? s.conn.database }, { ...secretsOf(s.conn.id), password: s.password })
  const close = async (): Promise<void> => { await driver.close().catch(() => {}); tunnel?.server.close(); tunnel?.ssh.end() }
  if (!('dialect' in driver)) { await close(); throw new Error('Not a SQL connection') }
  return { d: driver, close }
}

const decode = (path: string, encoding: string): string => new TextDecoder(encoding || 'utf-8').decode(readFileSync(checkPath(path)))

// ---------- import ----------
interface ImportOpts {
  kind: 'csv' | 'json' | 'sql' | 'xlsx'
  path: string
  sheet?: string // xlsx: worksheet name; default the first
  encoding: string
  delimiter?: string
  quote?: string
  header?: boolean
  schema: string
  table: string
  create?: { name: string; type: string }[] // new table: its columns
  map: (string | null)[] // per source column: destination column, or null to skip
  conflict: Conflict
  keys?: string[] // key columns for update / delete / upsert modes; default: the primary key
}

const BATCH = 500

/** An Excel cell as a plain value: formulas give their result, rich text its text, dates an ISO-like string. */
function excelValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    const iso = v.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
  }
  if (typeof v !== 'object') return v
  const o = v as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown; formula?: unknown }
  if ('formula' in o || 'result' in o) return excelValue(o.result)
  if (o.richText) return o.richText.map((t) => t.text).join('')
  if ('text' in o) return String(o.text)
  if ('error' in o) return null
  return JSON.stringify(v)
}

async function readExcel(o: Pick<ImportOpts, 'path' | 'sheet' | 'header'>, limit?: number): Promise<{ columns: string[]; rows: unknown[][]; sheets: string[] }> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(checkPath(o.path))
  const ws = (o.sheet && wb.getWorksheet(o.sheet)) || wb.worksheets[0]
  if (!ws) throw new Error('This workbook has no sheets.')
  const all: unknown[][] = []
  ws.eachRow((row) => { all.push((row.values as unknown[]).slice(1).map(excelValue)) }) // values are 1-based
  const width = Math.max(0, ...all.slice(0, 1000).map((r) => r.length))
  const pad = (r: unknown[]): unknown[] => Array.from({ length: width }, (_x, i) => r[i] ?? null)
  const columns = uniqueNames(o.header !== false && all[0] ? pad(all[0]).map((v, i) => (v === null || v === '' ? `column_${i + 1}` : String(v))) : Array.from({ length: width }, (_x, i) => `column_${i + 1}`))
  const rows = (o.header !== false ? all.slice(1) : all).map(pad)
  return { columns, rows: limit ? rows.slice(0, limit) : rows, sheets: wb.worksheets.map((w) => w.name) }
}

/** Source rows as arrays plus their column names (CSV header, JSON keys or the sheet's first row). */
async function readSource(o: Pick<ImportOpts, 'kind' | 'path' | 'encoding' | 'delimiter' | 'quote' | 'header' | 'sheet'>, limit?: number): Promise<{ columns: string[]; rows: unknown[][]; sheets?: string[] }> {
  if (o.kind === 'xlsx') return readExcel(o, limit)
  const text = decode(o.path, o.encoding)
  if (o.kind === 'json') {
    const recs = parseJsonRecords(text)
    const columns = jsonColumns(limit ? recs.slice(0, limit) : recs)
    return { columns, rows: (limit ? recs.slice(0, limit) : recs).map((r) => columns.map((c) => r[c] ?? null)) }
  }
  // shortcut: whole file parsed in memory; fine up to a few hundred MB, stream-parse if bigger files matter
  const all = parseDelimited(text, o.delimiter || ',', o.quote ?? '"')
  const width = Math.max(0, ...all.slice(0, 1000).map((r) => r.length))
  const columns = uniqueNames(o.header && all[0] ? all[0] : Array.from({ length: width }, (_x, i) => `column_${i + 1}`))
  const rows = o.header ? all.slice(1) : all
  return { columns, rows: limit ? rows.slice(0, limit) : rows }
}

async function importRows(j: JobCtl, d: SqlDriver, o: ImportOpts): Promise<{ message: string }> {
  const { rows } = await readSource(o)
  const pairs = o.map.flatMap((dst, i) => (dst ? [[i, dst] as const] : []))
  if (!pairs.length) throw new Error('No columns are selected for import.')
  const cols = pairs.map((p) => p[1])
  let types: string[] = cols.map((c) => o.create?.find((x) => x.name === c)?.type ?? '')
  let pk: string[] = []
  if (!o.create) {
    const info = await d.columns(o.schema, o.table)
    types = cols.map((c) => info.find((x) => x.name === c)?.type ?? '')
    pk = info.filter((x) => x.pk).map((x) => x.name)
  }
  const mode: Conflict = o.create ? 'stop' : o.conflict
  const keys = o.keys?.length ? o.keys : pk
  const stmts = (batch: CellValue[][]): string[] => importBatchSql(d.dialect, o.schema, o.table, cols, batch, types, mode, keys)
  void stmts([]) // validates the keys up front, before anything touches the table
  const createSql = o.create && createTableSql(d.dialect, o.schema, o.table, o.create.map((c) => ({ name: c.name, type: c.type, nullable: true, default: null })), [])
  // MySQL DDL commits implicitly, so the table is created before the transaction (and dropped again on failure)
  if (createSql && d.dialect === 'mysql') await d.query(createSql)
  await d.query(d.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN')
  let affected = 0
  try {
    if (createSql && d.dialect !== 'mysql') await d.query(createSql)
    // DELETE rather than TRUNCATE: stays inside the transaction on every engine and works on tables other tables reference
    if (mode === 'truncate') await d.query(`DELETE FROM ${qt(d.dialect, o.schema, o.table)}`)
    for (let i = 0; i < rows.length; i += BATCH) {
      if (j.cancelled) throw new Error('Cancelled')
      const batch = rows.slice(i, i + BATCH).map((r) => pairs.map(([si], k) => importValue(r[si], types[k])))
      await d.query('SAVEPOINT tc_batch')
      try {
        for (const s of stmts(batch)) affected += (await d.query(s)).affected ?? 0
        await d.query('RELEASE SAVEPOINT tc_batch')
      } catch (e) {
        // find the exact row: retry the batch one row at a time
        await d.query('ROLLBACK TO SAVEPOINT tc_batch')
        for (let k = 0; k < batch.length; k++) {
          try { for (const s of stmts([batch[k]])) await d.query(s) } catch (e2) { throw new Error(`Row ${i + k + 1}: ${(e2 as Error).message}`, { cause: e2 }) }
        }
        throw e
      }
      j.progress((i + batch.length) / rows.length, `${i + batch.length} of ${rows.length} rows`)
    }
    await d.query('COMMIT')
  } catch (e) {
    await d.query('ROLLBACK').catch(() => {})
    if (createSql && d.dialect === 'mysql') await d.query(`DROP TABLE ${qt(d.dialect, o.schema, o.table)}`).catch(() => {})
    throw e
  }
  const n = rows.length
  const s = (x: number): string => (x === 1 ? '' : 's')
  if (mode === 'updateOnly') return { message: `Updated ${affected} of ${n} row${s(n)} in ${o.table}` }
  if (mode === 'delete') return { message: `Deleted ${affected} row${s(affected)} from ${o.table}` }
  if (mode === 'skip') return { message: `Imported ${affected} of ${n} row${s(n)} into ${o.table} (${n - affected} already there)` }
  return { message: `Imported ${n} row${s(n)} into ${o.table}` }
}

async function importSqlFile(j: JobCtl, d: SqlDriver, o: ImportOpts): Promise<{ message: string }> {
  const text = decode(o.path, o.encoding)
  const stmts = splitStatements(text, d.dialect)
  for (let i = 0; i < stmts.length; i++) {
    if (j.cancelled) throw new Error('Cancelled')
    const s = stmts[i]
    const line = text.slice(0, s.from).split('\n').length
    if (d.dialect === 'postgres' && (/^COPY\b[\s\S]*\bFROM\s+stdin/i.test(s.sql) || /^\s*\\[a-z]/im.test(s.sql)))
      throw new Error(`Statement ${i + 1} (line ${line}) uses psql-only syntax (COPY … FROM stdin or a backslash command). Restore this file with Restore Database instead.`)
    try { await d.query(s.sql) } catch (e) { throw new Error(`Statement ${i + 1} (line ${line}): ${(e as Error).message}`, { cause: e }) }
    j.progress((i + 1) / stmts.length, `${i + 1} of ${stmts.length} statements`)
  }
  return { message: `Ran ${stmts.length} statement${stmts.length === 1 ? '' : 's'}` }
}

// ---------- export ----------
type Pages = AsyncIterable<unknown[][]>
const PAGE = 5000

/** Table rows in pages (ordered by primary key so OFFSET paging is stable). */
async function* tablePages(d: SqlDriver, it: DbObject, cols: Column[], onRows: (n: number) => void, j: JobCtl): Pages {
  const sort = cols.filter((c) => c.pk).map((c) => ({ column: c.name, dir: 'ASC' as const }))
  for (let offset = 0; ; offset += PAGE) {
    if (j.cancelled) throw new Error('Cancelled')
    const r = await d.query(selectSql(d.dialect, { schema: it.schema, table: it.name, filters: [], join: 'AND', sort, limit: PAGE, offset }, cols))
    if (r.rows.length) { yield r.rows; onRows(r.rows.length) }
    if (r.rows.length < PAGE) return
  }
}

async function* csvText(names: string[], numeric: boolean[], pages: Pages, o: CsvOut): AsyncGenerator<string> {
  if (o.header) yield csvRow(names, { ...o, decimal: '.' }) + o.lineBreak
  for await (const rows of pages) yield rows.map((r) => csvRow(r, o, numeric) + o.lineBreak).join('')
}

async function* jsonText(names: string[], numeric: boolean[], pages: Pages, pretty: boolean): AsyncGenerator<string> {
  let first = true
  yield '['
  for await (const rows of pages) {
    yield rows.map((r) => {
      const obj = Object.fromEntries(names.map((n, i) => [n, typedValue(r[i] ?? null, numeric[i])]))
      const s = (first ? '' : ',') + (pretty ? '\n  ' + JSON.stringify(obj, null, 2).replace(/\n/g, '\n  ') : '\n' + JSON.stringify(obj))
      first = false
      return s
    }).join('')
  }
  yield '\n]\n'
}

async function* insertText(d: Dialect, schema: string, table: string, names: string[], types: string[], pages: Pages): AsyncGenerator<string> {
  for await (const rows of pages)
    for (let i = 0; i < rows.length; i += BATCH)
      yield insertManySql(d, schema, table, names, rows.slice(i, i + BATCH).map((r) => r.map((v, k) => exportValue(d, v, types[k]))), types) + ';\n'
}

const textFor = (f: ExportFormat, title: string, names: string[], numeric: boolean[], pages: Pages, o: { csv: CsvOut; pretty: boolean }): AsyncIterable<string> =>
  f === 'csv' ? csvText(names, numeric, pages, o.csv) : f === 'json' ? jsonText(names, numeric, pages, o.pretty) : markupText(f as 'jsonl' | 'markdown' | 'html' | 'xml', title, names, numeric, pages)

async function writeText(path: string, gen: AsyncIterable<string>, gzip = false): Promise<void> {
  try {
    await (gzip ? pipeline(gen, createGzip(), createWriteStream(path)) : pipeline(gen, createWriteStream(path)))
  } catch (e) {
    rmSync(path, { force: true }) // no half-written files left behind
    throw e
  }
}

const sheetName = (s: string): string => s.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet1'

async function writeXlsx(path: string, sheet: string, names: string[], numeric: boolean[], pages: Pages): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: true })
  const ws = wb.addWorksheet(sheetName(sheet))
  let started = false
  const start = (sample: unknown[][]): void => {
    started = true
    // auto width from the header and the first page
    ws.columns = names.map((n, i) => ({ width: Math.min(60, Math.max(n.length, ...sample.slice(0, 500).map((r) => String(r[i] ?? '').length)) + 2) }))
    const h = ws.addRow(names)
    h.font = { bold: true }
    h.commit()
  }
  try {
    for await (const rows of pages) {
      if (!started) start(rows)
      for (const r of rows) ws.addRow(r.map((v, i) => typedValue(v, numeric[i]))).commit()
    }
    if (!started) start([])
    await wb.commit()
  } catch (e) {
    rmSync(path, { force: true })
    throw e
  }
}

export interface ExportOpts {
  items: DbObject[]
  format: ExportFormat
  target: string // folder (one file per item) or file (sql)
  pattern: string // file name pattern for folder outputs
  csv: CsvOut
  pretty: boolean
  sql: Record<string, { structure: boolean; drop: boolean; data: boolean }> // key: schema.name
  gzip: boolean
  mask?: MaskRule[]
}

/** Rows rewritten by the masking rules on their way into the file; null when no rule applies. */
async function* maskPages(pages: Pages, m: (row: unknown[]) => unknown[]): Pages { for await (const rows of pages) yield rows.map(m) }

export async function exportItems(j: JobCtl, conn: Connection, d: SqlDriver, o: ExportOpts): Promise<{ message: string; output: string }> {
  const database = d.currentDatabase()
  const estimates: (number | null)[] = []
  const salt = crypto.randomUUID() // pseudonyms match across tables of this export only
  for (const it of o.items) estimates.push(await d.estimateCount(it.schema, it.name).catch(() => null))
  let total = 0
  const tick = (idx: number, done: number): void => {
    const e = estimates[idx]
    j.progress((idx + (e ? Math.min(1, done / e) : 0)) / o.items.length, `${o.items[idx].name}: ${done} rows`)
  }
  const pagesFor = async (idx: number): Promise<{ cols: Column[]; pages: Pages }> => {
    const it = o.items[idx]
    const cols = await d.columns(it.schema, it.name)
    let done = 0
    const pages = tablePages(d, it, cols, (n) => { done += n; total += n; tick(idx, done) }, j)
    const m = o.mask && masker(cols.map((c) => c.name), o.mask, salt)
    return { cols, pages: m ? maskPages(pages, m) : pages }
  }

  if (o.format === 'sql') {
    const path = checkPath(o.target)
    const dl = d.dialect
    // MySQL/SQLite files stay unqualified so they load into any database; Postgres keeps schema names
    const sch = (s: string): string => (dl === 'postgres' ? s : '')
    const self = async function* (): AsyncGenerator<string> {
      yield `-- Lagoon SQL export\n-- Connection: ${conn.name}${database ? ` · Database: ${database}` : ''}\n-- Created: ${new Date().toISOString()}\n\n`
      for (let idx = 0; idx < o.items.length; idx++) {
        const it = o.items[idx]
        const f = o.sql[`${it.schema}.${it.name}`] ?? { structure: true, drop: false, data: it.kind === 'table' }
        yield `-- ${it.kind} ${it.name}\n`
        if (f.drop) yield `DROP ${it.kind === 'view' ? 'VIEW' : it.kind === 'matview' ? 'MATERIALIZED VIEW' : 'TABLE'} IF EXISTS ${qt(dl, sch(it.schema), it.name)};\n`
        if (f.structure) yield (await d.ddl(it.schema, it.name, it.kind)).trim().replace(/;?$/, ';') + '\n'
        if (f.data && it.kind === 'table') {
          const { cols, pages } = await pagesFor(idx)
          yield* insertText(dl, sch(it.schema), it.name, cols.map((c) => c.name), cols.map((c) => c.type), pages)
        }
        yield '\n'
        j.progress((idx + 1) / o.items.length)
      }
    }
    await writeText(path, self(), o.gzip)
    return { message: `Exported ${o.items.length} item${o.items.length === 1 ? '' : 's'} (${total} rows)`, output: path }
  }

  const dir = checkPath(o.target)
  mkdirSync(dir, { recursive: true })
  const ext = exportExt(o.format)
  const used = new Set<string>()
  let lastFile = dir
  for (let idx = 0; idx < o.items.length; idx++) {
    const it = o.items[idx]
    let name = expandPattern(o.pattern || '{table}', { connection: conn.name, database, schema: it.schema, table: it.name })
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${name}_${k}`
    used.add(name.toLowerCase())
    const file = join(dir, `${name}.${ext}`)
    const { cols, pages } = await pagesFor(idx)
    const names = cols.map((c) => c.name)
    const numeric = cols.map((c) => isNumericType(c.type))
    if (o.format === 'xlsx') await writeXlsx(file, it.name, names, numeric, pages)
    else await writeText(file, textFor(o.format, it.name, names, numeric, pages, o))
    lastFile = file
    j.progress((idx + 1) / o.items.length)
  }
  return { message: `Exported ${o.items.length} file${o.items.length === 1 ? '' : 's'} (${total} rows)`, output: o.items.length === 1 ? lastFile : dir }
}

/** Already-loaded result rows (query results) → one file. */
async function exportRows(o: { path: string; format: ExportOpts['format']; columns: string[]; rows: unknown[][]; table: string; dialect: Dialect; csv: CsvOut; pretty: boolean; mask?: MaskRule[] }): Promise<void> {
  const path = checkPath(o.path)
  const m = o.mask && masker(o.columns, o.mask, crypto.randomUUID())
  const pages = (async function* () { yield m ? o.rows.map(m) : o.rows })()
  const numeric = o.columns.map((_c, i) => o.rows.slice(0, 200).every((r) => r[i] === null || typeof r[i] === 'number'))
  if (o.format === 'xlsx') return writeXlsx(path, o.table, o.columns, numeric, pages)
  return writeText(path, o.format === 'sql' ? insertText(o.dialect, '', o.table, o.columns, [], pages) : textFor(o.format, o.table, o.columns, numeric, pages, o))
}

register({
  'job.list': (c) => [...jobs.values()].filter((x) => x.sender === c.sender).map((x) => x.p).reverse(),
  'job.cancel': (_c, id: string) => {
    const x = jobs.get(id)
    if (!x || x.p.state !== 'running') return
    x.ctl.cancelled = true
    x.ctl.onCancel?.()
  },
  /** Native pickers that also approve the chosen paths for jobs. */
  'job.open': async (c, opts: Electron.OpenDialogOptions) => {
    const r = (await dialog.showOpenDialog(c.win!, opts)).filePaths
    r.forEach((p) => approved.add(p))
    return r
  },
  'job.save': async (c, opts: Electron.SaveDialogOptions) => {
    const r = (await dialog.showSaveDialog(c.win!, opts)).filePath
    if (r) approved.add(r)
    return r
  },
  /** First 100 rows / records, or the first 100,000 characters of a SQL file. */
  'import.preview': (_c, o: ImportOpts) => (o.kind === 'sql' ? { text: decode(o.path, o.encoding).slice(0, 100000) } : readSource(o, 100)),
  'import.run': async (c, sessionId: string, o: ImportOpts) => {
    checkPath(o.path)
    const title = o.kind === 'sql' ? `Import ${o.path.split(/[\\/]/).pop()}` : `Import into ${o.table}`
    return startJob(c.sender, 'import', title, async (j) => {
      const { d, close } = await jobDriver(sessionId)
      try { return await (o.kind === 'sql' ? importSqlFile(j, d, o) : importRows(j, d, o)) } finally { await close() }
    })
  },
  'export.run': (c, sessionId: string, o: ExportOpts) => {
    checkPath(o.target)
    if (!o.items.length) throw new Error('Select at least one table or view.')
    return startJob(c.sender, 'export', `Export ${o.items.length === 1 ? o.items[0].name : `${o.items.length} items`} (${EXPORT_FORMATS.find((f) => f[0] === o.format)?.[1] ?? o.format})`, async (j) => {
      const { d, close } = await jobDriver(sessionId)
      try { return await exportItems(j, session(sessionId).conn, d, o) } finally { await close() }
    })
  },
  'export.rows': (_c, o: Parameters<typeof exportRows>[0]) => exportRows(o)
})
