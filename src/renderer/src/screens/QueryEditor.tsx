import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { undo, redo, toggleComment, toggleBlockComment } from '@codemirror/commands'
import { openSearchPanel, selectNextOccurrence } from '@codemirror/search'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { SQLNamespace } from '@codemirror/lang-sql'
import { splitStatements, statementAt, findParams, applyParams, resultName, withRowLimit, type ParamFormat } from '@shared/split'
import { call, errText, fail, focusScope, setting, toast, useCommands, useSetting } from '../lib/api'
import { useWs, ws, runSql, updateTab, type Tab } from '../lib/ws'
import { beautify, uglify } from '../lib/sqlformat'
import { pluginMenuItems } from '../lib/plugins'
import { CodeEditor, setStmtRange } from '../components/CodeEditor'
import { Icon } from '../components/Icon'
import { Modal, Resizer, menuBelow, promptDialog, type MenuItem } from '../components/ui'
import { ResultsPane, type ResultTab } from './Results'
import { flatQueries, refreshQueries } from './QueriesPanel'
import { MongoQuery } from './MongoQuery'

const LIMITS = [null, 100, 200, 500, 1000, 5000, 10000, 50000, 100000, 500000]
let persistTimer: ReturnType<typeof setTimeout> | undefined

/** Save the content of every SQL tab of this connection (restore-on-reopen). */
function persistTabs(): void {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const { conn, tabs } = ws()
    if (conn) void call('editorTabs.set', conn.id, tabs.filter((t) => t.kind === 'query' && !t.filePath).map((t) => ({ title: t.title, content: t.content ?? '' })))
  }, 800)
}

export function QueryEditor({ tab }: { tab: Tab }): ReactNode {
  const conn = useWs((s) => s.conn)
  if (conn?.driver === 'mongodb') return <MongoQuery tab={tab} />
  return <SqlEditor tab={tab} />
}

function SqlEditor({ tab }: { tab: Tab }): ReactNode {
  const s = useWs()
  const d = s.dialect ?? 'postgres'
  const [text, setText] = useState(tab.content ?? '')
  const [results, setResults] = useState<ResultTab[]>([])
  const [activeResult, setActiveResult] = useState(0)
  const [running, setRunning] = useState(false)
  const [schemaCols, setSchemaCols] = useState<SQLNamespace | undefined>()
  const [params, setParams] = useState<{ names: string[]; resolve: (v: Record<string, string> | null) => void } | null>(null)
  const [editorH, setEditorH] = useState(260)
  const [showResults, setShowResults] = useState(true)
  const [fontSize, setFontSize] = useSetting('fonts.editorSize', 13)
  const [rowLimit, setRowLimit] = useSetting<number | null>(`rowLimit.${s.conn?.id}`, setting('editor.rowLimit', 1000))
  const [runDefault, setRunDefault] = useSetting<'current' | 'all'>('editor.runDefault', 'current')
  const [vimOn, setVim] = useSetting('editor.vim', false)
  const [wrap, setWrap] = useSetting('editor.wrap', true)
  const [hlCur, setHlCur] = useSetting('editor.highlightCurrent', true)
  const [resultMode, setResultMode] = useSetting<'tabs' | 'append'>('editor.resultMode', 'tabs')
  const [stopOnError, setStopOnError] = useSetting('editor.returnOnError', false)
  const [ac, setAc] = useSetting<Record<string, boolean>>('editor.autocomplete', { tables: true, functions: true, keywords: true, disabled: false, prefixSchema: false })
  const [upper] = useSetting('format.uppercase', true)
  const [autoClose] = useSetting('editor.autoClose', true)
  const [paramsOn, setParamsOn] = useSetting('params.enabled', false)
  const [paramFmt, setParamFmt] = useSetting<ParamFormat>('params.format', 'colon')
  const view = useRef<EditorView | null>(null)
  const scope = `query-${tab.id}`

  // autocomplete schema: table -> columns of the current schema (+ other tables by name only)
  useEffect(() => {
    if (!s.sessionId || s.schema === undefined) return
    void call<Record<string, string[]>>('db.schemaColumns', s.sessionId, s.schema).then((m) => {
      const ns: Record<string, string[]> = { ...m }
      for (const o of s.objects) if (!ns[o.name] && (o.kind === 'table' || o.kind === 'view' || o.kind === 'matview')) ns[o.name] = []
      setSchemaCols(ns)
    }).catch(() => setSchemaCols(undefined))
  }, [s.sessionId, s.schema, s.objects.length])

  // keyword-bound saved queries + functions as completions
  useEffect(() => { void refreshQueries() }, [])
  const extraCompletions = useMemo(() => (ctx: CompletionContext): CompletionResult | null => {
    const w = ctx.matchBefore(/[\w$]+/)
    if (!w || (w.from === w.to && !ctx.explicit)) return null
    const opts: Completion[] = []
    for (const q of flatQueries()) for (const k of q.keywords ?? []) opts.push({ label: k, detail: `saved query · ${q.name}`, type: 'text', boost: 2, apply: async (v, _c, from, to) => { const r = await call<{ sql: string }>('queries.read', q.path); v.dispatch({ changes: { from, to, insert: r.sql } }) } })
    if (ac.functions !== false) for (const o of s.objects) if (o.kind === 'function' || o.kind === 'procedure') opts.push({ label: o.name, type: 'function', detail: o.kind })
    return opts.length ? { from: w.from, options: opts, validFor: /^[\w$]*$/ } : null
  }, [s.objects, ac.functions])

  const editorOptions = useMemo(() => ({
    dialect: d, schema: ac.disabled || ac.tables === false ? undefined : schemaCols, defaultSchema: ac.prefixSchema ? undefined : s.schema, upperCase: upper,
    extraCompletions, vim: vimOn, wrap, closeBrackets: autoClose, completion: !ac.disabled
  }), [d, schemaCols, s.schema, upper, extraCompletions, vimOn, wrap, autoClose, ac])

  const onChange = (v: string): void => {
    setText(v)
    updateTab(tab.id, { content: v })
    if (tab.filePath && setting('queries.autoSave', true)) void saveFile(v, true)
    else persistTabs()
  }

  const saveFile = async (v = text, silent = false): Promise<void> => {
    if (!tab.filePath) return
    const q = await call<{ name: string; keywords: string[] }>('queries.read', tab.filePath)
    await call('queries.write', tab.filePath, q.name, v, q.keywords)
    if (!silent) toast(`Saved "${q.name}"`)
  }

  const highlightCurrent = (v: EditorView): void => {
    if (!hlCur) return
    const sel = v.state.selection.main
    const st = sel.empty ? statementAt(v.state.doc.toString(), sel.head, d) : undefined
    v.dispatch({ effects: setStmtRange.of(st ? { from: st.from, to: st.to } : null) })
  }

  const askParams = (names: string[]): Promise<Record<string, string> | null> => new Promise((resolve) => setParams({ names, resolve }))

  const run = async (mode: 'current' | 'all'): Promise<void> => {
    const v = view.current
    if (!v || running) return
    const doc = v.state.doc.toString()
    const sel = v.state.selection.main
    let stmts: string[]
    if (!sel.empty) stmts = splitStatements(doc.slice(sel.from, sel.to), d).map((x) => x.sql)
    else if (mode === 'all') stmts = splitStatements(doc, d).map((x) => x.sql)
    else { const st = statementAt(doc, sel.head, d); stmts = st ? [st.sql] : [] }
    if (!stmts.length) { toast('Nothing to run.'); return }
    const names = stmts.map((x) => resultName(x))
    if (paramsOn) {
      const found = [...new Set(stmts.flatMap((x) => findParams(x, paramFmt, setting('params.inQuotes', false))))]
      if (found.length) {
        const vals = await askParams(found)
        if (!vals) return
        stmts = stmts.map((x) => applyParams(x, paramFmt, vals, setting('params.inQuotes', false)))
      }
    }
    const finalStmts = stmts.map((x) => withRowLimit(x, rowLimit))
    setRunning(true)
    try {
      const r = await runSql(finalStmts, { stopOnError })
      if (!r) return
      const pinned = results.filter((x) => x.pinned)
      let fresh: ResultTab[]
      if (resultMode === 'append' || r.length > 100) fresh = [{ id: crypto.randomUUID(), title: 'Results', results: r }]
      else fresh = r.map((res, i) => ({ id: crypto.randomUUID(), title: names[i] ?? `Query ${pinned.length + i + 1}`, results: [res] }))
      setResults([...pinned, ...fresh])
      const firstErr = fresh.findIndex((x) => x.results.some((y) => y.error))
      setActiveResult(pinned.length + Math.max(0, firstErr >= 0 ? firstErr : fresh.length - 1))
      setShowResults(true)
      if (r.some((x) => /^\s*(create|drop|alter)\b/i.test(x.sql) && !x.error)) window.dispatchEvent(new CustomEvent('ws:objects'))
    } catch (e) {
      fail(e)
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    const h = (e: Event): void => { if ((e as CustomEvent).detail === tab.id) void run('all') }
    window.addEventListener('query:run', h)
    return () => window.removeEventListener('query:run', h)
  })

  const cancel = async (): Promise<void> => { try { await call('db.cancel', s.sessionId); toast('Cancel requested') } catch (e) { fail(e) } }

  const formatSel = (fn: (x: string) => string): void => {
    const v = view.current
    if (!v) return
    try {
      const sel = v.state.selection.main
      const st = sel.empty ? statementAt(v.state.doc.toString(), sel.head, d) : { from: sel.from, to: sel.to, sql: v.state.sliceDoc(sel.from, sel.to) }
      if (!st) return
      v.dispatch({ changes: { from: st.from, to: st.to, insert: fn(v.state.sliceDoc(st.from, st.to)) } })
    } catch (e) { toast(`Could not format: ${errText(e)}`, 'error') }
  }

  const addToQueries = async (): Promise<void> => {
    const name = await promptDialog('Save to Queries', '', { ok: 'Save', message: 'The whole editor content is saved as a query file.' })
    if (!name?.trim()) return
    const path = await call<string>('queries.write', null, name.trim(), text, [])
    await refreshQueries()
    updateTab(tab.id, { title: name.trim(), filePath: path })
    toast('Saved to Queries', 'success')
  }

  const saveAs = async (): Promise<void> => {
    const p = await call<string | undefined>('dialog.save', { defaultPath: `${tab.title}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })
    if (p) { await call('file.write', p, text); toast('Saved') }
  }

  const cm = (f: (v: EditorView) => boolean): (() => boolean) => () => { const v = view.current; if (v && v.hasFocus) { f(v); return true } return false }

  useCommands(scope, {
    'query.runCurrent': () => void run('current'),
    'query.runAll': () => void run('all'),
    'tools.processList': () => { if (running) { void cancel(); return true } return false },
    'edit.addRow': () => formatSel((x) => beautify(x, d)),
    'query.beautify': () => formatSel((x) => beautify(x, d)),
    'query.uglify': () => formatSel(uglify),
    'edit.lineComment': cm(toggleComment),
    'edit.blockComment': cm(toggleBlockComment),
    'edit.find': cm(openSearchPanel),
    'edit.columns': cm(openSearchPanel),
    'edit.duplicate': cm(selectNextOccurrence),
    'edit.undo': cm(undo),
    'edit.redo': cm(redo),
    'edit.fontUp': () => setFontSize(Math.min(40, fontSize + 1)),
    'edit.fontDown': () => setFontSize(Math.max(9, fontSize - 1)),
    'view.results': () => setShowResults(!showResults),
    'file.saveAs': () => void saveAs(),
    'edit.commit': () => { if (tab.filePath) { void saveFile(); return true } if (ws().tabApis[tab.id]?.pendingCount()) return false; void addToQueries(); return true }
  })

  const runMenu = (): MenuItem[] => [
    { label: 'Run All', kbd: '⇧⌘↩', onClick: () => void run('all') },
    { label: 'Run Current', kbd: '⌘↩', onClick: () => void run('current') },
    { sep: true },
    { label: 'Save to Queries…', onClick: () => void addToQueries() },
    { label: 'Save SQL As…', kbd: '⇧⌘S', onClick: () => void saveAs() },
    { sep: true },
    { label: 'Run button runs', submenu: [{ label: 'Current statement', checked: runDefault === 'current', onClick: () => setRunDefault('current') }, { label: 'All statements', checked: runDefault === 'all', onClick: () => setRunDefault('all') }] }
  ]

  const gearMenu = (): MenuItem[] => [
    { label: 'Font size', submenu: [10, 11, 12, 13, 14, 16, 18, 20, 24].map((n) => ({ label: `${n}`, checked: fontSize === n, onClick: () => setFontSize(n) })) },
    { label: 'Wrap lines', checked: wrap, onClick: () => setWrap(!wrap) },
    { label: 'Highlight current statement', checked: hlCur, onClick: () => setHlCur(!hlCur) },
    { label: 'Vim key bindings', checked: vimOn, onClick: () => setVim(!vimOn) },
    { sep: true },
    { label: 'Autocomplete', submenu: [
      { label: 'Tables and columns', checked: ac.tables !== false, onClick: () => setAc({ ...ac, tables: ac.tables === false }) },
      { label: 'Functions', checked: ac.functions !== false, onClick: () => setAc({ ...ac, functions: ac.functions === false }) },
      { label: 'Prefix schema names', checked: !!ac.prefixSchema, onClick: () => setAc({ ...ac, prefixSchema: !ac.prefixSchema }) },
      { label: 'Disable all suggestions', checked: !!ac.disabled, onClick: () => setAc({ ...ac, disabled: !ac.disabled }) }
    ] },
    { label: 'Query parameters', submenu: [
      { label: 'Enable', checked: paramsOn, onClick: () => setParamsOn(!paramsOn) },
      { sep: true },
      ...(['colon', 'percent', 'question', 'dollarBrace', 'dollar', 'doubleBrace'] as ParamFormat[]).map((f) => ({ label: { colon: ':name', percent: '%name%', question: '?', dollarBrace: '${name}', dollar: '$name', doubleBrace: '{{name}}' }[f], checked: paramFmt === f, onClick: () => setParamFmt(f) }))
    ] },
    { label: 'Results', submenu: [
      { label: 'One tab per statement', checked: resultMode === 'tabs', onClick: () => setResultMode('tabs') },
      { label: 'All results in one tab', checked: resultMode === 'append', onClick: () => setResultMode('append') },
      { sep: true },
      { label: 'Stop at first error', checked: stopOnError, onClick: () => setStopOnError(!stopOnError) }
    ] },
    ...pluginMenuItems('tools', () => ({
      sessionId: s.sessionId,
      editor: {
        getText: () => view.current?.state.doc.toString() ?? '',
        setText: (x: string) => onChange(x),
        getSelection: () => { const v = view.current; return v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : '' },
        replaceSelection: (x: string) => view.current?.dispatch(view.current.state.replaceSelection(x))
      }
    }))
  ]

  return (
    <div className="col grow" style={{ minHeight: 0 }} onFocusCapture={() => focusScope(scope)}>
      <div className="col" style={{ height: showResults ? editorH : undefined, flex: showResults ? 'none' : 1, minHeight: 60 }}>
        <CodeEditor
          value={text}
          onChange={onChange}
          onSelection={highlightCurrent}
          onView={(v) => { view.current = v; if (v) setTimeout(() => v.focus(), 50) }}
          options={editorOptions}
          ariaLabel={`SQL editor ${tab.title}`}
        />
      </div>
      <div className="runbar">
        <button className="btn ghost icon sm" aria-label="Editor settings" title="Editor settings" onClick={(e) => menuBelow(e.currentTarget, gearMenu())}><Icon name="gear" size={12} /></button>
        <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>{tab.filePath ? 'Saved query · autosave' : ''}</span>
        <span className="grow" />
        <div className="seg">
          <button title="Beautify (⌘I)" onClick={() => formatSel((x) => beautify(x, d))}>Beautify</button>
          <button aria-label="Format options" onClick={(e) => menuBelow(e.currentTarget, [
            { label: 'Uglify', kbd: '⇧⌘I', onClick: () => formatSel(uglify) },
            { sep: true },
            { label: 'Indent with spaces', checked: setting('format.indent', 'spaces') === 'spaces', onClick: () => void call('settings.set', 'format.indent', 'spaces') },
            { label: 'Indent with tabs', checked: setting('format.indent', 'spaces') === 'tab', onClick: () => void call('settings.set', 'format.indent', 'tab') },
            { label: 'Indent width', submenu: [2, 4, 6, 8].map((n) => ({ label: String(n), checked: setting('format.width', 2) === n, onClick: () => void call('settings.set', 'format.width', n) })) },
            { label: 'Style', submenu: (['standard', 'tabularLeft', 'tabularRight'] as const).map((n) => ({ label: n === 'standard' ? 'Standard' : n === 'tabularLeft' ? 'Tabular, left' : 'Tabular, right', checked: setting('format.type', 'standard') === n, onClick: () => void call('settings.set', 'format.type', n) })) }
          ])}><Icon name="chevronDown" size={10} /></button>
        </div>
        <button className="btn sm" title="Row limit added to SELECT statements without LIMIT" onClick={(e) => menuBelow(e.currentTarget, LIMITS.map((n) => ({ label: n === null ? 'No limit' : `${n.toLocaleString()} rows`, checked: rowLimit === n, onClick: () => setRowLimit(n) })))}>
          {rowLimit === null ? 'No limit' : `Limit ${rowLimit.toLocaleString()}`}
        </button>
        {running ? (
          <button className="btn sm danger" onClick={() => void cancel()} title="Cancel (⌘.)"><Icon name="stop" size={10} /> Cancel</button>
        ) : (
          <div className="seg">
            <button className="on" onClick={() => void run(runDefault)} title={runDefault === 'current' ? 'Run current (⌘↩)' : 'Run all (⇧⌘↩)'}><Icon name="play" size={10} /> {runDefault === 'current' ? 'Run Current' : 'Run All'}</button>
            <button aria-label="Run options" onClick={(e) => menuBelow(e.currentTarget, runMenu())}><Icon name="chevronDown" size={10} /></button>
          </div>
        )}
      </div>
      {showResults && (
        <>
          <Resizer vertical onDrag={(dy) => setEditorH((h) => Math.max(60, Math.min(window.innerHeight - 200, h + dy)))} />
          <ResultsPane
            tabs={results}
            active={activeResult}
            onActive={setActiveResult}
            onPin={(id) => setResults(results.map((r) => (r.id === id ? { ...r, pinned: !r.pinned } : r)))}
            onClose={(id) => { setResults(results.filter((r) => r.id !== id)); setActiveResult(0) }}
            running={running}
          />
        </>
      )}
      {params && <ParamsDialog names={params.names} onDone={(v) => { params.resolve(v); setParams(null) }} />}
    </div>
  )
}

function ParamsDialog({ names, onDone }: { names: string[]; onDone: (v: Record<string, string> | null) => void }): ReactNode {
  const [vals, setVals] = useState<Record<string, string>>({})
  useEffect(() => { void call<Record<string, string>>('vars.get').then((saved) => setVals(Object.fromEntries(names.map((n) => [n, saved[n] ?? ''])))) }, [])
  const apply = (): void => { void call('vars.set', vals); onDone(vals) }
  return (
    <Modal
      title="Query parameters"
      onClose={() => onDone(null)}
      width={460}
      footer={<><button className="btn ghost" style={{ marginRight: 'auto' }} onClick={() => { void call('vars.delete', names); setVals(Object.fromEntries(names.map((n) => [n, '']))) }}>Forget values</button><button className="btn" onClick={() => onDone(null)}>Cancel</button><button className="btn primary" onClick={apply}>Run</button></>}
    >
      <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Values are inserted as typed. Add quotes for strings, e.g. 'shipped'.</div>
      {names.map((n, i) => (
        <div key={n} className="field">
          <label htmlFor={`qp-${n}`} className="mono">{n}</label>
          <input id={`qp-${n}`} className="input mono" autoFocus={i === 0} value={vals[n] ?? ''} onChange={(e) => setVals({ ...vals, [n]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || i === names.length - 1)) apply() }} />
        </div>
      ))}
    </Modal>
  )
}

