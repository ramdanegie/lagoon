// Query editor for MongoDB connections: shell (JavaScript) or database command (JSON) syntax.
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { EditorView, placeholder as cmPlaceholder } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import { vim } from '@replit/codemirror-vim'
import { call, errText, setting, shortcut, tip, useCommands } from '../lib/api'
import { busy, guard, ws, type Tab } from '../lib/ws'
import { type Doc, cellText, jsStatementAt, mongoCommandReadOnly, mongoCompletions, mongoShellReadOnly, splitJs, unionKeys } from '../lib/nosql'
import { Grid } from '../components/Grid'
import { Icon } from '../components/Icon'
import { Resizer } from '../components/ui'
import '../styles/nosql.css'

// ---------- shared CodeMirror wrapper (also used by MongoView) ----------
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg-panel)' },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-elev)', color: 'var(--fg-faint)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-row-alt)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--bg-selected)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--bg-active)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--fg)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--fg-on-accent)' },
  '.cm-placeholder': { color: 'var(--fg-faint)' }
})
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syn-ident)' },
  { tag: t.invalid, color: 'var(--danger)' }
]))

export function CodeEditor(p: { value: string; onChange?: (v: string) => void; lang: 'js' | 'json'; label: string; viewRef?: RefObject<EditorView | null>; extensions?: Extension[]; placeholder?: string; autoFocus?: boolean; style?: CSSProperties }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChange = useRef(p.onChange)
  onChange.current = p.onChange
  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          setting('editor.vim', false) ? vim() : [],
          basicSetup,
          p.lang === 'json' ? json() : javascript(),
          theme,
          highlight,
          setting('editor.wrap', true) ? EditorView.lineWrapping : [],
          EditorView.contentAttributes.of({ 'aria-label': p.label }),
          p.placeholder ? cmPlaceholder(p.placeholder) : [],
          EditorView.updateListener.of((u) => { if (u.docChanged) onChange.current?.(u.state.doc.toString()) }),
          ...(p.extensions ?? [])
        ]
      })
    })
    view.current = v
    if (p.viewRef) p.viewRef.current = v
    // after the enclosing Modal's own initial focus, which runs after child effects
    const t = p.autoFocus ? setTimeout(() => v.focus(), 0) : undefined
    return () => { clearTimeout(t); v.destroy() }
  }, [])
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== p.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value } })
  }, [p.value])
  return <div ref={host} className="editor-wrap" style={p.style} />
}

/** Read-only grid of documents with union-of-keys columns. */
export function DocsGrid({ docs }: { docs: Doc[] }): ReactNode {
  const columns = useMemo(() => unionKeys(docs).map((name) => ({ name, pk: name === '_id' })), [docs])
  const rows = useMemo(() => docs.map((d) => columns.map((c) => cellText(d[c.name]))), [docs, columns])
  return <Grid columns={columns} rows={rows} empty="No documents" />
}

// ---------- query tab ----------
type Out = { kind: 'docs'; docs: Doc[] } | { kind: 'value'; text: string } | { kind: 'error'; text: string }
type Syntax = 'shell' | 'command'

const pretty = (s: string): string => { try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s } }

function fromCommand(text: string): Out {
  const o = JSON.parse(text) as { cursor?: { firstBatch?: Doc[] } }
  return Array.isArray(o?.cursor?.firstBatch) ? { kind: 'docs', docs: o.cursor.firstBatch } : { kind: 'value', text: JSON.stringify(o, null, 2) }
}

const completion = autocompletion({
  override: [(ctx: CompletionContext) => {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const r = mongoCompletions(line.text.slice(0, ctx.pos - line.from), ws().objects.map((o) => o.name))
    return r && { from: line.from + r.from, options: r.options, validFor: /^[\w$]*$/ }
  }]
})

export function MongoQuery({ tab }: { tab: Tab }): ReactNode {
  const view = useRef<EditorView | null>(null)
  const [syntax, setSyntax] = useState<Syntax>('shell')
  const [out, setOut] = useState<(Out & { ms: number; n: number }) | null>(null)
  const [running, setRunning] = useState(false)
  const [asJson, setAsJson] = useState(false)
  const [editorH, setEditorH] = useState(220)

  const run = async (all: boolean): Promise<void> => {
    const v = view.current
    if (!v || running) return
    const text = v.state.doc.toString()
    const sel = v.state.selection.main
    const picked = sel.empty ? '' : v.state.sliceDoc(sel.from, sel.to)
    const stmts = syntax === 'command'
      ? [(picked || text).trim()].filter(Boolean)
      : picked || all ? splitJs(picked || text).map((s) => s.sql) : [jsStatementAt(text, sel.head)?.sql ?? ''].filter(Boolean)
    if (!stmts.length) return
    const read = stmts.every(syntax === 'command' ? mongoCommandReadOnly : mongoShellReadOnly)
    // reads skip the prompt on the "confirm writes" levels (2, 4); levels 1 and 3 confirm everything
    if (!(read && (ws().conn?.safeMode ?? 0) % 2 === 0) && !(await guard(stmts))) return
    const sid = ws().sessionId
    setRunning(true)
    const t0 = Date.now()
    let res: Out = { kind: 'value', text: '' }
    try {
      for (const s of stmts) {
        if (syntax === 'command') res = fromCommand(await busy(call<string>('mongo.command', sid, s)))
        else {
          const r = await busy(call<{ docs?: string[]; value?: string }>('mongo.shell', sid, s))
          res = r.docs ? { kind: 'docs', docs: r.docs.map((d) => JSON.parse(d) as Doc) } : { kind: 'value', text: pretty(r.value ?? 'null') }
        }
      }
    } catch (e) {
      res = { kind: 'error', text: errText(e) }
    } finally {
      setRunning(false)
    }
    setOut({ ...res, ms: Date.now() - t0, n: stmts.length })
  }

  useCommands(`mongoquery:${tab.id}`, {
    'query.runCurrent': () => (ws().active === tab.id ? void run(false) : false),
    'query.runAll': () => (ws().active === tab.id ? void run(true) : false)
  })

  const status = !out ? '' : out.kind === 'error' ? 'Error' : `${out.kind === 'docs' ? `${out.docs.length} document${out.docs.length === 1 ? '' : 's'} · ` : ''}${out.n > 1 ? `${out.n} statements · ` : ''}${out.ms} ms`

  return (
    <div className="nosql">
      <CodeEditor
        value={tab.content ?? ''}
        lang="js"
        label="MongoDB query"
        viewRef={view}
        extensions={[completion]}
        placeholder={'db.collection.find({ field: { $gt: 1 } })   ·   {"listCollections": 1} in command mode'}
        autoFocus
        style={{ height: editorH, flex: 'none' }}
      />
      <Resizer vertical onDrag={(d) => setEditorH((h) => Math.max(80, Math.min(900, h + d)))} />
      <div className="runbar" role="toolbar" aria-label="Query">
        <button className="btn sm primary" onClick={() => void run(false)} disabled={running} title={tip('Run current statement', 'query.runCurrent')}><Icon name="play" size={10} />Run</button>
        <button className="btn sm" onClick={() => void run(true)} disabled={running || syntax === 'command'} title={tip('Run all statements', 'query.runAll')}>Run all</button>
        <select className="select sm" aria-label="Query syntax" value={syntax} onChange={(e) => setSyntax(e.target.value as Syntax)}>
          <option value="shell">Shell (JavaScript)</option>
          <option value="command">Database command (JSON)</option>
        </select>
        <span className={`grow ellipsis ${out?.kind === 'error' ? 'danger-text' : 'muted'}`} style={{ fontSize: 'var(--fs-sm)' }} role="status">{running ? 'Running…' : status}</span>
        {out?.kind === 'docs' && (
          <div className="seg" role="group" aria-label="Result view">
            <button className={asJson ? '' : 'on'} aria-pressed={!asJson} onClick={() => setAsJson(false)}>Grid</button>
            <button className={asJson ? 'on' : ''} aria-pressed={asJson} onClick={() => setAsJson(true)}>JSON</button>
          </div>
        )}
      </div>
      {!out ? (
        <div className="empty">Write a shell expression such as <span className="mono">db.users.find({'{'}{'}'})</span> and press Run{shortcut('query.runCurrent') ? ` (${shortcut('query.runCurrent')})` : ''}.</div>
      ) : out.kind === 'docs' ? (
        asJson ? <pre className="message-view">{JSON.stringify(out.docs, null, 2)}</pre> : <DocsGrid docs={out.docs} />
      ) : (
        <pre className={`message-view ${out.kind === 'error' ? 'danger-text' : ''}`}>{out.text}</pre>
      )}
    </div>
  )
}
