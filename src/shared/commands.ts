// Every app command: id, label, menu placement and default accelerator (Electron syntax).
// Main builds the native menu from this; renderer uses it for tooltips and the keymap editor.
export interface Command { id: string; label: string; menu: string; accel?: string; rebindable?: boolean; sep?: boolean }

export const COMMANDS: Command[] = [
  { id: 'app.settings', label: 'Settings…', menu: 'App', accel: 'CmdOrCtrl+,' },
  { id: 'file.newWindow', label: 'New Window', menu: 'File', accel: 'CmdOrCtrl+N' },
  { id: 'file.open', label: 'Open File…', menu: 'File', accel: 'CmdOrCtrl+O' },
  { id: 'file.saveAs', label: 'Save SQL As…', menu: 'File', accel: 'CmdOrCtrl+Shift+S' },
  { id: 'file.backup', label: 'Backup Database…', menu: 'File', sep: true },
  { id: 'file.restore', label: 'Restore Database…', menu: 'File' },
  { id: 'file.exportTables', label: 'Export Tables…', menu: 'File', accel: 'CmdOrCtrl+Shift+E', sep: true },
  { id: 'file.importCsv', label: 'Import from CSV…', menu: 'File' },
  { id: 'file.importJson', label: 'Import from JSON…', menu: 'File' },
  { id: 'file.importExcel', label: 'Import from Excel…', menu: 'File' },
  { id: 'file.importSql', label: 'Import SQL Dump…', menu: 'File' },
  { id: 'file.closeTab', label: 'Close Tab', menu: 'File', accel: 'CmdOrCtrl+W', sep: true },

  { id: 'edit.undo', label: 'Undo', menu: 'Edit', accel: 'CmdOrCtrl+Z' },
  { id: 'edit.redo', label: 'Redo', menu: 'Edit', accel: 'CmdOrCtrl+Shift+Z' },
  { id: 'edit.commit', label: 'Commit Changes', menu: 'Edit', accel: 'CmdOrCtrl+S', sep: true },
  { id: 'edit.discard', label: 'Discard Changes', menu: 'Edit', accel: 'CmdOrCtrl+Shift+Backspace' },
  { id: 'edit.preview', label: 'Preview Changes', menu: 'Edit', accel: 'CmdOrCtrl+Shift+P' },
  { id: 'edit.addRow', label: 'Add Row / Item', menu: 'Edit', accel: 'CmdOrCtrl+I', sep: true },
  { id: 'edit.duplicate', label: 'Duplicate Rows', menu: 'Edit', accel: 'CmdOrCtrl+D' },
  { id: 'edit.copyCells', label: 'Copy Selected Cells', menu: 'Edit', accel: 'CmdOrCtrl+Shift+C' },
  { id: 'edit.pasteCells', label: 'Paste to Selected Cells', menu: 'Edit', accel: 'CmdOrCtrl+Shift+V' },
  { id: 'edit.find', label: 'Find / Filter', menu: 'Edit', accel: 'CmdOrCtrl+F', sep: true },
  { id: 'edit.columns', label: 'Columns / Find and Replace', menu: 'Edit', accel: 'CmdOrCtrl+Alt+F' },
  { id: 'edit.findSidebar', label: 'Find Items in Sidebar', menu: 'Edit', accel: 'CmdOrCtrl+Shift+F' },
  { id: 'edit.lineComment', label: 'Toggle Line Comment', menu: 'Edit', accel: 'CmdOrCtrl+/', rebindable: true, sep: true },
  { id: 'edit.blockComment', label: 'Toggle Block Comment', menu: 'Edit', accel: 'CmdOrCtrl+Alt+/', rebindable: true },
  { id: 'edit.fontUp', label: 'Increase Font Size', menu: 'Edit', accel: 'CmdOrCtrl+=', rebindable: true },
  { id: 'edit.fontDown', label: 'Decrease Font Size', menu: 'Edit', accel: 'CmdOrCtrl+-', rebindable: true },

  { id: 'view.left', label: 'Toggle Left Sidebar', menu: 'View', accel: 'CmdOrCtrl+0' },
  { id: 'view.right', label: 'Toggle Right Sidebar', menu: 'View' },
  { id: 'view.console', label: 'Toggle Console Log', menu: 'View', accel: 'CmdOrCtrl+Ctrl+C' },
  { id: 'view.results', label: 'Toggle Query Results Pane', menu: 'View', accel: 'Ctrl+`' },
  { id: 'view.theme', label: 'Toggle Light / Dark', menu: 'View', sep: true },

  { id: 'tools.processList', label: 'Process List', menu: 'Tools', accel: 'CmdOrCtrl+.' },
  { id: 'tools.diagram', label: 'Show Diagram', menu: 'Tools' },
  { id: 'tools.metrics', label: 'Metrics Board', menu: 'Tools' },
  { id: 'tools.users', label: 'User Management', menu: 'Tools' },
  { id: 'tools.search', label: 'Search in Database…', menu: 'Tools' },
  { id: 'tools.transfer', label: 'Data Transfer…', menu: 'Tools', sep: true },
  { id: 'tools.dataSync', label: 'Data Synchronization…', menu: 'Tools' },
  { id: 'tools.structSync', label: 'Structure Synchronization…', menu: 'Tools' },
  { id: 'tools.generate', label: 'Generate Test Data…', menu: 'Tools' },
  { id: 'tools.dictionary', label: 'Data Dictionary…', menu: 'Tools' },
  { id: 'tools.plugins', label: 'Manage Plugins…', menu: 'Tools', accel: 'CmdOrCtrl+L', sep: true },

  { id: 'conn.new', label: 'New Connection…', menu: 'Connection' },
  { id: 'conn.edit', label: 'Edit Connection…', menu: 'Connection' },
  { id: 'conn.openDatabase', label: 'Open a Database…', menu: 'Connection', accel: 'CmdOrCtrl+K', sep: true },
  { id: 'conn.openConnection', label: 'Open a Connection…', menu: 'Connection', accel: 'CmdOrCtrl+Shift+K' },
  { id: 'query.runCurrent', label: 'Run Current Query', menu: 'Connection', accel: 'CmdOrCtrl+Enter', rebindable: true, sep: true },
  { id: 'query.runAll', label: 'Run All Queries', menu: 'Connection', accel: 'CmdOrCtrl+Shift+Enter', rebindable: true },
  { id: 'query.explain', label: 'Explain Current Query', menu: 'Connection', accel: 'CmdOrCtrl+Alt+E', rebindable: true },
  { id: 'query.beautify', label: 'Beautify SQL', menu: 'Connection' },
  { id: 'query.uglify', label: 'Uglify SQL', menu: 'Connection', accel: 'CmdOrCtrl+Shift+I' },
  { id: 'conn.reloadWorkspace', label: 'Reload Workspace', menu: 'Connection', accel: 'CmdOrCtrl+R', sep: true },
  { id: 'conn.reloadTab', label: 'Reload Current Tab', menu: 'Connection', accel: 'CmdOrCtrl+Alt+R' },
  { id: 'conn.reconnect', label: 'Reconnect', menu: 'Connection', accel: 'CmdOrCtrl+Shift+R' },
  { id: 'conn.disconnect', label: 'Disconnect', menu: 'Connection', accel: 'CmdOrCtrl+Alt+.' },

  { id: 'nav.openAnything', label: 'Open Anything', menu: 'Navigate', accel: 'CmdOrCtrl+P' },
  { id: 'nav.newTab', label: 'New Tab', menu: 'Navigate', accel: 'CmdOrCtrl+T' },
  { id: 'nav.newQuery', label: 'New SQL Query', menu: 'Navigate', accel: 'CmdOrCtrl+E' },
  { id: 'nav.showData', label: 'Show Table Data', menu: 'Navigate', accel: 'CmdOrCtrl+Ctrl+[', rebindable: true, sep: true },
  { id: 'nav.showStructure', label: 'Show Table Structure', menu: 'Navigate', accel: 'CmdOrCtrl+Ctrl+]', rebindable: true },
  { id: 'nav.nextTab', label: 'Select Next Tab', menu: 'Navigate', accel: 'CmdOrCtrl+]', rebindable: true, sep: true },
  { id: 'nav.prevTab', label: 'Select Previous Tab', menu: 'Navigate', accel: 'CmdOrCtrl+[', rebindable: true },
  { id: 'nav.nextPane', label: 'Select Next Pane', menu: 'Navigate', accel: 'CmdOrCtrl+Alt+]', rebindable: true },
  { id: 'nav.prevPane', label: 'Select Previous Pane', menu: 'Navigate', accel: 'CmdOrCtrl+Alt+[', rebindable: true },
  { id: 'nav.splitRight', label: 'Split Pane Right', menu: 'Navigate', accel: 'CmdOrCtrl+Shift+D' },
  { id: 'nav.back', label: 'Go Back', menu: 'Navigate', accel: 'CmdOrCtrl+Ctrl+Left', sep: true },
  { id: 'nav.forward', label: 'Go Forward', menu: 'Navigate', accel: 'CmdOrCtrl+Ctrl+Right' },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `nav.tab${i + 1}`, label: `Select Tab ${i + 1}`, menu: 'Navigate', accel: `CmdOrCtrl+${i + 1}`, sep: i === 0 }))
]

/** Human label for an accelerator, e.g. CmdOrCtrl+Shift+S → ⇧⌘S on macOS. */
export function prettyAccel(a: string | undefined, mac: boolean): string {
  if (!a) return ''
  const parts = a.split('+')
  if (!mac) return parts.map((p) => (p === 'CmdOrCtrl' ? 'Ctrl' : p)).join('+')
  const map: Record<string, string> = { CmdOrCtrl: '⌘', Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Backspace: '⌫', Left: '←', Right: '→', Up: '↑', Down: '↓', Escape: '⎋' }
  const order = ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl', 'Cmd']
  const mods = parts.slice(0, -1).sort((x, y) => order.indexOf(x) - order.indexOf(y))
  return [...mods, parts[parts.length - 1]].map((p) => map[p] ?? p).join('')
}
