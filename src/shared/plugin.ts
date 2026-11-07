// Plugin bundle format (our own design): a folder with manifest.json + a script file.
// Shared by main (validation, running) and renderer (menus, applying results).

export type PluginPlacement = 'tools' | 'cell' | 'sidebarItem'
export const PLACEMENTS: PluginPlacement[] = ['tools', 'cell', 'sidebarItem']

export interface PluginCommand { id: string; title: string; placement: PluginPlacement; shortcut?: string; handler: string }
export interface PluginManifest { id: string; name: string; version: string; description?: string; script: string; commands: PluginCommand[] }
/** A plugin on disk. `error` is set when its manifest can no longer be read (only Remove is offered then). */
export interface PluginInfo extends PluginManifest { path: string; error?: string }
export interface PluginList { dir: string; installed: PluginInfo[]; available: PluginInfo[] }

/** What the renderer hands to a command: the right-clicked cell/row/item, the editor text and so on. */
export interface PluginCtxData {
  table?: { schema: string; name: string; kind: string }
  item?: { schema: string; name: string; kind: string }
  row?: Record<string, unknown>
  column?: string
  value?: unknown
  rows?: Record<string, unknown>[]
  editorText?: string
  editorSelection?: string
}

/** Side effects a command asked for; the renderer applies them after the handler finishes. */
export interface PluginActions {
  clipboard?: string
  notifications: { title: string; body: string }[]
  cellValue?: string | null
  editorText?: string
  editorSelection?: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/ // also the install folder name, so no slashes or dots-only names
const IDENT = /^[A-Za-z_$][\w$]*$/

/** Throws an Error naming the first problem; returns a clean copy (unknown keys dropped). */
export function validateManifest(raw: unknown): PluginManifest {
  const m = raw as Record<string, unknown>
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('manifest.json must contain a JSON object')
  const str = (k: string, required = true): string | undefined => {
    const v = m[k]
    if (v === undefined && !required) return undefined
    if (typeof v !== 'string' || !v.trim()) throw new Error(`manifest.json: "${k}" must be a non-empty string`)
    return v.trim()
  }
  const id = str('id')!
  if (!ID.test(id)) throw new Error('manifest.json: "id" may only contain letters, digits, ".", "_" and "-"')
  const script = str('script')!
  if (script.startsWith('/') || script.includes('\\') || /^[A-Za-z]:/.test(script) || script.split('/').some((p) => p === '..' || p === '.' || !p))
    throw new Error('manifest.json: "script" must be a relative path inside the plugin folder')
  if (!Array.isArray(m.commands) || !m.commands.length) throw new Error('manifest.json: "commands" must be a non-empty array')
  const seen = new Set<string>()
  const commands = m.commands.map((c: Record<string, unknown>, i: number): PluginCommand => {
    const where = `manifest.json: commands[${i}]`
    if (!c || typeof c !== 'object') throw new Error(`${where} must be an object`)
    for (const k of ['id', 'title', 'handler']) if (typeof c[k] !== 'string' || !(c[k] as string).trim()) throw new Error(`${where}."${k}" must be a non-empty string`)
    const cid = (c.id as string).trim()
    if (seen.has(cid)) throw new Error(`${where}: duplicate command id "${cid}"`)
    seen.add(cid)
    if (!PLACEMENTS.includes(c.placement as PluginPlacement)) throw new Error(`${where}."placement" must be one of ${PLACEMENTS.join(', ')}`)
    const handler = (c.handler as string).trim()
    if (!IDENT.test(handler)) throw new Error(`${where}."handler" must be a function name`)
    if (c.shortcut !== undefined && (typeof c.shortcut !== 'string' || !/^([A-Za-z]+\+)+[^+\s]+$|^F([1-9]|1\d|2[0-4])$/.test(c.shortcut)))
      throw new Error(`${where}."shortcut" must be an accelerator such as CmdOrCtrl+Alt+U`)
    return { id: cid, title: (c.title as string).trim(), placement: c.placement as PluginPlacement, handler, ...(c.shortcut ? { shortcut: c.shortcut as string } : {}) }
  })
  return { id, name: str('name')!, version: str('version')!, description: str('description', false), script, commands }
}

export const emptyActions = (): PluginActions => ({ notifications: [] })

export interface ActionSinks {
  clipboard: (text: string) => unknown
  notify: (title: string, body: string) => void
  setValue?: (v: string | null) => void
  setText?: (s: string) => void
  replaceSelection?: (s: string) => void
}

/** Apply a command's actions. Returns the ones that had nowhere to go (e.g. a cell value from the Tools menu). */
export function applyActions(a: PluginActions, sinks: ActionSinks): string[] {
  const skipped: string[] = []
  if (a.clipboard !== undefined) sinks.clipboard(a.clipboard)
  for (const n of a.notifications) sinks.notify(n.title, n.body)
  const put = (v: string | null | undefined, sink: ((v: never) => void) | undefined, what: string): void => {
    if (v === undefined) return
    if (sink) sink(v as never)
    else skipped.push(what)
  }
  put(a.cellValue, sinks.setValue, 'cell value')
  put(a.editorText, sinks.setText, 'editor text')
  put(a.editorSelection, sinks.replaceSelection, 'editor selection')
  return skipped
}
