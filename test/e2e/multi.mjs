// One window, several connections and databases: tabs from different databases side by side (like an object explorer).
// Needs ./test/e2e/fixtures.sh up and `npx electron-vite build`.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs'
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

  // choose which databases the tree lists (like DBeaver's "Show all databases")
  await w.getByRole('treeitem', { name: 'Postgres local' }).click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'Choose Databases…' }).click()
  await w.getByRole('dialog').getByRole('checkbox', { name: 'postgres' }).uncheck()
  await w.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await w.getByText('1 more hidden').waitFor()
  assert.equal(await w.getByRole('treeitem', { name: 'postgres', exact: true }).count(), 0)
  assert.equal(await w.getByRole('treeitem', { name: 'crm', exact: true }).count(), 1)
  const pg = (await w.evaluate(() => window.api.call('conn.list'))).find((c) => c.name === 'Postgres local')
  assert.deepEqual([...pg.options.databases].sort(), ['crm', 'shop'])
  await w.screenshot({ path: join(shots, 'S51-chosen-databases.png') })
  await w.getByRole('treeitem', { name: 'Postgres local' }).click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'Show All Databases' }).click()
  await w.getByRole('treeitem', { name: 'postgres', exact: true }).waitFor()
  step('tree lists only the chosen databases; Show All Databases brings the rest back')

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

  // Export button in the table's bottom bar: whole table and current page, in the newer formats
  const out = mkdtempSync(join(tmpdir(), 'lg-export-'))
  await ea.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
    dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: `${dir}/${o.defaultPath}` })
  }, out)
  await w.getByRole('button', { name: 'Export', exact: true }).click()
  await w.getByRole('menuitem', { name: 'Whole Table…' }).click()
  await w.getByRole('dialog').getByRole('tab', { name: 'Markdown' }).click()
  await w.screenshot({ path: join(shots, 'S52-export-formats.png') })
  await w.getByRole('dialog').getByRole('button', { name: 'Export…' }).click()
  await w.getByRole('dialog').getByRole('button', { name: 'Show in folder' }).waitFor() // the job finished
  const mdLines = readFileSync(join(out, 'contacts.md'), 'utf8').trim().split('\n')
  assert.equal(mdLines.length, 44, 'header, separator and 42 rows')
  assert.match(mdLines[2], /\| Contact 1 \|/)
  await w.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await w.getByRole('button', { name: 'Export', exact: true }).click()
  await w.getByRole('menuitem', { name: 'Current Page…' }).click()
  await w.getByRole('dialog').getByRole('tab', { name: 'XML' }).click()
  await w.getByRole('dialog').getByRole('button', { name: 'Export…' }).click()
  await w.getByText(/Exported 42 rows/).waitFor()
  assert.equal(readFileSync(join(out, 'contacts.xml'), 'utf8').match(/<row>/g).length, 42)
  rmSync(out, { recursive: true, force: true })
  step('Export from the table: whole table as Markdown, current page as XML')

  // favorites: listed at the top of the tree, ⌥⌘1 opens the first one
  await w.getByRole('treeitem', { name: 'customers', exact: true }).click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'Add to Favorites' }).click()
  await w.getByRole('treeitem', { name: 'Favorites' }).waitFor()
  assert.equal(await w.getByRole('treeitem', { name: 'customers', exact: true }).count(), 2)
  await w.getByRole('tab', { name: /customers/ }).click({ button: 'middle' })
  await w.getByRole('tab', { name: /customers/ }).waitFor({ state: 'detached' })
  await w.keyboard.press('Meta+Alt+Digit1')
  await w.getByRole('tab', { name: /customers/ }).waitFor()
  await w.getByText(/of 750 rows/).waitFor()
  await w.screenshot({ path: join(shots, 'S57-favorites.png') })
  step('favorites at the top of the tree; ⌥⌘1 opens the first')

  // a query in the crm tab runs against crm
  await w.getByRole('treeitem', { name: 'contacts' }).click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'New Query Here' }).click()
  await w.getByRole('button', { name: /Run Current|Run All/ }).first().click()
  await w.getByRole('gridcell', { name: 'Contact 1', exact: true }).waitFor()
  step('New Query Here runs on that database')

  // many columns and many tabs scroll inside the grid / tab strip; the layout never grows past the window
  const fits = () => w.evaluate(() => {
    const strip = document.querySelector('.tabbar'), grid = [...document.querySelectorAll('.grid')].find((g) => g.offsetParent)
    return { win: innerWidth, doc: document.documentElement.scrollWidth, ws: document.querySelector('.ws').getBoundingClientRect().width,
      strip: strip.scrollWidth > strip.clientWidth, grid: grid ? grid.scrollWidth > grid.clientWidth : null }
  })
  await w.locator('.cm-content').last().click()
  await w.keyboard.press('Meta+A')
  await w.keyboard.insertText(`select ${Array.from({ length: 60 }, (_, i) => `${i} as column_${i}`).join(', ')}`)
  await w.getByRole('button', { name: /Run Current|Run All/ }).first().click()
  await w.getByRole('columnheader', { name: /^column_0\b/ }).waitFor()
  let f = await fits()
  assert.ok(f.ws <= f.win && f.doc <= f.win, `layout wider than the window: ${JSON.stringify(f)}`)
  assert.equal(f.grid, true, 'wide result scrolls sideways inside the grid')
  for (let i = 0; i < 15; i++) await w.locator('.tabbar').first().getByRole('button', { name: 'New SQL query' }).click()
  f = await fits()
  assert.ok(f.ws <= f.win && f.doc <= f.win, `layout wider than the window: ${JSON.stringify(f)}`)
  assert.equal(f.strip, true, 'tab strip scrolls')
  const [tabBox, stripBox] = await Promise.all([w.locator('.tab.active').first().boundingBox(), w.locator('.tabbar').first().boundingBox()])
  assert.ok(tabBox.x + tabBox.width <= stripBox.x + stripBox.width + 1, 'new tab scrolled into view')
  await w.screenshot({ path: join(shots, 'S50-many-tabs.png') })
  step('wide results and many tabs scroll in place; the newest tab is in view')

  // disconnecting one connection closes only its tabs
  await w.getByRole('treeitem', { name: 'MySQL local' }).click({ button: 'right' })
  await w.getByRole('menuitem', { name: 'Disconnect' }).click()
  await w.getByRole('tab', { name: /products/ }).waitFor({ state: 'detached' })
  assert.ok(await w.getByRole('tab', { name: /customers/ }).count())
  step('disconnecting MySQL closed only its tabs')

  // Touch ID unlock (system prompt mocked): cancelled keeps the lock, success opens it
  await ea.evaluate(({ systemPreferences }) => { systemPreferences.canPromptTouchID = () => true; systemPreferences.promptTouchID = async () => { throw new Error('cancelled') } })
  await w.evaluate(async () => { await window.api.call('settings.set', 'security.passcodeHash', 'f'.repeat(64)); await window.api.call('settings.set', 'security.touchId', true); await window.api.call('lock.set', true) })
  const lock = w.getByRole('dialog', { name: 'Lagoon is locked' })
  await lock.getByRole('button', { name: 'Use Touch ID' }).waitFor()
  await w.waitForTimeout(300)
  assert.ok(await lock.isVisible(), 'a cancelled Touch ID prompt keeps the app locked')
  await ea.evaluate(({ systemPreferences }) => { systemPreferences.promptTouchID = async () => {} })
  await lock.getByRole('button', { name: 'Use Touch ID' }).click()
  await lock.waitFor({ state: 'detached' })
  await w.evaluate(() => window.api.call('settings.set', 'security.passcodeHash', ''))
  step('Touch ID unlocks; a cancelled prompt leaves the passcode screen')

  assert.deepEqual(errors, [], errors.join('\n'))
  console.log('\nMULTI E2E OK')
} finally {
  await ea.close()
  rmSync(ud, { recursive: true, force: true })
}
