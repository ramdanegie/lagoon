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
  await welcome.evaluate(() => window.api.call('settings.set', 'tour.onStartup', false))
  await welcome.waitForTimeout(300) // the tour may have auto-opened before the setting landed
  if (await welcome.locator('.tour').isVisible()) await welcome.keyboard.press('Escape')
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

  // Pub/Sub: subscribe to a pattern, publish, the message shows up; Monitor sees the PUBLISH command
  await rw.getByRole('treeitem', { name: 'Monitor', exact: true }).click()
  await rw.getByRole('button', { name: 'Start monitor' }).click()
  await rw.getByRole('button', { name: 'Stop' }).waitFor()
  await rw.getByRole('treeitem', { name: 'Pub/Sub', exact: true }).click()
  await rw.getByLabel('Channel or pattern to subscribe to').fill('news.*')
  await rw.getByRole('button', { name: 'Subscribe' }).click()
  await rw.getByRole('listitem').filter({ hasText: 'news.*' }).waitFor()
  await rw.getByLabel('Channel to publish to').fill('news.today')
  await rw.getByLabel('Message to publish').fill('hello lagoon')
  await rw.getByRole('button', { name: 'Publish' }).click()
  await rw.getByText('Delivered to 1 subscriber').waitFor()
  await rw.getByRole('gridcell', { name: 'hello lagoon', exact: true }).waitFor()
  assert.ok(await rw.getByRole('gridcell', { name: 'news.today', exact: true }).count())
  await rw.screenshot({ path: join(shots, 'S54-redis-pubsub.png') })
  await rw.getByRole('tab', { name: /Monitor/ }).click()
  await rw.getByRole('gridcell', { name: /PUBLISH news\.today "hello lagoon"/ }).waitFor()
  await rw.screenshot({ path: join(shots, 'S55-redis-monitor.png') })
  await rw.getByRole('button', { name: 'Stop' }).click()
  step('Redis: Pub/Sub delivers a published message; Monitor shows the command')
  await rw.close()

  // ---------- MongoDB ----------
  const mg = await save({ name: 'Mongo e2e', driver: 'mongodb', host: '127.0.0.1', port: 27100, database: 'crm' })
  const gw = await openWs({ view: 'workspace', conn: mg.id })
  await gw.getByRole('treeitem', { name: 'people' }).click()
  await gw.getByText('Budi').first().waitFor({ timeout: 15000 })
  await gw.screenshot({ path: join(shots, 'S39-mongo.png') })
  step('MongoDB: collection grid')

  // aggregation pipeline: each stage previews its output; write stages are refused in the preview
  await gw.getByRole('button', { name: 'Pipeline', exact: true }).click()
  const body = (n) => gw.getByLabel(`Stage ${n} body`)
  await body(1).click()
  await gw.keyboard.press('Meta+A')
  await gw.keyboard.insertText('{ age: { $gt: 30 } }')
  await gw.getByText('1 document', { exact: true }).waitFor()
  assert.equal(await gw.getByRole('gridcell', { name: 'Budi', exact: true }).count(), 0)
  await gw.getByRole('button', { name: 'Add stage' }).click()
  await gw.getByText('Output after stage 2').waitFor()
  await gw.getByRole('columnheader', { name: /^name/ }).waitFor()
  await gw.waitForFunction(() => ![...document.querySelectorAll('[role=columnheader]')].some((h) => h.offsetParent && /^age/.test(h.textContent ?? '')))
  assert.ok(await gw.getByRole('gridcell', { name: 'Ana', exact: true }).count())
  await gw.screenshot({ path: join(shots, 'S56-mongo-pipeline.png') })
  await gw.getByRole('button', { name: 'Add stage' }).click()
  await gw.getByLabel('Stage 3 operator').selectOption('$count')
  await gw.getByRole('gridcell', { name: '1', exact: true }).waitFor()
  await gw.getByRole('checkbox', { name: 'Run stage 3' }).uncheck()
  await gw.getByText('(switched off)').waitFor()
  step('MongoDB: aggregation pipeline previews each stage')
  await gw.close()

  console.log('\nENGINES E2E OK')
} finally {
  await ea.close()
  await mc.close()
}
