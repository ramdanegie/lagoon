// Saved queries are plain .sql files; folders are folders. Keywords live in a `-- @keywords: a, b` first line.
import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, renameSync, existsSync } from 'fs'
import { join, basename, dirname, resolve, sep } from 'path'
import { register } from './rpc'
import { getSetting } from './store'

export interface QueryNode { name: string; path: string; dir: boolean; keywords?: string[]; created?: number; modified?: number; children?: QueryNode[]; shared?: boolean }

const root = (): string => {
  const custom = getSetting<string>('paths.queries', '')
  const r = custom || join(app.getPath('userData'), 'queries')
  mkdirSync(r, { recursive: true })
  return r
}
const roots = (): string[] => [root(), ...getSetting<string[]>('queries.sharedFolders', [])]

/** Refuse paths outside the query roots. */
function safe(p: string): string {
  const abs = resolve(p)
  if (!roots().some((r) => abs === resolve(r) || abs.startsWith(resolve(r) + sep))) throw new Error('Path is outside the saved queries folders')
  return abs
}

const KW = /^--\s*@keywords:\s*(.*)$/m

export function parseQueryFile(text: string): { keywords: string[]; sql: string } {
  const m = KW.exec(text.split('\n')[0] ?? '')
  return { keywords: m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [], sql: m ? text.split('\n').slice(1).join('\n') : text }
}

function walk(dir: string, shared = false): QueryNode[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.name.endsWith('.sql'))
    .map((e) => {
      const p = join(dir, e.name)
      const st = statSync(p)
      if (e.isDirectory()) return { name: e.name, path: p, dir: true, children: walk(p, shared), created: st.birthtimeMs, modified: st.mtimeMs, shared }
      return { name: e.name.replace(/\.sql$/, ''), path: p, dir: false, keywords: parseQueryFile(readFileSync(p, 'utf8')).keywords, created: st.birthtimeMs, modified: st.mtimeMs, shared }
    })
}

register({
  'queries.root': () => root(),
  'queries.tree': () => [
    ...walk(root()),
    ...getSetting<string[]>('queries.sharedFolders', []).filter(existsSync).map((f) => ({ name: basename(f), path: f, dir: true, shared: true, children: walk(f, true) }))
  ],
  'queries.read': (_c, path: string) => ({ name: basename(path, '.sql'), ...parseQueryFile(readFileSync(safe(path), 'utf8')) }),
  'queries.write': (_c, path: string | null, name: string, sql: string, keywords: string[] = [], folder?: string) => {
    const target = safe(path ? join(dirname(path), `${name}.sql`) : join(folder || root(), `${name}.sql`))
    if (path && resolve(path) !== target) renameSync(safe(path), target)
    writeFileSync(target, (keywords.length ? `-- @keywords: ${keywords.join(', ')}\n` : '') + sql)
    return target
  },
  'queries.mkdir': (_c, parent: string | null, name: string) => mkdirSync(safe(join(parent || root(), name)), { recursive: true }),
  'queries.rename': (_c, path: string, name: string) => {
    const isDir = statSync(safe(path)).isDirectory()
    const to = safe(join(dirname(path), isDir ? name : `${name}.sql`))
    renameSync(safe(path), to)
    return to
  },
  'queries.move': (_c, path: string, folder: string) => renameSync(safe(path), safe(join(folder, basename(path)))),
  'queries.delete': (_c, path: string) => rmSync(safe(path), { recursive: true })
})
