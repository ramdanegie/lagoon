// Opens every tool screen once against the Postgres fixture (127.0.0.1:54400, db "shop") and fails on any page error.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import assert from 'assert/strict'

const app = resolve(import.meta.dirname, '../..')
const shots = resolve(app, 'test/e2e/.shots')
const errors = []
const userData = mkdtempSync(join(tmpdir(), 'tc-e2e-'))
const ea = await electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: userData } })
const send = (id) => ea.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('workspace')).forEach((w) => w.webContents.send('command', id)), id)
const step = (m) => console.log('•', m)

try {
  const welcome = await ea.firstWindow()
  await welcome.getByText('No connections yet.').waitFor()
  await welcome.waitForFunction(() => !document.querySelector('[inert]'))
  const c = await welcome.evaluate(() => window.api.call('conn.save', { id: '', name: 'Shop', driver: 'postgres', host: '127.0.0.1', port: 54400, username: 'tc', database: 'shop', passwordMode: 'none', safeMode: 0 }))
  await welcome.evaluate((id) => window.api.call('window.open', { view: 'workspace', conn: id }), c.id)
  let ws
  for (let i = 0; i < 100 && !ws; i++) { ws = ea.windows().find((w) => w.url().includes('view=workspace')); if (!ws) await new Promise((r) => setTimeout(r, 100)) }
  ws.on('pageerror', (e) => errors.push(e.message))
  ws.on('console', (m) => m.type() === 'error' && !/Autofill/.test(m.text()) && errors.push('console: ' + m.text()))
  await ws.getByRole('treeitem', { name: 'customers' }).waitFor({ timeout: 20000 })
  await ws.waitForFunction(() => !document.querySelector('[inert]'))
  const shot = (n) => ws.screenshot({ path: join(shots, n) })
  const esc = async () => { await ws.keyboard.press('Escape'); await ws.waitForTimeout(150) }

  await send('app.settings'); await ws.getByRole('dialog').first().waitFor(); await shot('S34-settings.png'); await esc(); step('Settings')
  await send('tools.metrics'); await ws.getByRole('tab', { name: /Metrics/ }).waitFor(); await ws.waitForTimeout(500); await shot('S30-metrics.png'); step('Metrics board')
  await send('tools.diagram'); await ws.getByRole('tab', { name: /Diagram/ }).waitFor(); await ws.waitForTimeout(1500); await shot('S25-diagram.png'); step('ER diagram')
  await send('tools.users'); await ws.getByRole('tab', { name: /Users/ }).waitFor(); await ws.getByText('tc', { exact: true }).first().waitFor({ timeout: 10000 }); await shot('S32-users.png'); step('User management')
  await send('tools.processList'); await ws.getByRole('dialog').first().waitFor(); await ws.waitForTimeout(500); await shot('S31-process.png'); await esc(); step('Process list')
  await ws.getByRole('treeitem', { name: 'customers' }).click()
  await ws.getByText(/of 750 rows/).waitFor()
  await send('file.exportTables'); await ws.getByRole('dialog').first().waitFor(); await shot('S27-export.png'); await esc(); step('Export tables')
  await send('file.importCsv'); await ws.getByRole('dialog').first().waitFor(); await shot('S26-import.png'); await esc(); step('Import CSV')
  await send('file.backup'); await ws.getByRole('dialog').first().waitFor(); await ws.waitForTimeout(800); await shot('S28-backup.png'); await esc(); step('Backup')
  await send('tools.plugins'); await ws.getByRole('dialog').first().waitFor(); await ws.waitForTimeout(500); await shot('S33-plugins.png'); await esc(); step('Plugin manager')
  await send('tools.search'); await ws.waitForTimeout(500); await shot('S24-search.png'); step('Search in database panel')
  for (const [cmd, name, file] of [['tools.transfer', 'Data transfer', 'S42-transfer.png'], ['tools.dataSync', 'Data synchronization', 'S43-datasync.png'], ['tools.structSync', 'Structure synchronization', 'S44-structsync.png'], ['tools.generate', 'Test data generator', 'S45-generate.png'], ['tools.dictionary', 'Data dictionary', 'S46-dictionary.png']]) {
    await send(cmd); await ws.getByRole('dialog').first().waitFor(); await ws.waitForTimeout(1200); await shot(file); await esc(); await ws.waitForTimeout(200)
    if (await ws.getByRole('dialog').count()) await esc()
    step(name)
  }
  await send('nav.openAnything'); await ws.getByPlaceholder(/Open anything/).waitFor(); await esc(); await esc(); step('Open anything')
  await send('conn.openDatabase'); await ws.getByText('shop', { exact: true }).first().waitFor(); await shot('S22-databases.png'); await esc(); step('Database picker')

  assert.deepEqual(errors, [], 'page errors:\n' + errors.join('\n'))
  console.log('\nSCREENS E2E OK')
} finally {
  await ea.close()
  rmSync(userData, { recursive: true, force: true })
}
