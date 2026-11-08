// Opening files handed over by Finder / Open With: a .sql file opens in a query tab of the current database (waiting
// for one if none is open), a SQLite file connects. Needs ./test/e2e/fixtures.sh up and `npx electron-vite build`.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { createCipheriv, randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import assert from 'assert/strict'

const app = resolve(import.meta.dirname, '../..')
const sqlite = process.env.TC_SQLITE ?? '/tmp/lagoon-e2e/app.sqlite'
const ud = mkdtempSync(join(tmpdir(), 'lg-e2e-'))
const dir = mkdtempSync(join(tmpdir(), 'lg-files-'))
const sqlFile = join(dir, 'report.sql')
writeFileSync(sqlFile, 'select title from notes order by id;')
const step = (m) => console.log('•', m)
const errors = []
const ea = await electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: ud } })
const openFile = (p) => ea.evaluate(({ app }, p) => app.emit('open-file', { preventDefault() {} }, p), p)
try {
  const w = await ea.firstWindow()
  w.on('pageerror', (e) => errors.push(e.message))
  await w.getByText('No connections yet.').waitFor()
  await w.evaluate(() => window.api.call('settings.set', 'tour.onStartup', false))
  await w.waitForTimeout(300) // the tour may have auto-opened before the setting landed
  if (await w.locator('.tour').isVisible()) await w.keyboard.press('Escape')

  await openFile(sqlFile)
  await w.getByText('Double-click a database connection to open report.sql in it.').waitFor()
  step('.sql with no database open waits and says why')

  await openFile(sqlite)
  await w.getByRole('tab', { name: /report\.sql/ }).waitFor()
  await w.getByText(sqlFile).waitFor()
  await w.getByRole('button', { name: /Run Current|Run All/ }).first().click()
  await w.getByRole('gridcell', { name: 'a', exact: true }).waitFor()
  step('SQLite file connected; the waiting .sql opened in a query tab and runs')

  await w.locator('.cm-content').last().click()
  await w.keyboard.press('Meta+ArrowDown')
  await w.keyboard.type(' -- edited')
  for (let i = 0; i < 20 && !readFileSync(sqlFile, 'utf8').includes('-- edited'); i++) await w.waitForTimeout(100)
  assert.match(readFileSync(sqlFile, 'utf8'), /-- edited$/)
  step('edits are saved back to the file')

  await openFile(sqlFile)
  await w.waitForTimeout(500)
  assert.equal(await w.getByRole('tab', { name: /report\.sql/ }).count(), 1)
  step('opening the same file again focuses its tab')

  // connections from other apps (sample files; real app folders are never read here)
  const ncx = join(dir, 'export.ncx')
  writeFileSync(ncx, '<?xml version="1.0"?><Connections Ver="1.5"><Connection ConnectionName="From Navicat" ConnType="MYSQL" Host="127.0.0.1" Port="33100" UserName="root" Password="" SSH="false"/><Connection ConnectionName="Old SQL Server" ConnType="SQLSERVER" Host="x"/></Connections>')
  const dbv = join(dir, 'dbeaver/.dbeaver')
  mkdirSync(dbv, { recursive: true })
  writeFileSync(join(dbv, 'data-sources.json'), JSON.stringify({ connections: { 'postgres-jdbc-x': { provider: 'postgresql', driver: 'postgres-jdbc', name: 'From DBeaver', folder: 'Imported', configuration: { host: '127.0.0.1', port: '54400', database: 'crm' } } } }))
  const iv = randomBytes(16)
  const c = createCipheriv('aes-128-cbc', Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex'), iv)
  writeFileSync(join(dbv, 'credentials-config.json'), Buffer.concat([iv, c.update(JSON.stringify({ 'postgres-jdbc-x': { '#connection': { user: 'tc', password: 'unused' } } })), c.final()]))
  const imp = (app, p) => w.evaluate(([app, p]) => window.api.call('conn.importForeign', app, p).then((r) => { window.dispatchEvent(new CustomEvent('connections:changed')); return r }), [app, p])
  assert.deepEqual(await imp('navicat', ncx), { imported: 1, duplicates: 0, skipped: ['Old SQL Server (SQLSERVER is not supported)'] })
  assert.deepEqual(await imp('dbeaver', join(dbv, 'data-sources.json')), { imported: 1, duplicates: 0, skipped: [] })
  assert.equal((await imp('dbeaver', join(dbv, 'data-sources.json'))).duplicates, 1)
  await w.getByRole('treeitem', { name: 'From Navicat' }).waitFor()
  await w.getByRole('treeitem', { name: 'Imported' }).waitFor()
  await w.getByRole('treeitem', { name: 'From DBeaver' }).dblclick()
  await w.getByRole('treeitem', { name: 'contacts' }).waitFor()
  const saved = await w.evaluate(() => window.api.call('conn.list'))
  assert.equal(saved.find((x) => x.name === 'From DBeaver').passwordMode, 'store')
  step('Navicat and DBeaver connections imported (group, stored password, no duplicates) and connect')

  assert.deepEqual(errors, [], errors.join('\n'))
  console.log('\nFILES E2E OK')
} catch (e) { await ea.windows()[0]?.screenshot({ path: join(app, "test/e2e/.shots/FAIL-files.png") }).catch(() => {}); throw e
} finally {
  await ea.close()
  rmSync(ud, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
}
