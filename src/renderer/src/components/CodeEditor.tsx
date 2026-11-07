// CodeMirror 6 wrapper themed with our CSS variables. Used by the SQL editor and DDL tabs.
import { type ReactNode, useEffect, useRef } from 'react'
import { EditorState, Compartment, type Extension, StateField, StateEffect, type Range } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, type DecorationSet, placeholder as cmPlaceholder
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, type CompletionSource } from '@codemirror/autocomplete'
import { sql, PostgreSQL, MySQL, SQLite, type SQLNamespace } from '@codemirror/lang-sql'
import { tags as t } from '@lezer/highlight'
import { vim } from '@replit/codemirror-vim'
import type { Dialect } from '@shared/types'

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.function(t.variableName), t.standard(t.name)], color: 'var(--syn-ident)' },
  { tag: [t.special(t.name), t.quote], color: 'var(--syn-ident)' }
])

const theme = EditorView.theme({
  '&': { color: 'var(--fg)', backgroundColor: 'var(--bg-panel)', height: '100%' },
  '.cm-content': { caretColor: 'var(--focus)', padding: '6px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--focus)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--bg-panel)', color: 'var(--fg-faint)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-muted)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--bg-selected) !important' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-pop)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--fg-on-accent)' },
  '.cm-panels': { backgroundColor: 'var(--bg-elev)', color: 'var(--fg)', borderColor: 'var(--border)' },
  '.cm-panel input, .cm-panel button': { fontSize: 'var(--fs-sm)' },
  '.cm-textfield': { backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', color: 'var(--fg)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg-elev)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', color: 'var(--fg)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-active)', border: 'none', color: 'var(--fg-muted)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' }
})

// current statement highlight (set from outside)
export const setStmtRange = StateEffect.define<{ from: number; to: number } | null>()
const stmtField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) if (e.is(setStmtRange)) {
      if (!e.value || e.value.from >= e.value.to) return Decoration.none
      const doc = tr.state.doc
      const a = doc.lineAt(Math.min(e.value.from, doc.length)).number
      const b = doc.lineAt(Math.min(e.value.to, doc.length)).number
      const lines: Range<Decoration>[] = []
      for (let l = a; l <= b; l++) lines.push(Decoration.line({ class: 'cm-current-stmt' }).range(doc.line(l).from))
      return Decoration.set(lines)
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

export const sqlDialect = (d?: Dialect): typeof PostgreSQL => (d === 'mysql' ? MySQL : d === 'sqlite' ? SQLite : PostgreSQL)

export interface EditorOptions {
  dialect?: Dialect
  schema?: SQLNamespace
  defaultSchema?: string
  upperCase?: boolean
  extraCompletions?: CompletionSource
  vim?: boolean
  wrap?: boolean
  closeBrackets?: boolean
  completion?: boolean
  readOnly?: boolean
  language?: Extension
  placeholder?: string
}

export function CodeEditor(props: {
  value: string
  onChange?: (v: string) => void
  onSelection?: (view: EditorView) => void
  onView?: (view: EditorView | null) => void
  options: EditorOptions
  className?: string
  ariaLabel?: string
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const cfg = useRef(new Compartment())
  const cb = useRef(props)
  cb.current = props

  const configure = (o: EditorOptions): Extension => {
    const lang = o.language ?? sql({ dialect: sqlDialect(o.dialect), schema: o.schema, defaultSchema: o.defaultSchema, upperCaseKeywords: o.upperCase })
    const sources: CompletionSource[] = []
    if (o.extraCompletions) sources.push(o.extraCompletions)
    return [
      o.vim ? vim() : [],
      lang,
      o.extraCompletions && !o.language ? sqlDialect(o.dialect).language.data.of({ autocomplete: o.extraCompletions }) : [],
      o.completion === false ? [] : autocompletion({ activateOnTyping: true, maxRenderedOptions: 80 }),
      o.closeBrackets === false ? [] : closeBrackets(),
      o.wrap ? EditorView.lineWrapping : [],
      EditorState.readOnly.of(!!o.readOnly),
      o.placeholder ? cmPlaceholder(o.placeholder) : []
    ]
  }

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
          EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(highlight), bracketMatching(),
          rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), stmtField, theme,
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          cfg.current.of(configure(props.options)),
          EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel ?? 'Code editor' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString())
            if (u.selectionSet || u.docChanged) cb.current.onSelection?.(u.view)
          })
        ]
      })
    })
    view.current = v
    props.onView?.(v)
    return () => { props.onView?.(null); v.destroy() }
  }, [])

  // external value changes (e.g. beautify, plugin) replace the doc
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== props.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } })
  }, [props.value])

  useEffect(() => { view.current?.dispatch({ effects: cfg.current.reconfigure(configure(props.options)) }) }, [JSON.stringify({ ...props.options, schema: undefined, language: undefined, extraCompletions: undefined }), props.options.schema, props.options.extraCompletions])

  return <div ref={host} className={`editor-wrap ${props.className ?? ''}`} style={{ flex: 1, minHeight: 0 }} />
}
