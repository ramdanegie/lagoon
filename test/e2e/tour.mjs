// Feature tour: starts on first launch, walks the steps with the keyboard, remembers it was seen, restarts from Help.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import assert from 'assert/strict'

const app = resolve(import.meta.dirname, '../..')
const shots = resolve(app, 'test/e2e/.shots')
mkdirSync(shots, { recursive: true })
const ud = mkdtempSync(join(tmpdir(), 'lg-e2e-'))
const launch = () => electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: ud } })
const step = (m) => console.log('•', m)
let ea = await launch()
try {
  let w = await ea.firstWindow()
  await w.getByText('Welcome to Lagoon').waitFor({ timeout: 10000 })
  step('tour opens on first launch')
  await w.getByRole('button', { name: 'Show me' }).click()
  await w.getByText('Every connection in one place').waitFor()
  assert.ok(await w.locator('.tour-hole').count(), 'spotlight on the connection tree')
  await w.screenshot({ path: join(shots, 'S48-tour.png') })
  step('step 2 spotlights the connection tree')
  await w.keyboard.press('ArrowRight')
  await w.getByText('Add a connection').waitFor()
  await w.keyboard.press('ArrowLeft')
  await w.getByText('Every connection in one place').waitFor()
  for (let i = 0; i < 3; i++) await w.keyboard.press('ArrowRight')
  await w.getByText('Edit right in the grid').waitFor()
  await w.getByText('Open a table to see the record bar.').waitFor()
  step('keyboard navigation; missing targets show a hint')
  await w.keyboard.press('Escape')
  await w.locator('.tour').waitFor({ state: 'detached' })
  await ea.close()

  // Esc only closes: it shows again on the next launch, until "show when Lagoon opens" is unticked
  ea = await launch()
  w = await ea.firstWindow()
  await w.getByText('Welcome to Lagoon').waitFor({ timeout: 10000 })
  await w.getByLabel('Show this tour when Lagoon opens').uncheck()
  await w.getByRole('button', { name: 'Skip tour' }).click()
  await w.locator('.tour').waitFor({ state: 'detached' })
  assert.equal(await w.evaluate(() => window.api.call('settings.all').then((s) => s['tour.onStartup'])), false)
  step('closing keeps it for next launch; unticking the startup checkbox turns it off')
  await ea.close()

  ea = await launch()
  w = await ea.firstWindow()
  await w.getByText('No connections yet.').waitFor()
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(await w.locator('.tour').count(), 0, 'not shown again')
  await ea.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'help.tour'))
  await w.getByText('Welcome to Lagoon').waitFor()
  for (let i = 0; i < 12; i++) await w.keyboard.press('ArrowRight')
  await w.getByRole('button', { name: 'Start using Lagoon' }).click()
  await w.locator('.tour').waitFor({ state: 'detached' })
  step('next launch: no tour; Help ▸ Feature Tour replays all 13 steps')
  console.log('\nTOUR E2E OK')
} catch (e) { for (const [i, p] of (ea.windows?.() ?? []).entries()) await p.screenshot({ path: join(shots, `FAIL-tour-${i}.png`) }).catch(() => {}); throw e
} finally {
  await ea.close().catch(() => {})
  rmSync(ud, { recursive: true, force: true })
}
