// Automation: saved tasks (run SQL, export tables, back up a database) and when they run next.
// Times are local wall-clock times. Tested in test/automation.test.ts.
import type { ExportFormat } from './importexport'

export type Schedule =
  | { kind: 'manual' }
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string } // HH:MM
  | { kind: 'weekly'; day: number; time: string } // day: 0 = Sunday

export type TaskAction =
  | { type: 'sql'; sql: string }
  | { type: 'export'; schema: string; tables: string[]; format: ExportFormat; folder: string; pattern: string; mask: boolean } // tables: [] = all
  | { type: 'backup'; folder: string; pattern: string; gzip: boolean }

export interface AutoTask {
  id: string
  name: string
  enabled: boolean
  connectionId: string
  database?: string
  action: TaskAction
  schedule: Schedule
  nextAt?: number | null
}

export interface AutoRun { taskId: string; name: string; start: number; end: number; ok: boolean; message: string; log: string; output?: string }

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const hm = (t: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  const h = m ? Math.min(23, Number(m[1])) : 0
  return [h, m ? Math.min(59, Number(m[2])) : 0]
}

/** The next time strictly after `now` (ms), or null for manual tasks. */
export function nextRun(s: Schedule, now: number): number | null {
  if (s.kind === 'manual') return null
  if (s.kind === 'interval') return now + Math.max(1, Math.floor(s.minutes || 0)) * 60000
  const [h, m] = hm(s.time)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (s.kind === 'daily') {
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  d.setDate(d.getDate() + ((s.day - d.getDay() + 7) % 7))
  if (d.getTime() <= now) d.setDate(d.getDate() + 7)
  return d.getTime()
}

export function scheduleText(s: Schedule): string {
  if (s.kind === 'manual') return 'Only when run by hand'
  if (s.kind === 'interval') return s.minutes % 60 === 0 && s.minutes >= 60 ? `Every ${s.minutes / 60 === 1 ? 'hour' : `${s.minutes / 60} hours`}` : `Every ${s.minutes} minute${s.minutes === 1 ? '' : 's'}`
  const [h, m] = hm(s.time)
  const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  return s.kind === 'daily' ? `Daily at ${t}` : `Every ${DAYS[s.day]} at ${t}`
}
