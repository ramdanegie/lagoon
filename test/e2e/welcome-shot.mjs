// Screenshot of the Welcome window (no database needed).
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
const app = resolve(import.meta.dirname, '../..')
mkdirSync(resolve(app, 'test/e2e/.shots'), { recursive: true })
const ud = mkdtempSync(join(tmpdir(), 'tc-e2e-'))
const ea = await electron.launch({ args: [join(app, 'out/main/index.js')], cwd: app, env: { ...process.env, LAGOON_USER_DATA: ud } })
const w = await ea.firstWindow()
await w.getByText('No connections yet.').waitFor()
  await w.evaluate(() => window.api.call('settings.set', 'tour.onStartup', false))
  await w.waitForTimeout(300) // the tour may have auto-opened before the setting landed
  if (await w.locator('.tour').isVisible()) await w.keyboard.press('Escape')
await w.waitForFunction(() => !document.querySelector('[inert]') && [...document.images].every((i) => i.complete && i.naturalWidth > 0))
await w.screenshot({ path: resolve(app, 'test/e2e/.shots/S01-empty.png') })
await ea.close()
rmSync(ud, { recursive: true, force: true })
console.log('ok')
