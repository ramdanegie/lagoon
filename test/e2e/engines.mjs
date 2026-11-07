// E2E across SQLite, MySQL, Redis and MongoDB. Needs throwaway servers: MySQL 127.0.0.1:33100 (root, no password, db "shop"),
// Redis 6400, MongoDB 27100, and a SQLite file path in TC_SQLITE. Run `npx electron-vite build` first.
import { _electron as electron } from 'playwright-core'
import { MongoClient } from 'mongodb'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
import assert from 'assert/strict'

const app = resolve(import.meta.dirname, '../..')
const shots = resolve(app, 'test/e2e/.shots')
const sqliteFile = process.env.TC_SQLITE || '/tmp/lagoon-e2e/app.sqlite'
const step = (m) => console.log('•', m)

execSync(`sqlite3 ${sqliteFile} "update notes set body='x' where id=1"`)
execSync(`mysql -h127.0.0.1 -P33100 -uroot -e "update shop.products set price=1.50 where id=1"`)
const mc = new MongoClient('mongodb://127.0.0.1:27100/?directConnection=true')
await mc.connect()
await mc.db('crm').collection('people').deleteMany({})
await mc.db('crm').collection('people').insertMany([{ name: 'Ana', age: 31, tags: ['vip'] }, { name: 'Budi', age: 27, address: { city: 'Bandung' } }])

const ea = await electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: mkdtempSync(join(tmpdir(), 'tc-e2e-')) } })
const welcome = await ea.firstWindow()
await welcome.getByText('No connections yet.').waitFor()
  await welcome.waitForFunction(() => !document.querySelector('[inert]'))
const save = (c) => welcome.evaluate((c) => window.api.call('conn.save', c), { id: '', passwordMode: 'none', safeMode: 0, ...c })
const openWs = async (params) => {
  const before = new Set(ea.windows())
  await welcome.evaluate((p) => window.api.call('window.open', p), params)
  for (let i = 0; i < 100; i++) { const w = ea.windows().find((x) => !before.has(x)); if (w) { w.on('pageerror', (e) => console.log('  [pageerror]', e.message)); return w } await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('no window')
}

try {
  // ---------- SQLite ----------
  const sq = await openWs({ view: 'workspace', file: sqliteFile })
  await sq.getByRole('treeitem', { name: 'notes' }).click()
  await sq.getByText(/of 2 rows/).waitFor()
  await sq.getByRole('gridcell', { name: 'x', exact: true }).dblclick()
  await sq.getByLabel('Edit body').fill('edited')
  await sq.keyboard.press('Enter')
  await sq.getByTitle(/Commit changes/).click()
  await sq.getByText(/change committed/).waitFor()
  assert.equal(execSync(`sqlite3 ${sqliteFile} "select body from notes where id=1"`, { encoding: 'utf8' }).trim(), 'edited')
  step('SQLite: open file, edit, commit')
  await sq.close()

  // ---------- MySQL ----------
  const my = await save({ name: 'MySQL e2e', driver: 'mysql', host: '127.0.0.1', port: 33100, username: 'root', database: 'shop', ssl: { mode: 'DISABLED' } })
  const mw = await openWs({ view: 'workspace', conn: my.id })
  await mw.getByRole('treeitem', { name: 'products' }).click()
  await mw.getByText(/of 3 rows/).waitFor()
  await mw.getByRole('gridcell', { name: '1.50', exact: true }).dblclick()
  await mw.getByLabel('Edit price').fill('2.25')
  await mw.keyboard.press('Enter')
  await mw.getByTitle(/Commit changes/).click()
  await mw.getByText(/change committed/).waitFor()
  assert.equal(execSync(`mysql -h127.0.0.1 -P33100 -uroot -N -e "select price from shop.products where id=1"`, { encoding: 'utf8' }).trim(), '2.25')
  await mw.screenshot({ path: join(shots, 'S10-mysql.png') })
  await mw.getByRole('tab', { name: 'Structure' }).click()
  await mw.getByRole('gridcell', { name: 'decimal(10,2)' }).waitFor()
  step('MySQL: browse, edit decimal, commit, structure')
  await mw.close()

  // ---------- Redis ----------
  const rd = await save({ name: 'Redis e2e', driver: 'redis', host: '127.0.0.1', port: 6400 })
  const rw = await openWs({ view: 'workspace', conn: rd.id })
  await rw.getByText('user:1', { exact: true }).first().waitFor({ timeout: 15000 })
  await rw.getByText('user:1', { exact: true }).first().click()
  await rw.getByText('Jakarta').first().waitFor()
  await rw.screenshot({ path: join(shots, 'S38-redis.png') })
  step('Redis: key list + hash value panel')
  await rw.close()

  // ---------- MongoDB ----------
  const mg = await save({ name: 'Mongo e2e', driver: 'mongodb', host: '127.0.0.1', port: 27100, database: 'crm' })
  const gw = await openWs({ view: 'workspace', conn: mg.id })
  await gw.getByRole('treeitem', { name: 'people' }).click()
  await gw.getByText('Budi').first().waitFor({ timeout: 15000 })
  await gw.screenshot({ path: join(shots, 'S39-mongo.png') })
  step('MongoDB: collection grid')
  await gw.close()

  console.log('\nENGINES E2E OK')
} finally {
  await ea.close()
  await mc.close()
}
