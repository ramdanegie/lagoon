// Data Synchronization: compare the rows of table pairs (merge-join over key-ordered pages, so big tables never load whole)
// and apply the differences to the target, one transaction per table. Compare results stay here; the window pages through them.
import { classify, fkOrder, type ReadSpec } from '@shared/transfer'
import { mergeDiff, opSql, type CompareOpts, type ColInfo, type OpKind, type TableTarget } from '@shared/datasync'
import { register } from './rpc'
import { session, sqlDriver } from './sessions'
import { startJob, type JobCtl } from './jobs'
import { privateDriver, readPages, dbSink, execSafe, beginSql } from './transfer'

const CHUNK = 5000
const DIFF_CAP = 100_000 // differences kept per table; more than that must be narrowed with a WHERE condition
const SAME_CAP = 1000 // identical rows kept per table, for the "Same" filter
const PREVIEW_CAP = 10_000

export interface SyncPair { source: string; target: string; keys: [string, string][]; cols: [string, string][]; where?: string }
interface CompareReq { source: { sessionId: string; schema: string }; target: { sessionId: string; schema: string }; pairs: SyncPair[]; opts: CompareOpts }
interface Row { id: number; kind: OpKind; src: unknown[] | null; dst: unknown[] | null; changed: number[] }
interface TableDiff {
  source: string
  target: string
  columns: string[] // source names: keys first
  targetColumns: string[]
  keyCount: number
  counts: Record<OpKind, number>
  truncated: boolean
  error?: string
  rows: Row[]
  t?: TableTarget
  parents: string[]
}
interface Compare { targetSession: string; targetLabel: string; tables: TableDiff[] }
export interface DeploySel { tables: Record<number, { off?: boolean; excluded?: number[] }>; kinds: Record<'insert' | 'update' | 'delete', boolean> }
type Filter = 'diff' | 'all' | OpKind

const compares = new Map<string, Compare>()
const plural = (n: number, w: string): string => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

async function runCompare(j: JobCtl, o: CompareReq, out: Compare): Promise<{ message: string }> {
  const s = await privateDriver(o.source.sessionId)
  try {
    const t = await privateDriver(o.target.sessionId)
    try {
      const sd = s.d.dialect
      const td = t.d.dialect
      for (let pi = 0; pi < o.pairs.length; pi++) {
        if (j.cancelled) throw new Error('Cancelled')
        const p = o.pairs[pi]
        const sNames = [...p.keys.map((k) => k[0]), ...p.cols.map((c) => c[0])]
        const tNames = [...p.keys.map((k) => k[1]), ...p.cols.map((c) => c[1])]
        const diff: TableDiff = { source: p.source, target: p.target, columns: sNames, targetColumns: tNames, keyCount: p.keys.length, counts: { insert: 0, update: 0, delete: 0, same: 0 }, truncated: false, rows: [], parents: [] }
        out.tables.push(diff)
        try {
          if (!p.keys.length) throw new Error('No key columns, so rows cannot be paired.')
          const sc = await s.d.columns(o.source.schema, p.source)
          const tc = await t.d.columns(o.target.schema, p.target)
          const typeOf = (cols: ColInfo[], n: string, side: string): string => {
            const c = cols.find((x) => x.name === n)
            if (!c) throw new Error(`Column ${n} is missing in the ${side} table.`)
            return c.type
          }
          const sTypes = sNames.map((n) => typeOf(sc, n, 'source'))
          const tTypes = tNames.map((n) => typeOf(tc, n, 'target'))
          const sInfo = sTypes.map((x) => classify(x, sd))
          const tInfo = tTypes.map((x) => classify(x, td))
          diff.t = { dialect: td, schema: o.target.schema, table: p.target, cols: tNames, types: tTypes, keyCount: p.keys.length }
          diff.parents = (await t.d.foreignKeys(o.target.schema, p.target).catch(() => [])).map((f) => f.refTable)
          const spec = (schema: string, table: string, names: string[], types: string[], info: typeof sInfo): ReadSpec => ({
            schema, table, cols: names, where: p.where, notNullKeys: true,
            keys: names.slice(0, p.keys.length).map((name, i) => ({ name, type: types[i], text: info[i].text }))
          })
          const est = (await s.d.estimateCount(o.source.schema, p.source).catch(() => null)) ?? 0
          let n = 0
          let id = 0
          const ops = mergeDiff(readPages(s.d, spec(o.source.schema, p.source, sNames, sTypes, sInfo), CHUNK, j), readPages(t.d, spec(o.target.schema, p.target, tNames, tTypes, tInfo), CHUNK, j), { keyCount: p.keys.length, types: sInfo, opts: o.opts })
          for await (const op of ops) {
            diff.counts[op.kind]++
            const c = diff.counts
            if (op.kind === 'same' ? c.same <= SAME_CAP : c.insert + c.update + c.delete <= DIFF_CAP) diff.rows.push({ id: id++, ...op })
            else if (op.kind !== 'same') diff.truncated = true
            if (++n % 2000 === 0) j.progress((pi + (est ? Math.min(0.99, n / est) : 0)) / o.pairs.length, `${p.source}: ${n.toLocaleString('en-US')} rows compared`)
          }
        } catch (e) {
          if (j.cancelled) throw e
          diff.error = (e as Error).message
          diff.rows = []
        }
        j.progress((pi + 1) / o.pairs.length)
      }
    } finally {
      await t.close()
    }
  } finally {
    await s.close()
  }
  const sum = (k: OpKind): number => out.tables.reduce((a, x) => a + x.counts[k], 0)
  const failed = out.tables.filter((x) => x.error).length
  return { message: `${plural(out.tables.length, 'table')} compared: ${sum('insert')} to insert, ${sum('update')} to update, ${sum('delete')} to delete${failed ? `, ${failed} not comparable` : ''}` }
}

/** Steps to run: deletes first (child tables before parents), then updates and inserts (parents first). */
function plan(c: Compare, sel: DeploySel): { label: string; stmts: string[] }[] {
  const use = c.tables.map((t, i) => ({ t, i })).filter(({ t, i }) => !t.error && t.t && !sel.tables[i]?.off)
  const big = use.find(({ t }) => t.truncated)
  if (big) throw new Error(`${big.t.source} has more than ${DIFF_CAP.toLocaleString('en-US')} differences. Narrow it with a WHERE condition, or copy the table with Data Transfer.`)
  const names = fkOrder([...new Set(use.map((u) => u.t.target))], Object.fromEntries(use.map((u) => [u.t.target, u.t.parents])))
  const ordered = names.flatMap((n) => use.filter((u) => u.t.target === n))
  const stmts = (u: (typeof use)[number], kinds: OpKind[]): string[] => {
    const ex = new Set(sel.tables[u.i]?.excluded ?? [])
    return kinds.flatMap((k) => (sel.kinds[k as 'insert'] ? u.t.rows.filter((r) => r.kind === k && !ex.has(r.id)).map((r) => opSql(u.t.t!, r)!) : []))
  }
  return [
    ...[...ordered].reverse().map((u) => ({ label: `${u.t.target}: delete`, stmts: stmts(u, ['delete']) })),
    ...ordered.map((u) => ({ label: `${u.t.target}: update and insert`, stmts: stmts(u, ['update', 'insert']) }))
  ].filter((s) => s.stmts.length)
}

function get(id: string): Compare {
  const c = compares.get(id)
  if (!c) throw new Error('This comparison is no longer available. Compare again.')
  return c
}

register({
  /** Tables of both sides with their columns, for the mapping grid. */
  'datasync.tables': async (_c, sourceSession: string, sourceSchema: string, targetSession: string, targetSchema: string) => {
    const side = async (sid: string, schema: string): Promise<{ name: string; cols: ColInfo[] }[]> => {
      const d = sqlDriver(sid)
      const out: { name: string; cols: ColInfo[] }[] = []
      for (const o of (await d.objects(schema)).filter((x) => x.kind === 'table'))
        out.push({ name: o.name, cols: (await d.columns(schema, o.name)).map((c) => ({ name: c.name, type: c.type, pk: c.pk, extra: c.extra })) })
      return out
    }
    return { source: await side(sourceSession, sourceSchema), target: await side(targetSession, targetSchema) }
  },
  'datasync.compare': (c, o: CompareReq) => {
    if (!o.pairs?.length) throw new Error('Select at least one table pair.')
    const ts = session(o.target.sessionId)
    const out: Compare = { targetSession: o.target.sessionId, targetLabel: `${ts.conn.name} · ${sqlDriver(o.target.sessionId).currentDatabase() ?? ''}${o.target.schema && ts.conn.driver === 'postgres' ? ` · ${o.target.schema}` : ''}`, tables: [] }
    const id = startJob(c.sender, 'datasync', `Compare data (${plural(o.pairs.length, 'table')})`, (j) => runCompare(j, o, out))
    compares.set(id, out)
    for (const k of compares.keys()) if (compares.size > 5 && k !== id) compares.delete(k)
    return id
  },
  /** Per-table counts (no rows). */
  'datasync.summary': (_c, id: string) => get(id).tables.map((x) => ({ source: x.source, target: x.target, columns: x.columns, targetColumns: x.targetColumns, keyCount: x.keyCount, counts: x.counts, truncated: x.truncated, error: x.error })),
  'datasync.rows': (_c, id: string, table: number, filter: Filter, offset: number, limit: number) => {
    const rows = get(id).tables[table]?.rows ?? []
    const list = filter === 'all' ? rows : filter === 'diff' ? rows.filter((r) => r.kind !== 'same') : rows.filter((r) => r.kind === filter)
    return { total: list.length, rows: list.slice(offset, offset + limit) }
  },
  /** Every statement Deploy would run, for review in a SQL tab (long scripts are cut after the first 10,000). */
  'datasync.script': (_c, id: string, sel: DeploySel) => {
    const c = get(id)
    const steps = plan(c, sel)
    const total = steps.reduce((a, s) => a + s.stmts.length, 0)
    let left = PREVIEW_CAP
    const body = steps.map((s) => {
      const part = s.stmts.slice(0, Math.max(0, left))
      left -= part.length
      return `-- ${s.label} (${plural(s.stmts.length, 'statement')})\n${part.join('\n')}`
    })
    const more = total > PREVIEW_CAP ? `\n-- … ${plural(total - PREVIEW_CAP, 'more statement')} not shown. Deploy runs all of them.\n` : '\n'
    return { total, sql: `-- Lagoon data synchronization script\n-- Run against: ${c.targetLabel}\n-- ${plural(total, 'statement')}\n\n${body.join('\n\n')}${more}` }
  },
  'datasync.deploy': (c, id: string, sel: DeploySel, o: { continueOnError: boolean }) => {
    const cmp = get(id)
    const steps = plan(cmp, sel)
    const total = steps.reduce((a, s) => a + s.stmts.length, 0)
    if (!total) throw new Error('Nothing to deploy.')
    return startJob(c.sender, 'datasync', `Synchronize data into ${cmp.targetLabel}`, async (j) => {
      const { d, close } = await privateDriver(cmp.targetSession)
      const sink = dbSink(d)
      let done = 0
      let applied = 0
      let errors = 0
      try {
        for (const st of steps) {
          await d.query(beginSql(d.dialect))
          let ok = 0
          let bad = 0
          try {
            for (const sql of st.stmts) {
              if (j.cancelled) throw new Error('Cancelled')
              const err = await execSafe(sink, sql, o.continueOnError)
              if (err && !o.continueOnError) throw new Error(`${st.label}: ${err}\n${sql}`)
              if (err) { if (++bad <= 20) j.log(`${st.label}: failed: ${err}\n  ${sql}\n`) } else ok++
              if (++done % 200 === 0) j.progress(done / total, `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} statements`)
            }
            await d.query('COMMIT')
          } catch (e) {
            await d.query('ROLLBACK').catch(() => {})
            j.log(`${st.label}: rolled back\n`)
            throw e
          }
          applied += ok
          errors += bad
          j.log(`${st.label}: ${plural(ok, 'statement')} applied${bad ? `, ${bad} failed` : ''}\n`)
        }
      } finally {
        await close()
      }
      const message = `Applied ${plural(applied, 'change')}${errors ? `, ${plural(errors, 'error')}` : ''}`
      j.log(message + '\n')
      return { message }
    })
  },
  'datasync.drop': (_c, id: string) => void compares.delete(id)
})
