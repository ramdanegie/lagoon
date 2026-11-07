// Renders docs/design/Lagoon App Icon.html to PNG with Electron (no extra deps).
// Usage: npx electron scripts/render-icon.cjs <outDir>
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('fs')
const { join, resolve } = require('path')

const out = resolve(process.argv[2] || 'build/icon-src')
const page = resolve(__dirname, '../docs/design/Lagoon App Icon.html')
mkdirSync(out, { recursive: true })

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  for (const [search, file, w, h] of [['raw=full', 'icon-1024.png', 1024, 1024], ['raw=small', 'icon-small-1024.png', 1024, 1024], ['', 'sheet.png', 1880, 1120]]) {
    win.setContentSize(w, h)
    await win.loadFile(page, { search })
    await new Promise((r) => setTimeout(r, 500))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h })
    writeFileSync(join(out, file), img.toPNG())
    console.log(file, img.getSize())
  }
  app.quit()
})
