// Redis Pub/Sub and MONITOR, each on its own connection, streamed to the tab that started it in batches.
import type Redis from 'ioredis'
import type { WebContents } from 'electron'
import type { RedisLiveEvent } from '@shared/types'
import { register } from './rpc'
import { session } from './sessions'
import type { RedisDriver } from './drivers/redis'

interface Live { conn: Redis; sender: WebContents; buf: RedisLiveEvent[]; dropped: number; timer?: NodeJS.Timeout }
const lives = new Map<string, Live>()
const MAX_BATCH = 2000 // per 100 ms; a busy server's MONITOR would otherwise flood the window
const clip = (s: string): string => (s.length > 20000 ? s.slice(0, 20000) + '…' : s)

function push(id: string, e: RedisLiveEvent): void {
  const l = lives.get(id)
  if (!l) return
  if (l.buf.length >= MAX_BATCH) { l.dropped++; return }
  l.buf.push(e)
  l.timer ??= setTimeout(() => {
    l.timer = undefined
    if (!l.sender.isDestroyed()) l.sender.send('redis:live', id, l.buf, l.dropped)
    l.buf = []
    l.dropped = 0
  }, 100)
}

function stop(id: string): void {
  const l = lives.get(id)
  if (!l) return
  lives.delete(id)
  clearTimeout(l.timer)
  l.conn.disconnect()
}

function track(sender: WebContents, id: string, conn: Redis): void {
  stop(id)
  conn.on('error', () => {})
  lives.set(id, { conn, sender, buf: [], dropped: 0 })
  sender.once('destroyed', () => stop(id))
}

const driver = (s: string): RedisDriver => session(s).driver as RedisDriver

register({
  /** Channels or glob patterns (news.*); a tab keeps one subscriber connection for all of them. */
  'redis.subscribe': async (c, s: string, id: string, patterns: string[]) => {
    if (!lives.has(id)) {
      const conn = driver(s).subscriber()
      track(c.sender, id, conn)
      conn.on('pmessage', (pattern: string, channel: string, message: string) => push(id, { at: Date.now(), pattern, channel, message: clip(message) }))
    }
    await lives.get(id)!.conn.psubscribe(...patterns)
  },
  'redis.unsubscribe': async (_c, id: string, patterns: string[]) => { await lives.get(id)?.conn.punsubscribe(...patterns) },
  'redis.monitor': async (c, s: string, id: string) => {
    const conn = await driver(s).monitor()
    track(c.sender, id, conn)
    conn.on('monitor', (time: string, args: string[], source: string, database: string) => push(id, { at: Math.round(Number(time) * 1000), args: args.map(clip), source, db: Number(database) }))
  },
  'redis.liveStop': (_c, id: string) => stop(id)
})
