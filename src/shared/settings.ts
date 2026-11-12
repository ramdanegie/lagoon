// Every persisted preference key with its default. Read with setting(key, DEFAULTS[key]) / useSetting.
export const DEFAULTS = {
  // general
  'general.cmdTOpens': 'query' as 'query' | 'empty',
  'editor.restoreTabs': 'first' as 'none' | 'first' | 'all',
  'connections.keepAlive': true,
  'connections.queryTimeout': 300,
  'history.disabled': false,
  'history.retentionYears': 0, // 0 = keep forever
  'history.logOriginal': false,
  'paths.queries': '',
  'queries.sharedFolders': [] as string[],
  'queries.autoSave': true,
  'welcome.sortBy': 'name' as 'name' | 'tag' | 'driver',
  // table
  'table.pageSize': 300,
  'table.alternate': true,
  'table.estimateOver': 500000, // 0 = always exact COUNT(*)
  'table.defaultSort': 'none' as 'none' | 'pkAsc' | 'pkDesc',
  'table.showSystemSchemas': false,
  'sidebar.showColumns': false,
  'sidebar.match': 'fuzzy' as 'fuzzy' | 'contains',
  'filter.defaultColumn': 'pk' as 'pk' | 'any' | 'raw',
  'filter.defaultOp': '=' as '=' | 'Contains',
  'filter.state': 'remember' as 'remember' | 'show' | 'hide',
  // editor
  'editor.vim': false,
  'editor.wrap': true,
  'editor.highlightCurrent': true,
  'editor.resultMode': 'tabs' as 'tabs' | 'append',
  'editor.returnOnError': false,
  'editor.rowLimit': 1000 as number | null,
  'editor.runDefault': 'current' as 'current' | 'all',
  'editor.completeKey': 'both' as 'both' | 'enter' | 'tab',
  'editor.autoClose': true,
  'editor.autocomplete': { tables: true, functions: true, keywords: true, disabled: false, prefixSchema: false } as Record<string, boolean>,
  'format.uppercase': true,
  'format.indent': 'spaces' as 'spaces' | 'tab',
  'format.width': 2,
  'format.type': 'standard' as 'standard' | 'tabularLeft' | 'tabularRight',
  'params.enabled': false,
  'params.format': 'colon' as 'colon' | 'percent' | 'question' | 'dollarBrace' | 'dollar' | 'doubleBrace',
  'params.inQuotes': false,
  // appearance
  theme: 'auto' as string, // 'auto' | 'light' | 'dark' | built-in or custom theme name
  'themes.custom': [] as { name: string; base: 'light' | 'dark'; colors: Record<string, string> }[],
  'theme.overrides': {} as Record<string, string>, // CSS variable -> color
  'fonts.gridSize': 12,
  'fonts.editorSize': 13,
  'fonts.sidebarSize': 13,
  'fonts.gridFamily': '',
  // security
  'security.defaultSafeMode': 0,
  'security.passcodeHash': '', // sha256 hex of the passcode; '' = off
  'security.autoLockMinutes': 0,
  'security.touchId': false, // macOS: unlock with Touch ID; the passcode stays as the fallback
  // csv copy/paste
  'csv.delimiter': ',',
  'csv.quote': 'auto',
  'csv.lineBreak': '\n',
  'csv.decimal': '.',
  'tour.done': false, // legacy: true = seen
  'tour.onStartup': true,
  // explain + snippets
  'explain.analyze': false,
  'explain.threshold': 30,
  'snippets.user': [] as { id: string; name: string; prefix: string; body: string; dialects?: string[] }[],
  // keymap: command id -> accelerator (null = removed)
  keymap: {} as Record<string, string | null>
}
export type SettingKey = keyof typeof DEFAULTS
