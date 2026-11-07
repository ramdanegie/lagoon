// End-to-end smoke test: drives the built app with Playwright's Electron support.
// Needs a Postgres on 127.0.0.1:54400 (user tc, trust auth) with the "shop" fixture, and `npx electron-vite build` first.
// Usage: node test/e2e/smoke.mjs
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
import assert from 'assert/strict'

const app = resolve(import.meta.dirname, '../..')
const shots = resolve(app, 'test/e2e/.shots')
mkdirSync(shots, { recursive: true })
const psql = (sql) => execSync(`psql -h 127.0.0.1 -p 54400 -U tc -d shop -At -c "${sql}"`, { encoding: 'utf8' }).trim()
const step = (m) => console.log('•', m)

psql("update customers set name = 'Customer 1' where id = 1")
const userData = mkdtempSync(join(tmpdir(), 'tc-e2e-'))
const electronApp = await electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: userData } })
const command = (id) => electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find((w) => w.isFocused() || true)?.webContents.send('command', id), id)

try {
  const welcome = await electronApp.firstWindow()
  welcome.on('console', (m) => m.type() === 'error' && console.log('  [welcome console]', m.text()))
  await welcome.setViewportSize?.({ width: 860, height: 560 })
  await welcome.getByText('No saved connections yet.').waitFor()
  await welcome.waitForFunction(() => !document.querySelector('[inert]'))
  await welcome.screenshot({ path: join(shots, 'S01-empty.png') })
  step('welcome empty state')

  await welcome.evaluate(() => window.api.call('settings.set', 'table.defaultSort', 'pkAsc'))
  await welcome.getByRole('button', { name: 'Create connection' }).first().click()
  await welcome.getByRole('option', { name: /PostgreSQL/ }).click()
  await welcome.getByRole('button', { name: 'Create', exact: true }).click()
  await welcome.getByLabel('Name').fill('Shop (e2e)')
  await welcome.getByLabel('Host').fill('127.0.0.1')
  await welcome.getByLabel('Port').fill('54400')
  await welcome.getByLabel('User').fill('tc')
  await welcome.getByLabel('Password storage').selectOption('none')
  await welcome.getByLabel('Database', { exact: true }).fill('shop')
  await welcome.getByRole('button', { name: 'Test', exact: true }).click()
  await welcome.getByText(/Connected · server/).waitFor({ timeout: 15000 })
  await welcome.screenshot({ path: join(shots, 'S03-form.png') })
  step('connection test ok')

  await welcome.getByRole('button', { name: 'Connect', exact: true }).click()
  let ws
  for (let i = 0; i < 100 && !ws; i++) { ws = electronApp.windows().find((w) => w.url().includes('view=workspace')); if (!ws) await new Promise((r) => setTimeout(r, 100)) }
  assert.ok(ws, 'workspace window opened')
  ws.on('console', (m) => m.type() === 'error' && console.log('  [workspace console]', m.text()))
  ws.on('pageerror', (e) => console.log('  [workspace pageerror]', e.message))
  await ws.getByRole('treeitem', { name: 'customers' }).waitFor({ timeout: 20000 })
  step('workspace opened, sidebar lists tables')

  await ws.getByRole('treeitem', { name: 'customers' }).click()
  await ws.getByText(/of 750 rows/).waitFor({ timeout: 15000 })
  await ws.screenshot({ path: join(shots, 'S10-table-data.png') })
  step('customers table: 750 rows counted, first page loaded')

  // edit a cell → preview → commit
  const cell = ws.getByRole('gridcell', { name: 'Customer 1', exact: true })
  await cell.dblclick()
  await ws.getByLabel('Edit name').fill('Renamed by e2e')
  await ws.keyboard.press('Enter')
  await ws.getByText('1 pending').waitFor()
  await ws.getByTitle(/Preview SQL/).click()
  await ws.getByText(/UPDATE "public"."customers" SET "name" = 'Renamed by e2e' WHERE "id" = 1;/).waitFor()
  await ws.screenshot({ path: join(shots, 'S15-preview.png') })
  await ws.getByRole('button', { name: 'Commit', exact: true }).click()
  await ws.getByText(/change committed/).waitFor()
  assert.equal(psql('select name from customers where id = 1'), 'Renamed by e2e')
  step('edit + preview + commit wrote to the database')

  // add a row, delete it again via discard
  await ws.getByRole('button', { name: /Row/ }).first().click()
  await ws.getByText('1 pending').waitFor()
  await ws.getByTitle(/Discard changes/).click()
  await ws.getByText('1 pending').waitFor({ state: 'detached' })
  step('add row + discard')

  // filter
  await ws.getByRole('button', { name: /^Filters/ }).click()
  await ws.getByLabel('Column').first().selectOption('city')
  await ws.getByLabel('Value').first().fill('Berlin')
  await ws.getByLabel('Value').first().press('Enter')
  await ws.getByText(/of 187 rows/).waitFor()
  await ws.screenshot({ path: join(shots, 'S10-filtered.png') })
  step('filter city = Berlin → 187 rows')

  // structure view
  await ws.getByRole('tab', { name: 'Structure' }).click()
  await ws.getByRole('gridcell', { name: 'created_at' }).waitFor()
  await ws.screenshot({ path: join(shots, 'S11-structure.png') })
  step('structure view')

  // table without key is read-only
  await ws.getByRole('treeitem', { name: 'nokey' }).click()
  await ws.getByText('Read-only (no key)').waitFor()
  step('table without a key is read-only')

  // SQL editor
  await command('nav.newQuery')
  await ws.locator('.cm-content').first().waitFor()
  await ws.locator('.cm-content').last().click()
  await ws.keyboard.type("select city, count(*) as n from customers group by city order by city;\nselect 1/0;")
  await ws.getByRole('button', { name: /Run Current|Run All/ }).first().click()
  await ws.getByRole('button', { name: 'Run options' }).click()
  await ws.getByRole('menuitem', { name: /Run All/ }).click()
  await ws.getByRole('tab', { name: 'Query 1', exact: true }).click()
  await ws.getByRole('gridcell', { name: 'Jakarta' }).waitFor()
  await ws.screenshot({ path: join(shots, 'S17-query.png') })
  await ws.getByRole('tab', { name: 'Query 2', exact: true }).click()
  await ws.getByText(/division by zero/).first().waitFor()
  step('SQL editor: two statements, result tabs, error tab')

  // Visual Explain on the first statement
  await ws.locator('.cm-content').last().click()
  await ws.keyboard.press('Meta+ArrowUp')
  await ws.getByRole('button', { name: 'Explain', exact: true }).click()
  await ws.getByText(/Seq Scan|HashAggregate|Sort/).first().waitFor({ timeout: 15000 })
  await ws.screenshot({ path: join(shots, 'S17-explain.png') })
  step('Visual Explain renders a plan tree')

  // Open Anything
  await command('nav.openAnything')
  await ws.getByPlaceholder(/Open anything/).fill('ord')
  await ws.getByRole('option', { name: /order_summary/ }).waitFor()
  await ws.screenshot({ path: join(shots, 'S21-open-anything.png') })
  await ws.keyboard.press('Escape'); await ws.keyboard.press('Escape')
  step('open anything finds order_summary')

  // safe mode: Alert 1 asks before a read
  await ws.getByRole('button', { name: 'Safe mode' }).click()
  await ws.getByRole('menuitem', { name: /Alert 1/ }).click()
  await ws.getByRole('treeitem', { name: 'orders' }).click()
  await ws.getByText(/of 2,000 rows/).waitFor()
  step('safe mode switched (reads in table view are not gated)')

  console.log('\nE2E OK — screenshots in', shots)
} finally {
  await electronApp.close()
}
