// Renderer side of plugins: cached list, menu items per placement, running commands and applying their actions.
import { create } from 'zustand'
import type { MenuItem } from '../components/ui'
import { confirmDialog } from '../components/ui'
import { applyActions, type PluginActions, type PluginCommand, type PluginCtxData, type PluginInfo, type PluginList, type PluginPlacement } from '@shared/plugin'
import { effectiveKeymap, findConflict, recordKey, sameAccel } from '@shared/keymap'
import { COMMANDS, prettyAccel } from '@shared/commands'
import { call, errText, isMac, on, setting, toast } from './api'
import { guard, ws } from './ws'

export type { PluginPlacement }
export interface PluginContext {
  table?: { schema: string; name: string; kind: string }
  row?: Record<string, unknown>
  column?: string
  value?: unknown
  rows?: Record<string, unknown>[]
  editor?: { getText: () => string; setText: (s: string) => void; getSelection: () => string; replaceSelection: (s: string) => void }
  /** Receives a cell value set by the plugin (cell placement). */
  setValue?: (v: string | null) => void
  /** Connection used by db.query; defaults to this window's session. */
  sessionId?: string
}

export const usePlugins = create<{ list: PluginList | null }>(() => ({ list: null }))

export async function refreshPlugins(next?: PluginList): Promise<PluginList> {
  const list = next ?? (await call<PluginList>('plugin.list'))
  usePlugins.setState({ list })
  return list
}
refreshPlugins().catch(() => {})

/** The table the user is looking at: the active table tab, else the first selected sidebar object. */
function currentTable(): PluginContext['table'] {
  const s = ws()
  const tab = s.tabs.find((t) => t.id === s.active)
  if (tab?.kind === 'table' && tab.name) return { schema: tab.schema ?? '', name: tab.name, kind: tab.objKind ?? 'table' }
  const o = s.selectedObjects[0]
  return o ? { schema: o.schema ?? '', name: o.name, kind: o.kind } : undefined
}

export async function runPluginCommand(p: PluginInfo, c: PluginCommand, ctx: PluginContext): Promise<void> {
  const table = ctx.table ?? currentTable()
  const data: PluginCtxData = {
    table, item: c.placement === 'sidebarItem' ? table : undefined,
    row: ctx.row, column: ctx.column, value: ctx.value, rows: ctx.rows,
    editorText: ctx.editor?.getText(), editorSelection: ctx.editor?.getSelection()
  }
  try {
    const res = await call<PluginActions>('plugin.run', p.id, c.id, data, ctx.sessionId ?? ws().sessionId)
    const skipped = applyActions(res, {
      clipboard: (t) => navigator.clipboard.writeText(t),
      notify: (title, body) => toast(body ? `${title}\n${body}` : title, 'success'),
      setValue: ctx.setValue,
      setText: ctx.editor?.setText,
      replaceSelection: ctx.editor?.replaceSelection
    })
    if (skipped.length) toast(`${p.name}: nowhere to put the ${skipped.join(', ')} from here`)
  } catch (e) {
    toast(errText(e), 'error')
  }
}

/** Menu entries for a placement (a submenu per plugin with several commands), led by a separator; [] when none. */
export function pluginMenuItems(placement: PluginPlacement, ctx: () => PluginContext): MenuItem[] {
  const items: MenuItem[] = []
  for (const p of usePlugins.getState().list?.installed ?? []) {
    const cmds = p.commands.filter((c) => c.placement === placement)
    const item = (c: PluginCommand): MenuItem => ({
      label: c.title,
      kbd: placement === 'tools' ? prettyAccel(c.shortcut, isMac) : undefined,
      onClick: () => void runPluginCommand(p, c, ctx())
    })
    if (cmds.length === 1) items.push(item(cmds[0]))
    else if (cmds.length > 1) items.push({ label: p.name, submenu: cmds.map(item) })
  }
  return items.length ? [{ sep: true }, ...items] : []
}

// db.query asked to run a statement that needs the user's OK; safe-mode levels use the regular safe-mode sheet.
on('plugin:confirm', async (token: string, sql: string, plugin: string) => {
  let ok = false
  try {
    ok = (ws().conn?.safeMode ?? 0) > 0
      ? await guard([sql])
      : await confirmDialog(`${plugin} wants to run a statement`, sql, { ok: 'Run' })
  } finally {
    void call('plugin.confirmReply', token, ok)
  }
})

// Shortcuts declared by Tools-menu commands. The page sees keys before the menu, so app shortcuts are skipped here to keep them winning.
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.defaultPrevented || !(e.metaKey || e.ctrlKey || /^F\d+$/.test(e.key))) return
  const r = recordKey(e, isMac)
  if (r.kind !== 'accel' || findConflict(r.accel, effectiveKeymap(COMMANDS, setting('keymap', {})), undefined, isMac)) return
  for (const p of usePlugins.getState().list?.installed ?? []) {
    const c = p.commands.find((x) => x.placement === 'tools' && sameAccel(x.shortcut, r.accel, isMac))
    if (c) {
      e.preventDefault()
      void runPluginCommand(p, c, {})
      return
    }
  }
})
