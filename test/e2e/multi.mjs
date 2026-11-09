// One window, several connections and databases: tabs from different databases side by side (like an object explorer).
// Needs ./test/e2e/fixtures.sh up and `npx electron-vite build`.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import assert from 'assert/strict'

const app = resolve(import.meta.dirname, '../..')
const shots = resolve(app, 'test/e2e/.shots')
mkdirSync(shots, { recursive: true })
const ud = mkdtempSync(join(tmpdir(), 'lg-e2e-'))
const step = (m) => console.log('•', m)
const errors = []
const ea = await electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: ud } })
try {
  const w = await ea.firstWindow()
  w.on('pageerror', (e) => errors.push(e.message))
  await w.getByText('No connections yet.').waitFor()
  await w.evaluate(() => window.api.call('settings.set', 'tour.onStartup', false))
  await w.waitForTimeout(300) // the tour may have auto-opened before the setting landed
  if (await w.locator('.tour').isVisible()) await w.keyboard.press('Escape')
  await w.waitForFunction(() => !document.querySelector('[inert]'))
  await w.evaluate(() => window.api.call('settings.set', 'table.defaultSort', 'pkAsc'))
  await w.evaluate(async () => {
    await window.api.call('conn.save', { id: '', name: 'Postgres local', driver: 'postgres', host: '127.0.0.1', port: 54400, username: 'tc', database: 'shop', passwordMode: 'none', safeMode: 0 })
    await window.api.call('conn.save', { id: '', name: 'MySQL local', driver: 'mysql', host: '127.0.0.1', port: 33100, username: 'root', database: 'shop', passwordMode: 'none', safeMode: 0, ssl: { mode: 'DISABLED' } })
    window.dispatchEvent(new CustomEvent('connections:changed'))
  })
  await w.getByRole('treeitem', { name: 'Postgres local' }).dblclick()
  await w.getByRole('treeitem', { name: 'customers' }).dblclick()
  await w.getByText(/of 750 rows/).waitFor()
  step('connected from the tree, opened customers (shop)')

  // clicking "Tables" opens the overview: counts, sizes, sortable, double-click opens a table
  await w.getByRole('treeitem', { name: 'Tables', exact: true }).first().click()
  await w.getByRole('tab', { name: /Tables · public/ }).waitFor()
  await w.getByRole('gridcell', { name: 'orders', exact: true }).waitFor()
  await w.getByRole('button', { name: 'Count exact rows' }).click()
  await w.getByRole('gridcell', { name: '2,000', exact: true }).waitFor()
  await w.getByRole('gridcell', { name: '750', exact: true }).waitFor()
  const y = async (n) => (await w.getByRole('gridcell', { name: n, exact: true }).boundingBox()).y
  await w.getByRole('columnheader', { name: /^Rows/ }).click()
  assert.ok((await y('orders')) < (await y('customers')) && (await y('customers')) < (await y('nokey')), 'Rows sorted high to low')
  await w.getByRole('columnheader', { name: /^Rows/ }).click()
  assert.ok((await y('nokey')) < (await y('customers')), 'Rows sorted low to high')
  await w.screenshot({ path: join(shots, 'S49-tables-overview.png') })
  await w.getByRole('gridcell', { name: 'customers', exact: true }).dblclick()
  await w.getByText(/of 750 rows/).waitFor()
  step('Tables overview: exact counts, sort by rows, double-click opens the table')

  // a second database of the same connection opens in place, no new window
  await w.getByRole('treeitem', { name: 'crm', exact: true }).dblclick()
  await w.getByRole('treeitem', { name: 'contacts' }).dblclick()
  await w.getByText(/of 42 rows/).waitFor()
  assert.equal(ea.windows().length, 1)
  assert.ok(await w.locator('.tab .scope-label', { hasText: 'crm' }).count(), 'tab shows its database')
  step('second database (crm) opened in the same window; tab labelled with its database')

  // empty schemas each show one note; toggling them must not leave stale "No tables" / "Loading…" rows behind
  const notes = () => w.locator('.nav-note').filter({ hasText: /^(No tables|Loading…)$/ }).count()
  for (let i = 0; i < 3; i++) {
    for (const s of ['archive', 'staging']) await w.getByRole('treeitem', { name: s, exact: true }).locator('.nav-caret').click()
    await w.waitForTimeout(150)
  }
  await w.waitForTimeout(300) // three toggles each: both expanded now
  assert.equal(await notes(), 2, 'one note per expanded empty schema')
  for (const s of ['archive', 'staging']) await w.getByRole('treeitem', { name: s, exact: true }).locator('.nav-caret').click()
  await w.waitForTimeout(300)
  assert.equal(await notes(), 0, 'no stale notes after collapsing')
  // a pinned table is listed twice (Pinned and Tables); both rows must stay distinct
  await w.getByRole('treeitem', { name: 'contacts' }).click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'Pin to Top' }).click()
  await w.getByRole('treeitem', { name: 'contacts' }).nth(1).waitFor()
  assert.equal(await w.getByRole('treeitem', { name: 'contacts' }).count(), 2)
  await w.getByRole('treeitem', { name: 'contacts' }).first().click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'Unpin from Top' }).click()
  await w.waitForTimeout(300)
  assert.equal(await w.getByRole('treeitem', { name: 'contacts' }).count(), 1, 'unpinning leaves one row')
  step('tree notes and pinned rows never pile up')

  // a second connection in the same window
  await w.getByRole('treeitem', { name: 'MySQL local' }).dblclick()
  await w.getByRole('treeitem', { name: 'products' }).dblclick()
  await w.getByText(/of 3 rows/).waitFor()
  await w.screenshot({ path: join(shots, 'S47-multi.png') })
  step('second connection (MySQL) in the same window')

  await w.getByRole('treeitem', { name: 'Tables', exact: true }).first().click() // MySQL local sorts first
  await w.getByRole('tab', { name: /Tables · shop/ }).waitFor()
  await w.getByRole('gridcell', { name: 'products', exact: true }).waitFor()
  await w.getByRole('button', { name: 'Count exact rows' }).click()
  await w.getByRole('gridcell', { name: '3', exact: true }).waitFor()
  step('MySQL Tables overview')

  // switching back: each tab still reads its own database
  await w.getByRole('tab', { name: /customers/ }).click()
  await w.getByText(/of 750 rows/).waitFor()
  await w.getByRole('tab', { name: /contacts/ }).click()
  await w.getByText(/of 42 rows/).waitFor()
  const status = await w.locator('.status-bar').innerText()
  assert.match(status, /Postgres local[\s\S]*crm/)
  step('tabs keep their own database; status bar follows the active tab')

  // a query in the crm tab runs against crm
  await w.getByRole('treeitem', { name: 'contacts' }).click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'New Query Here' }).click()
  await w.getByRole('button', { name: /Run Current|Run All/ }).first().click()
  await w.getByRole('gridcell', { name: 'Contact 1', exact: true }).waitFor()
  step('New Query Here runs on that database')

  // disconnecting one connection closes only its tabs
  await w.getByRole('treeitem', { name: 'MySQL local' }).click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'Disconnect' }).click()
  await w.getByRole('tab', { name: /products/ }).waitFor({ state: 'detached' })
  assert.ok(await w.getByRole('tab', { name: /customers/ }).count())
  step('disconnecting MySQL closed only its tabs')

  assert.deepEqual(errors, [], errors.join('\n'))
  console.log('\nMULTI E2E OK')
} finally {
  await ea.close()
  rmSync(ud, { recursive: true, force: true })
}
