import Redis from 'ioredis'
import type { ConnectParams } from './types'

export interface RedisKey { key: string; type: string; ttl: number; size: number | null }

/** Split a command line into args, honouring "double" and 'single' quotes. */
export function parseArgs(line: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g
  for (const m of line.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3])
  return out
}

const LEN: Record<string, string> = { string: 'strlen', hash: 'hlen', list: 'llen', set: 'scard', zset: 'zcard', stream: 'xlen' }

export class RedisDriver {
  kind = 'redis' as const
  private r!: Redis
  db = 0
  onSql: (sql: string) => void = () => {}

  constructor(private p: ConnectParams) { this.db = Number(p.database || 0) || 0 }

  async connect(): Promise<void> {
    const tls = this.p.ssl?.mode === 'REQUIRED' ? { rejectUnauthorized: false, ca: this.p.ssl.ca, cert: this.p.ssl.cert, key: this.p.ssl.key } : undefined
    this.r = new Redis({ host: this.p.host, port: this.p.port, username: this.p.user || undefined, password: this.p.password || undefined, db: this.db, tls, lazyConnect: true, protocol: 2, maxRetriesPerRequest: 1, connectTimeout: 15000, retryStrategy: () => null })
    this.r.on('error', () => {})
    await this.r.connect()
  }

  close = async (): Promise<void> => void this.r?.disconnect()
  /** Pub/Sub and MONITOR take over the connection they run on, so they get their own with the same settings. */
  subscriber = (): Redis => this.r.duplicate()
  monitor = (): Promise<Redis> => this.r.monitor()
  ping = async (): Promise<void> => void (await this.r.ping())

  private async call(...args: (string | number)[]): Promise<unknown> {
    this.onSql(args.map((a) => (/\s/.test(String(a)) ? JSON.stringify(String(a)) : String(a))).join(' '))
    return this.r.call(String(args[0]), ...args.slice(1).map(String))
  }

  async serverVersion(): Promise<string> {
    const info = String(await this.call('INFO', 'server'))
    return /redis_version:(\S+)/.exec(info)?.[1] ?? ''
  }

  async databases(): Promise<{ index: number; keys: number }[]> {
    let n = 16
    try { n = Number((await this.call('CONFIG', 'GET', 'databases') as string[])[1]) || 16 } catch { /* managed Redis blocks CONFIG */ }
    const ks = String(await this.call('INFO', 'keyspace'))
    const counts = Object.fromEntries([...ks.matchAll(/db(\d+):keys=(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]))
    return Array.from({ length: n }, (_, i) => ({ index: i, keys: counts[i] ?? 0 }))
  }

  async select(index: number): Promise<void> {
    await this.call('SELECT', index)
    this.db = index
  }

  async scan(pattern: string, cursor = '0', count = 500): Promise<{ cursor: string; keys: RedisKey[] }> {
    const [next, keys] = (await this.call('SCAN', cursor, 'MATCH', pattern || '*', 'COUNT', count)) as [string, string[]]
    const p1 = this.r.pipeline()
    keys.forEach((k) => p1.type(k).pttl(k))
    const r1 = (await p1.exec()) ?? []
    const types = keys.map((_, i) => String(r1[i * 2]?.[1]))
    const p2 = this.r.pipeline()
    keys.forEach((k, i) => (LEN[types[i]] ? p2.call(LEN[types[i]], k) : p2.exists(k)))
    const r2 = (await p2.exec()) ?? []
    return {
      cursor: next,
      keys: keys.map((k, i) => ({ key: k, type: types[i], ttl: ((ms) => (ms < 0 ? ms : Math.round(ms / 1000)))(Number(r1[i * 2 + 1]?.[1])), size: LEN[types[i]] ? Number(r2[i]?.[1]) : null }))
    }
  }

  async get(key: string): Promise<{ type: string; ttl: number; value: unknown }> {
    const type = String(await this.call('TYPE', key))
    const ttl = Number(await this.call('TTL', key))
    let value: unknown = null
    if (type === 'string') value = await this.call('GET', key)
    else if (type === 'hash') value = pairs(await this.call('HGETALL', key) as string[])
    else if (type === 'list') value = await this.call('LRANGE', key, 0, 999)
    else if (type === 'set') value = ((await this.call('SSCAN', key, 0, 'COUNT', 1000)) as [string, string[]])[1]
    else if (type === 'zset') value = pairs(await this.call('ZRANGE', key, 0, 999, 'WITHSCORES') as string[])
    else if (type === 'stream') value = ((await this.call('XRANGE', key, '-', '+', 'COUNT', 500)) as [string, string[]][]).map(([id, f]) => [id, Object.fromEntries(pairs(f))])
    return { type, ttl, value }
  }

  /** Every write goes through here so the console log shows it. */
  write = (args: (string | number)[]): Promise<unknown> => this.call(...args)

  async command(line: string): Promise<unknown> {
    const args = parseArgs(line)
    if (!args.length) return null
    const res = await this.call(...args)
    if (args[0].toUpperCase() === 'SELECT') this.db = Number(args[1])
    return res
  }
}

const pairs = (a: string[]): [string, string][] => {
  const out: [string, string][] = []
  for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]])
  return out
}
