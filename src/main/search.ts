// Search in database: COUNT(*) of rows where any column matches, one table at a time, pausable.
import type { FilterOp } from '@shared/types'
import { filterSql, qt } from '@shared/sqlgen'
import { register } from './rpc'
import { sqlDriver } from './sessions'

interface Job { paused: boolean; stopped: boolean; wake?: () => void }
const jobs = new Map<string, Job>()
const OPS: FilterOp[] = ['Contains', 'Not contains', '=', 'Has prefix', 'Has suffix']

const poke = (id: string, f: (j: Job) => void): void => {
  const j = jobs.get(id)
  if (j) { f(j); j.wake?.() }
}

register({
  /** Starts in the background; progress arrives as 'search:result' events, the last one has finished: true. */
  'search.start': (c, s: string, searchId: string, tables: { schema: string; name: string }[], op: FilterOp, value: string) => {
    if (!OPS.includes(op)) throw new Error(`Unsupported match type ${op}`)
    sqlDriver(s) // fail fast on a closed or non-SQL session
    const job: Job = { paused: false, stopped: false }
    jobs.set(searchId, job)
    const send = (msg: Record<string, unknown>): void => { if (!c.sender.isDestroyed()) c.sender.send('search:result', { searchId, total: tables.length, ...msg }) }
    void (async () => {
      for (let i = 0; i < tables.length; i++) {
        while (job.paused && !job.stopped) await new Promise<void>((r) => (job.wake = r))
        if (job.stopped) break
        const { schema, name } = tables[i]
        try {
          // shortcut: runs on the session connection, so it queues behind (and delays) the user's own queries; stop waits for the current table
          const d = sqlDriver(s)
          const cols = await d.columns(schema, name)
          const where = filterSql(d.dialect, { id: '', enabled: true, column: '__any__', op, value }, cols)
          const count = cols.length ? Number((await d.query(`SELECT COUNT(*) FROM ${qt(d.dialect, schema, name)} WHERE ${where}`)).rows[0]?.[0] ?? 0) : 0
          send({ schema, table: name, count, done: i + 1 })
        } catch (e) {
          send({ schema, table: name, error: (e as Error).message, done: i + 1 })
        }
      }
      jobs.delete(searchId)
      send({ finished: true, stopped: job.stopped })
    })()
  },
  'search.pause': (_c, id: string) => poke(id, (j) => (j.paused = true)),
  'search.resume': (_c, id: string) => poke(id, (j) => (j.paused = false)),
  'search.stop': (_c, id: string) => poke(id, (j) => (j.stopped = true))
})
