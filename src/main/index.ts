import { app, shell, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { COMMANDS } from '@shared/commands'
import { openStore, getSetting, pruneHistory } from './store'
import { startRpc, register } from './rpc'
import { closeAll } from './sessions'
import './queries'
import './connio'
import './jobs'
import './plugins'
import './backup'
import './users'
import './search'
import './transfer'
import './datasync'
import './structsync'
import './redislive'
import './automation'
import './generate'

const isMac = process.platform === 'darwin'
// isolated profile for automated tests
if (process.env.LAGOON_USER_DATA) app.setPath('userData', process.env.LAGOON_USER_DATA)
// 2D UI: rasterizing on the CPU keeps scrolling at 120 fps and saves ~17 MB of GPU-process memory
app.commandLine.appendSwitch('disable-gpu-rasterization')

export function openWindow(params: Record<string, string> = { view: 'main' }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 480,
    show: false,
    title: 'Lagoon',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#1e1f22',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, spellcheck: false, v8CacheOptions: 'bypassHeatCheck' }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // never navigate away from the app bundle
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  const q = new URLSearchParams(params).toString()
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${q}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { search: q })
  return win
}

function accelFor(id: string, def?: string): string | undefined {
  const custom = getSetting<Record<string, string | null>>('keymap', {})
  const a = id in custom ? custom[id] ?? undefined : def
  if (!a || isMac) return a
  return a.replace('CmdOrCtrl+Ctrl+', 'Ctrl+Alt+Shift+')
}

export function buildMenu(): void {
  const send = (id: string) => () => BrowserWindow.getFocusedWindow()?.webContents.send('command', id)
  const group = (menu: string): MenuItemConstructorOptions[] =>
    COMMANDS.filter((c) => c.menu === menu).flatMap((c) => [
      ...(c.sep ? [{ type: 'separator' as const }] : []),
      { label: c.label, accelerator: accelFor(c.id, c.accel), click: send(c.id) }
    ])
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, ...group('App'), { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
    { label: 'File', submenu: [...group('File'), ...(isMac ? [] : [{ type: 'separator' as const }, ...group('App'), { role: 'quit' as const }])] },
    // cut/copy/paste/selectAll keep their roles so text inputs work; the grid listens to the DOM copy/paste events
    { label: 'Edit', submenu: [...group('Edit').slice(0, 2), { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, ...group('Edit').slice(2)] },
    { label: 'View', submenu: [...group('View'), { type: 'separator' }, { role: 'togglefullscreen' }, ...(is.dev ? [{ role: 'toggleDevTools' as const }] : [])] },
    { label: 'Tools', submenu: group('Tools') },
    { label: 'Connection', submenu: group('Connection') },
    { label: 'Navigate', submenu: group('Navigate') },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Feature Tour', click: send('help.tour') }, { label: 'Keyboard Shortcuts', click: send('help.shortcuts') }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('app.lagoon')
  // packaged builds use build/icon.icns; in dev the Dock would show Electron's icon
  if (isMac && is.dev) app.dock?.setIcon(icon)
  openStore()
  pruneHistory()
  startRpc()
  register({
    'window.open': (_c, params: Record<string, string>) => void openWindow(params),
    'window.close': (c) => c.win?.close(),
    'window.setTitle': (c, t: string) => c.win?.setTitle(t),
    'menu.rebuild': () => buildMenu(),
    'app.takeFiles': () => incoming.splice(0)
  })
  buildMenu()
  // a .sqlite file passed on the command line opens straight into a workspace
  const file = process.argv.slice(1).find((a) => /\.(sqlite3?|db)$/i.test(a))
  incoming.push(...process.argv.slice(1).filter((a) => /\.sql$/i.test(a)))
  openWindow(file ? { view: 'main', file } : { view: 'main' })
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && openWindow())
})

// Files handed to the app (Finder, Open With, command line) wait here until a window takes them; on a cold start
// macOS sends open-file before the app is ready, so nothing can be opened right away.
const incoming: string[] = []
app.on('open-file', (e, path) => {
  e.preventDefault()
  incoming.push(path)
  if (!app.isReady()) return
  const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (w) { w.show(); w.webContents.send('files:incoming') } else openWindow()
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('before-quit', () => void closeAll())
