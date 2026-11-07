import { MongoClient, BSON, type Db, type Document } from 'mongodb'
import vm from 'node:vm'
import type { ConnectParams } from './types'

const { EJSON, ObjectId } = BSON
const LIMIT = 1000

export const toEjson = (v: unknown): string => EJSON.stringify(v, { relaxed: true })
export const fromEjson = <T = Document>(s: string): T => (s.trim() ? EJSON.parse(s, { relaxed: true }) : {}) as T

export class MongoDriver {
  kind = 'mongodb' as const
  private client!: MongoClient
  db: string
  onSql: (sql: string) => void = () => {}

  constructor(private p: ConnectParams, private uri?: string) { this.db = p.database || 'test' }

  private url(): string {
    if (this.uri) return this.uri
    const auth = this.p.user ? `${encodeURIComponent(this.p.user)}:${encodeURIComponent(this.p.password ?? '')}@` : ''
    const tls = this.p.ssl?.mode === 'REQUIRED' ? '&tls=true&tlsAllowInvalidCertificates=true' : ''
    return `mongodb://${auth}${this.p.host}:${this.p.port}/?authSource=${this.p.user ? 'admin' : this.db}&directConnection=true${tls}`
  }

  async connect(): Promise<void> {
    this.client = new MongoClient(this.url(), { serverSelectionTimeoutMS: 15000, tlsCAFile: undefined })
    await this.client.connect()
  }

  close = async (): Promise<void> => void (await this.client?.close().catch(() => {}))
  ping = async (): Promise<void> => void (await this.client.db('admin').command({ ping: 1 }))
  private d = (name = this.db): Db => this.client.db(name)

  async serverVersion(): Promise<string> {
    return String((await this.d('admin').command({ buildInfo: 1 })).version)
  }

  async databases(): Promise<string[]> {
    try { return (await this.d('admin').admin().listDatabases({ nameOnly: true })).databases.map((x) => x.name) } catch { return [this.db] }
  }

  use = (name: string): void => { this.db = name }

  async collections(): Promise<{ name: string; type: string }[]> {
    const c = await this.d().listCollections({}, { nameOnly: true }).toArray()
    return c.map((x) => ({ name: x.name, type: x.type ?? 'collection' })).sort((a, b) => a.name.localeCompare(b.name))
  }

  async find(coll: string, filter = '{}', sort = '{}', skip = 0, limit = 300): Promise<{ docs: string[]; total: number }> {
    const f = fromEjson(filter)
    const s = fromEjson(sort)
    this.onSql(`db.${coll}.find(${filter}).sort(${sort}).skip(${skip}).limit(${limit})`)
    const docs = await this.d().collection(coll).find(f).sort(s as never).skip(skip).limit(limit).toArray()
    const total = await this.d().collection(coll).countDocuments(f)
    return { docs: docs.map(toEjson), total }
  }

  async insert(coll: string, doc: string): Promise<string> {
    this.onSql(`db.${coll}.insertOne(${doc})`)
    const r = await this.d().collection(coll).insertOne(fromEjson(doc))
    return toEjson(r.insertedId)
  }

  async update(coll: string, id: string, set: string, unset: string[] = []): Promise<number> {
    const upd: Document = {}
    const s = fromEjson(set)
    if (Object.keys(s).length) upd.$set = s
    if (unset.length) upd.$unset = Object.fromEntries(unset.map((k) => [k, '']))
    this.onSql(`db.${coll}.updateOne({_id: ${id}}, ${toEjson(upd)})`)
    return (await this.d().collection(coll).updateOne({ _id: fromEjson<{ v: unknown }>(`{"v":${id}}`).v as never }, upd)).modifiedCount
  }

  async replace(coll: string, id: string, doc: string): Promise<number> {
    this.onSql(`db.${coll}.replaceOne({_id: ${id}}, ${doc})`)
    const d = fromEjson(doc)
    delete d._id
    return (await this.d().collection(coll).replaceOne({ _id: fromEjson<{ v: unknown }>(`{"v":${id}}`).v as never }, d)).modifiedCount
  }

  async remove(coll: string, ids: string[]): Promise<number> {
    this.onSql(`db.${coll}.deleteMany({_id: {$in: [${ids.join(', ')}]}})`)
    const vals = ids.map((id) => fromEjson<{ v: unknown }>(`{"v":${id}}`).v)
    return (await this.d().collection(coll).deleteMany({ _id: { $in: vals as never[] } })).deletedCount
  }

  createCollection = async (name: string): Promise<void> => { this.onSql(`db.createCollection("${name}")`); await this.d().createCollection(name) }
  dropCollection = async (name: string): Promise<void> => { this.onSql(`db.${name}.drop()`); await this.d().collection(name).drop() }
  truncateCollection = async (name: string): Promise<void> => { this.onSql(`db.${name}.deleteMany({})`); await this.d().collection(name).deleteMany({}) }

  async indexes(coll: string): Promise<string[]> {
    return (await this.d().collection(coll).indexes()).map(toEjson)
  }

  /** Database command as JSON, e.g. {"listCollections": 1}. */
  async command(json: string): Promise<string> {
    this.onSql(`db.runCommand(${json})`)
    return toEjson(await this.d().command(fromEjson(json)))
  }

  /**
   * Shell-style code: `db.users.find({age: {$gt: 30}}).sort({age: -1})`. Runs in a vm context whose `db` maps
   * unknown properties to collections. The user types this code themselves, same trust level as mongosh.
   */
  async shell(code: string): Promise<{ docs?: string[]; value?: string }> {
    this.onSql(code)
    const db = this.d()
    const dbProxy = new Proxy(db, {
      get: (t, k: string) => (k in t ? (t as never)[k] : k === 'getCollection' ? (n: string) => t.collection(n) : t.collection(k))
    })
    const ctx = vm.createContext({ db: dbProxy, ObjectId, ISODate: (s: string) => new Date(s), Date, JSON, Math, NumberLong: BSON.Long.fromString, NumberDecimal: BSON.Decimal128.fromString })
    let res = await vm.runInContext(`(async () => (${code.trim().replace(/;\s*$/, '')}))()`, ctx, { timeout: 5000 })
    if (res && typeof res.toArray === 'function') {
      if (typeof res.limit === 'function') res = res.limit(LIMIT)
      return { docs: (await res.toArray()).map(toEjson) }
    }
    if (Array.isArray(res)) return { docs: res.map(toEjson) }
    return { value: toEjson(res ?? null) }
  }
}
