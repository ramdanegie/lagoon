import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRun, scheduleText } from '../src/shared/automation.ts'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

test('nextRun: manual, interval, daily before/after the time, weekly incl. same day', () => {
  const now = at(2026, 11, 12, 9, 30) // a Thursday
  assert.equal(nextRun({ kind: 'manual' }, now), null)
  assert.equal(nextRun({ kind: 'interval', minutes: 15 }, now), now + 15 * 60000)
  assert.equal(nextRun({ kind: 'interval', minutes: 0 }, now), now + 60000, 'at least a minute')
  assert.equal(nextRun({ kind: 'daily', time: '10:00' }, now), at(2026, 11, 12, 10, 0))
  assert.equal(nextRun({ kind: 'daily', time: '09:30' }, now), at(2026, 11, 13, 9, 30), 'strictly after now')
  assert.equal(nextRun({ kind: 'daily', time: '02:05' }, now), at(2026, 11, 13, 2, 5))
  assert.equal(nextRun({ kind: 'weekly', day: 1, time: '08:00' }, now), at(2026, 11, 16, 8, 0), 'next Monday')
  assert.equal(nextRun({ kind: 'weekly', day: 4, time: '23:00' }, now), at(2026, 11, 12, 23, 0), 'later today')
  assert.equal(nextRun({ kind: 'weekly', day: 4, time: '08:00' }, now), at(2026, 11, 19, 8, 0), 'a week on')
  assert.equal(nextRun({ kind: 'daily', time: '23:59' }, at(2026, 12, 31, 23, 59)), at(2027, 1, 1, 23, 59), 'across the year')
})

test('scheduleText', () => {
  assert.equal(scheduleText({ kind: 'interval', minutes: 1 }), 'Every 1 minute')
  assert.equal(scheduleText({ kind: 'interval', minutes: 120 }), 'Every 2 hours')
  assert.equal(scheduleText({ kind: 'interval', minutes: 60 }), 'Every hour')
  assert.equal(scheduleText({ kind: 'daily', time: '2:05' }), 'Daily at 02:05')
  assert.equal(scheduleText({ kind: 'weekly', day: 1, time: '08:00' }), 'Every Monday at 08:00')
})
