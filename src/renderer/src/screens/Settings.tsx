import { type ReactNode, type KeyboardEvent, type InputHTMLAttributes, createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { format as formatSql } from 'sql-formatter'
import { DEFAULTS, type SettingKey } from '@shared/settings'
import { COMMANDS, prettyAccel, type Command } from '@shared/commands'
import { SAFE_MODES } from '@shared/types'
import { effectiveKeymap, findConflict, isColor, joinColor, parseThemes, recordKey, setBinding, sha256Hex, splitColor, type ThemeJson } from '@shared/keymap'
import { call, fail, focusScope, isMac, toast, useCommands, useSetting, useSettings } from '../lib/api'
import { BUILTIN_THEMES, type CustomTheme } from '../lib/theme'
import { Modal, confirmDialog, promptDialog } from '../components/ui'
import '../styles/settings.css'

// ---------- typed setting controls ----------
type V<K extends SettingKey> = (typeof DEFAULTS)[K]
type KeysOf<T> = { [K in SettingKey]: V<K> extends T ? K : never }[SettingKey]
const useS = <K extends SettingKey>(k: K): [V<K>, (v: V<K>) => void] => useSetting<V<K>>(k, DEFAULTS[k])

/** Lower-cased search text; rows whose label does not contain it render nothing (CSS then hides empty groups/panes). */
const Query = createContext('')
const matches = (q: string, label: string): boolean => !q || label.toLowerCase().includes(q)

function Row({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }): ReactNode {
  if (!matches(useContext(Query), label)) return null
  return (
    <div className="set-row">
      {htmlFor ? <label className="set-label" htmlFor={htmlFor}>{label}</label> : <span className="set-label">{label}</span>}
      <div className="set-ctl" role={htmlFor ? undefined : 'group'} aria-label={htmlFor ? undefined : label}>{children}{hint && <span className="set-hint">{hint}</span>}</div>
    </div>
  )
}

const Group = ({ title, children }: { title?: string; children: ReactNode }): ReactNode => (
  <div className="set-group">{title && <h3>{title}</h3>}{children}</div>
)

function Toggle({ k, label, hint }: { k: KeysOf<boolean>; label: string; hint?: ReactNode }): ReactNode {
  const [v, set] = useS(k)
  const id = useId()
  return <Row label={label} htmlFor={id} hint={hint}><input id={id} type="checkbox" checked={v as boolean} onChange={(e) => set(e.target.checked)} /></Row>
}

function Select<K extends SettingKey>({ k, label, options, hint }: { k: K; label: string; options: [V<K>, string][]; hint?: ReactNode }): ReactNode {
  const [v, set] = useS(k)
  const id = useId()
  return (
    <Row label={label} htmlFor={id} hint={hint}>
      <select id={id} className="select" value={options.findIndex(([o]) => o === v)} onChange={(e) => set(options[+e.target.value][0])}>
        {options.map(([, l], i) => <option key={i} value={i}>{l}</option>)}
      </select>
    </Row>
  )
}

/** Text that commits on Enter or blur, so half-typed values never reach the store. */
function Draft({ value, onCommit, ...rest }: { value: string; onCommit: (s: string) => string | void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): ReactNode {
  const [text, setText] = useState(value)
  const [prev, setPrev] = useState(value)
  if (value !== prev) { setPrev(value); setText(value) } // store changed underneath (reset, another window)
  const commit = (): void => { if (text !== value) setText(onCommit(text) ?? text) }
  return <input className="input" {...rest} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
}

function NumberField({ k, label, min, max, hint }: { k: KeysOf<number>; label: string; min: number; max: number; hint?: ReactNode }): ReactNode {
  const [v, set] = useS(k)
  const id = useId()
  return (
    <Row label={label} htmlFor={id} hint={hint}>
      <Draft id={id} type="number" min={min} max={max} value={String(v)} onCommit={(t) => {
        const n = Math.round(Number(t))
        if (!t.trim() || !Number.isFinite(n)) return String(v)
        const c = Math.min(max, Math.max(min, n))
        set(c as never)
        return String(c)
      }} />
    </Row>
  )
}

function TextField({ k, label, placeholder }: { k: KeysOf<string>; label: string; placeholder?: string }): ReactNode {
  const [v, set] = useS(k)
  const id = useId()
  return <Row label={label} htmlFor={id}><Draft id={id} className="input grow" value={v as string} placeholder={placeholder} onCommit={(t) => set(t.trim() as never)} /></Row>
}

// ---------- panes ----------
function General(): ReactNode {
  return (
    <>
      <Group title="Application">
        <Select k="general.cmdTOpens" label={`${isMac ? '⌘T' : 'Ctrl+T'} opens`} options={[['query', 'A new SQL editor'], ['empty', 'An empty tab']]} />
        <Select k="editor.restoreTabs" label="Reopen SQL editor tabs" options={[['none', 'None'], ['first', 'First tab only'], ['all', 'All tabs']]} />
      </Group>
      <Group title="Connections">
        <Toggle k="connections.keepAlive" label="Keep connections alive" hint="Pings the server every 30 seconds" />
        <NumberField k="connections.queryTimeout" label="Query timeout (seconds)" min={1} max={86400} />
      </Group>
      <Group title="Query history">
        <Toggle k="history.disabled" label="Turn off query history" />
        <Select k="history.retentionYears" label="Keep history for" options={[[0, 'Forever'], [1, '1 year'], [2, '2 years'], [3, '3 years']]} />
        <Toggle k="history.logOriginal" label="Log original values on update and delete" />
      </Group>
    </>
  )
}

function Table(): ReactNode {
  return (
    <>
      <Group title="Data">
        <NumberField k="table.pageSize" label="Rows per page" min={10} max={100000} />
        <Toggle k="table.alternate" label="Alternating row colors" />
        <NumberField k="table.estimateOver" label="Estimate row count above" min={0} max={1e12} hint="0 = always count exactly" />
        <Select k="table.defaultSort" label="Default sort" options={[['none', 'None'], ['pkAsc', 'Primary key, ascending'], ['pkDesc', 'Primary key, descending']]} />
        <Toggle k="table.showSystemSchemas" label="Show system schemas" />
      </Group>
      <Group title="Sidebar">
        <Toggle k="sidebar.showColumns" label="Show columns under tables" />
        <Select k="sidebar.match" label="Sidebar search matching" options={[['fuzzy', 'Fuzzy'], ['contains', 'Contains']]} />
      </Group>
      <Group title="Filters">
        <Select k="filter.defaultColumn" label="Default filter column" options={[['pk', 'Primary key'], ['any', 'Any column'], ['raw', 'Raw SQL']]} />
        <Select k="filter.defaultOp" label="Default filter operator" options={[['=', 'Equals (=)'], ['Contains', 'Contains']]} />
        <Select k="filter.state" label="Filter bar" options={[['remember', 'Remember per table'], ['show', 'Always show'], ['hide', 'Always hide']]} />
      </Group>
    </>
  )
}

const ROW_LIMITS = [100, 200, 500, 1000, 5000, 10000, 50000, 100000, 500000]
const SAMPLE_SQL = 'select c.id, c.name, count(o.id) as orders from customers c left join orders o on o.customer_id = c.id where c.active = true group by c.id, c.name order by orders desc limit 10;'
const PARAMS: [V<'params.format'>, string, string][] = [
  ['colon', ':name', ':id'], ['percent', '%name%', '%id%'], ['question', '?', '?'], ['dollarBrace', '${name}', '${id}'], ['dollar', '$name', '$id'], ['doubleBrace', '{{name}}', '{{id}}']
]

function AutoToggle({ part, label }: { part: string; label: string }): ReactNode {
  const [v, set] = useS('editor.autocomplete')
  const id = useId()
  return <Row label={label} htmlFor={id}><input id={id} type="checkbox" checked={!!v[part]} disabled={part !== 'disabled' && !!v.disabled} onChange={(e) => set({ ...v, [part]: e.target.checked })} /></Row>
}

function Editor(): ReactNode {
  const [upper] = useS('format.uppercase')
  const [indent] = useS('format.indent')
  const [width] = useS('format.width')
  const [type] = useS('format.type')
  const [pf] = useS('params.format')
  let preview: string
  try {
    preview = formatSql(SAMPLE_SQL, { keywordCase: upper ? 'upper' : 'preserve', useTabs: indent === 'tab', tabWidth: width, indentStyle: type })
  } catch (e) {
    preview = String((e as Error).message)
  }
  const ex = PARAMS.find((p) => p[0] === pf)?.[2] ?? ':id'
  return (
    <>
      <Group title="Editing">
        <Select k="editor.vim" label="Key bindings" options={[[false, 'Standard (Sublime-style)'], [true, 'Vim']]} />
        <Toggle k="editor.wrap" label="Wrap long lines" />
        <Toggle k="editor.highlightCurrent" label="Highlight current statement" />
        <Toggle k="editor.autoClose" label="Auto-close brackets and quotes" />
        <Select k="editor.completeKey" label="Accept suggestion with" options={[['both', 'Enter or Tab'], ['enter', 'Enter'], ['tab', 'Tab']]} />
      </Group>
      <Group title="Running">
        <Select k="editor.runDefault" label="Run button runs" options={[['current', 'Current statement'], ['all', 'All statements']]} />
        <Select k="editor.resultMode" label="Results of several statements" options={[['tabs', 'One tab per statement'], ['append', 'Append into one tab']]} />
        <Toggle k="editor.returnOnError" label="Stop at the first error" />
        <Select k="editor.rowLimit" label="Default row limit" options={[[null, 'No limit'], ...ROW_LIMITS.map((n): [number, string] => [n, n.toLocaleString()])]} />
      </Group>
      <Group title="Autocomplete">
        <AutoToggle part="disabled" label="Turn off autocomplete" />
        <AutoToggle part="tables" label="Suggest tables and columns" />
        <AutoToggle part="functions" label="Suggest functions" />
        <AutoToggle part="keywords" label="Suggest keywords" />
        <AutoToggle part="prefixSchema" label="Prefix tables with their schema" />
      </Group>
      <Group title="Formatting">
        <Toggle k="format.uppercase" label="Uppercase keywords" />
        <Select k="format.indent" label="Indent with" options={[['spaces', 'Spaces'], ['tab', 'Tabs']]} />
        <Select k="format.width" label="Indent width" options={[[2, '2'], [4, '4'], [6, '6'], [8, '8']]} />
        <Select k="format.type" label="Format layout" options={[['standard', 'Standard'], ['tabularLeft', 'Tabular, left aligned'], ['tabularRight', 'Tabular, right aligned']]} />
        <Row label="Format preview"><pre className="set-preview grow" aria-live="polite">{preview}</pre></Row>
      </Group>
      <Group title="Query parameters">
        <Toggle k="params.enabled" label="Ask for parameter values before running" />
        <Select k="params.format" label="Parameter format" options={PARAMS.map(([v, l]): [V<'params.format'>, string] => [v, l])} />
        <Row label="Parameter example"><code className="set-preview">SELECT * FROM orders WHERE id = {ex}</code></Row>
        <Toggle k="params.inQuotes" label="Find parameters inside quoted strings" />
      </Group>
    </>
  )
}

// ---------- fonts & themes ----------
const THEME_VARS = ['--bg-app', '--bg-panel', '--bg-sidebar', '--bg-elev', '--bg-input', '--bg-hover', '--bg-active', '--bg-selected', '--bg-selected-soft', '--bg-row-alt', '--bg-overlay',
  '--fg', '--fg-muted', '--fg-faint', '--fg-on-accent', '--border', '--border-strong', '--grid-line', '--accent', '--accent-hover', '--focus', '--danger', '--warning', '--success',
  '--pending-new', '--pending-mod', '--pending-del', '--null-fg', '--syn-keyword', '--syn-string', '--syn-number', '--syn-comment', '--syn-ident']

const COLOR_GROUPS: [string, [string, string][]][] = [
  ['Accent', [['--accent', 'Accent color'], ['--accent-hover', 'Accent hover color']]],
  ['Backgrounds', [['--bg-app', 'Window background'], ['--bg-panel', 'Panel background'], ['--bg-sidebar', 'Sidebar background'], ['--bg-elev', 'Raised surface background'], ['--bg-input', 'Input background'], ['--bg-row-alt', 'Alternate row background']]],
  ['Text', [['--fg', 'Text color'], ['--fg-muted', 'Secondary text color'], ['--fg-faint', 'Faint text color']]],
  ['Selection', [['--bg-selected', 'Selection background'], ['--bg-selected-soft', 'Selected row background']]],
  ['Pending changes', [['--pending-new', 'New row background'], ['--pending-mod', 'Modified cell background'], ['--pending-del', 'Deleted row background']]],
  ['Syntax', [['--syn-keyword', 'Keyword color'], ['--syn-string', 'String color'], ['--syn-number', 'Number color'], ['--syn-comment', 'Comment color'], ['--syn-ident', 'Identifier color']]]
]

function ColorRow({ label, value, edited, onChange, onReset }: { label: string; value: string; edited: boolean; onChange: (v: string) => void; onReset: () => void }): ReactNode {
  const id = useId()
  const sc = splitColor(value)
  return (
    <Row label={label} htmlFor={id}>
      <span className="row set-color">
        <input type="color" className="set-swatch" aria-label={`${label} picker`} value={sc?.hex ?? '#000000'} disabled={!sc} onChange={(e) => onChange(joinColor(e.target.value, sc?.alpha ?? 1))} />
        <Draft id={id} value={value} spellCheck={false} onCommit={(t) => { if (!isColor(t)) { toast('Use #rrggbb, rgb() or hsl()', 'error'); return value } onChange(t.trim()); return t.trim() }} />
        {edited && <button className="btn sm" onClick={onReset} aria-label={`Reset ${label}`}>Reset</button>}
      </span>
    </Row>
  )
}

function Themes(): ReactNode {
  const s = useSettings((st) => st.s)
  const [theme, setTheme] = useS('theme')
  const [custom, setCustom] = useS('themes.custom')
  const [overrides, setOverrides] = useS('theme.overrides')
  const id = useId()
  // App applies theme variables in an effect; read computed colors on the next frame so they are current
  const [, tick] = useState(0)
  useEffect(() => { const f = requestAnimationFrame(() => tick((n) => n + 1)); return () => cancelAnimationFrame(f) }, [s])
  const css = getComputedStyle(document.documentElement)

  const customTheme = custom.find((t) => t.name === theme)
  const base = (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'dark'
  const current: CustomTheme = [...BUILTIN_THEMES, ...custom].find((t) => t.name === theme) ?? { name: theme === 'auto' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark', base, colors: {} }
  const taken = (n: string): boolean => ['auto', 'light', 'dark', ...BUILTIN_THEMES.map((t) => t.name), ...custom.map((t) => t.name)].some((x) => x.toLowerCase() === n.toLowerCase())
  const unique = (n: string): string => { let out = n; for (let i = 2; taken(out); i++) out = `${n} ${i}`; return out }
  const snapshot = (): ThemeJson => ({ name: current.name, base: current.base, colors: { ...current.colors, ...overrides } })
  const omit = (o: Record<string, string>, k: string): Record<string, string> => { const n = { ...o }; delete n[k]; return n }

  const setColor = (v: string, val: string): void => {
    // a custom theme is edited in place; system/built-in themes get overrides
    if (customTheme) {
      setCustom(custom.map((t) => (t === customTheme ? { ...t, colors: { ...t.colors, [v]: val } } : t)))
      if (v in overrides) setOverrides(omit(overrides, v))
    } else setOverrides({ ...overrides, [v]: val })
  }
  const resetColor = (v: string): void => {
    if (v in overrides) setOverrides(omit(overrides, v))
    if (customTheme && v in customTheme.colors) setCustom(custom.map((t) => (t === customTheme ? { ...t, colors: omit(t.colors, v) } : t)))
  }
  const duplicate = async (): Promise<void> => {
    const name = await promptDialog('Duplicate theme', unique(`${current.name} copy`), { message: 'The copy is a custom theme you can edit.', ok: 'Duplicate' })
    if (!name?.trim()) return
    const t = { ...snapshot(), name: unique(name.trim()) }
    setCustom([...custom, t])
    setOverrides({})
    setTheme(t.name)
  }
  const remove = async (): Promise<void> => {
    if (!customTheme || !(await confirmDialog(`Delete theme “${customTheme.name}”?`, undefined, { ok: 'Delete', danger: true }))) return
    setCustom(custom.filter((t) => t !== customTheme))
    setTheme('auto')
  }
  const exportThemes = async (list: ThemeJson[], file: string): Promise<void> => {
    const path = await call<string | undefined>('dialog.save', { defaultPath: file, filters: [{ name: 'Theme', extensions: ['json'] }] })
    if (!path) return
    try { await call('file.write', path, JSON.stringify(list.length === 1 ? list[0] : { themes: list }, null, 2)); toast(`Exported ${list.length} theme${list.length > 1 ? 's' : ''}`, 'success') } catch (e) { fail(e) }
  }
  const importThemes = async (): Promise<void> => {
    const [f] = await call<string[]>('dialog.open', { properties: ['openFile'], filters: [{ name: 'Theme', extensions: ['json'] }] })
    if (!f) return
    try {
      const parsed = parseThemes(JSON.parse(await call<string>('file.read', f)), THEME_VARS)
      let next = [...custom]
      const names: string[] = []
      for (const t of parsed) {
        const name = ['auto', 'light', 'dark', ...BUILTIN_THEMES.map((b) => b.name)].some((x) => x.toLowerCase() === t.name.toLowerCase()) ? `${t.name} (imported)` : t.name
        next = next.filter((x) => x.name !== name) // re-importing replaces a custom theme of the same name
        next.push({ ...t, name })
        names.push(name)
      }
      setCustom(next)
      setTheme(names[names.length - 1])
      toast(`Imported ${names.join(', ')}`, 'success')
    } catch (e) {
      fail(e)
    }
  }
  const restore = async (): Promise<void> => {
    if (!(await confirmDialog('Restore default fonts and colors?', 'Color overrides and font settings are reset. Custom themes keep their colors.', { ok: 'Restore' }))) return
    setOverrides({})
    for (const k of ['fonts.gridSize', 'fonts.editorSize', 'fonts.sidebarSize', 'fonts.gridFamily'] as const) void call('settings.set', k, DEFAULTS[k])
  }

  return (
    <>
      <Group title="Theme">
        <Row label="Theme" htmlFor={id}>
          <select id={id} className="select" value={theme} onChange={(e) => setTheme(e.target.value)}>
            <optgroup label="System">
              <option value="auto">Auto (follow system)</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </optgroup>
            <optgroup label="Built-in">{BUILTIN_THEMES.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</optgroup>
            {custom.length > 0 && <optgroup label="Custom">{custom.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</optgroup>}
          </select>
        </Row>
        <Row label="Manage themes">
          <button className="btn sm" onClick={duplicate}>Duplicate…</button>
          {customTheme && <button className="btn sm" onClick={remove}>Delete</button>}
          <button className="btn sm" onClick={() => exportThemes([snapshot()], `${current.name}.json`)}>Export…</button>
          <button className="btn sm" disabled={!custom.length} onClick={() => exportThemes(custom, 'lagoon-themes.json')}>Export Custom…</button>
          <button className="btn sm" onClick={importThemes}>Import…</button>
        </Row>
      </Group>
      <Group title="Fonts">
        <NumberField k="fonts.gridSize" label="Data grid font size" min={9} max={40} />
        <TextField k="fonts.gridFamily" label="Data grid font family" placeholder="System monospace" />
        <NumberField k="fonts.editorSize" label="SQL editor font size" min={9} max={40} />
        <NumberField k="fonts.sidebarSize" label="Sidebar font size" min={9} max={40} />
        <Row label="Font preview">
          <div className="col grow" style={{ gap: 'var(--sp-2)' }}>
            <div className="set-preview" style={{ fontSize: 'var(--grid-font-size)' }}>42   Ada Lovelace   1815-12-10   NULL</div>
            <div className="set-preview" style={{ fontSize: 'var(--editor-font-size)' }}>SELECT name FROM people WHERE id = 42;</div>
          </div>
        </Row>
      </Group>
      {COLOR_GROUPS.map(([title, rows]) => (
        <Group key={title} title={`${title} colors`}>
          {rows.map(([v, label]) => (
            <ColorRow key={v} label={label} value={overrides[v] ?? customTheme?.colors[v] ?? css.getPropertyValue(v).trim()} edited={v in overrides || !!customTheme?.colors[v]} onChange={(val) => setColor(v, val)} onReset={() => resetColor(v)} />
          ))}
        </Group>
      ))}
      <Group>
        <Row label="Restore default fonts and colors"><button className="btn sm" onClick={restore}>Restore Defaults…</button></Row>
      </Group>
    </>
  )
}

// ---------- security ----------
function Passcode(): ReactNode {
  const [hash, setHash] = useS('security.passcodeHash')
  const [mode, setMode] = useState<null | 'set' | 'change' | 'off'>(null)
  const [cur, setCur] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [err, setErr] = useState('')
  const ids = [useId(), useId(), useId()]
  const close = (): void => { setMode(null); setCur(''); setA(''); setB(''); setErr('') }
  const submit = async (): Promise<void> => {
    if (mode !== 'set' && (await sha256Hex(cur)) !== hash) return setErr('The current passcode is wrong')
    if (mode === 'off') { setHash(''); toast('Passcode turned off', 'success'); return close() }
    if (a.length < 4) return setErr('Use at least 4 characters')
    if (a !== b) return setErr('The two passcodes differ')
    await call('lock.set', false) // setting a passcode must not lock the window you are typing in
    setHash(await sha256Hex(a))
    toast(mode === 'set' ? 'Passcode turned on' : 'Passcode changed', 'success')
    close()
  }
  const actions = (
    <>
      <button type="submit" className="btn sm primary">{mode === 'off' ? 'Turn Off' : 'Save'}</button>
      <button type="button" className="btn sm" onClick={close}>Cancel</button>
      {err && <span className="danger-text" role="alert">{err}</span>}
    </>
  )
  const pw = (id: string, label: string, v: string, set: (s: string) => void, first: boolean, last: boolean): ReactNode => (
    <Row label={label} htmlFor={id}>
      <input id={id} className="input" type="password" autoFocus={first} value={v} onChange={(e) => { set(e.target.value); setErr('') }} />
      {last && actions}
    </Row>
  )
  return (
    <>
      <Row label="App passcode">
        <span>{hash ? 'On' : 'Off'}</span>
        {!hash ? <button className="btn sm" onClick={() => setMode('set')}>Turn On…</button> : <>
          <button className="btn sm" onClick={() => setMode('change')}>Change…</button>
          <button className="btn sm" onClick={() => setMode('off')}>Turn Off…</button>
        </>}
      </Row>
      {mode && (
        <form className="set-group" onSubmit={(e) => { e.preventDefault(); void submit() }} aria-label={mode === 'set' ? 'Set passcode' : mode === 'change' ? 'Change passcode' : 'Turn off passcode'}>
          {mode !== 'set' && pw(ids[0], 'Current passcode', cur, setCur, true, mode === 'off')}
          {mode !== 'off' && pw(ids[1], 'New passcode', a, setA, mode === 'set', false)}
          {mode !== 'off' && pw(ids[2], 'Confirm new passcode', b, setB, false, true)}
        </form>
      )}
    </>
  )
}

function Security(): ReactNode {
  return (
    <>
      <Group title="Safe mode">
        <Select k="security.defaultSafeMode" label="Safe mode for new connections" options={SAFE_MODES.map((m, i): [number, string] => [i, m])} />
      </Group>
      <Group title="Passcode">
        <Passcode />
        <Select k="security.autoLockMinutes" label="Lock when away for" options={[[0, 'Never'], [1, '1 minute'], [5, '5 minutes'], [60, '1 hour'], [300, '5 hours']]} hint="Asked at startup and after the app has been in the background this long" />
        <TouchId />
      </Group>
    </>
  )
}

function TouchId(): ReactNode {
  const [can, setCan] = useState(false)
  useEffect(() => { void call<boolean>('lock.touchIdAvailable').then(setCan) }, [])
  return can ? <Toggle k="security.touchId" label="Unlock with Touch ID" hint="The passcode still works when Touch ID is not available" /> : null
}

function Csv(): ReactNode {
  const [delim] = useS('csv.delimiter')
  const [dec] = useS('csv.decimal')
  return (
    <Group title="Copy and paste as CSV">
      <Select k="csv.delimiter" label="Delimiter" options={[[',', 'Comma (,)'], [';', 'Semicolon (;)'], ['\t', 'Tab']]} />
      <Select k="csv.quote" label="Quote values" options={[['auto', 'Only when needed'], ['"', 'Double quote (")'], ["'", "Single quote (')"], ['none', 'Never']]} />
      <Select k="csv.lineBreak" label="Line break" options={[['\n', 'LF (\\n)'], ['\r\n', 'CRLF (\\r\\n)'], ['\r', 'CR (\\r)']]} />
      <Select k="csv.decimal" label="Decimal separator" options={[['.', 'Period (.)'], [',', 'Comma (,)']]} hint={delim === ',' && dec === ',' ? <span className="set-warn" role="alert">Delimiter and decimal separator are both commas; numbers will split into several columns.</span> : undefined} />
    </Group>
  )
}

// ---------- keymap ----------
function Keymap(): ReactNode {
  const [custom] = useS('keymap')
  const q = useContext(Query)
  const [filter, setFilter] = useState('')
  const [rec, setRec] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ id: string; text: string } | null>(null)
  const map = effectiveKeymap(COMMANDS, custom)
  const label = (id: string): string => COMMANDS.find((c) => c.id === id)?.label ?? id
  const pretty = (a: string | null | undefined): string => prettyAccel(a ?? undefined, isMac)

  const save = async (next: Record<string, string | null>): Promise<void> => {
    try { await call('settings.set', 'keymap', next); await call('menu.rebuild') } catch (e) { fail(e) }
  }
  /** Bind or clear; refuses a key that another command already uses. */
  const bind = (c: Command, accel: string | null): void => {
    const other = accel && findConflict(accel, map, c.id, isMac)
    if (other) { setMsg({ id: c.id, text: `${pretty(accel)} is already used by “${label(other)}”` }); return }
    setRec(null)
    setMsg(null)
    void save(setBinding(custom, c.id, accel, c.accel))
  }
  const onKey = (c: Command) => (e: KeyboardEvent) => {
    e.preventDefault() // also keeps the menu accelerator for that key from firing while recording
    e.stopPropagation()
    const r = recordKey(e.nativeEvent, isMac)
    if (r.kind === 'wait') return
    if (r.kind === 'cancel') { setRec(null); setMsg(null) }
    else if (r.kind === 'error') setMsg({ id: c.id, text: r.message })
    else bind(c, r.kind === 'clear' ? null : r.accel)
  }

  const f = filter.toLowerCase()
  const visible = COMMANDS.filter((c) => matches(q, c.label) && (!f || `${c.label} ${c.menu} ${pretty(map[c.id])}`.toLowerCase().includes(f)))
  const menus = [...new Set(visible.map((c) => c.menu))]
  return (
    <>
      {!q && (
        <div className="row">
          <input className="input grow" type="search" placeholder="Filter commands or shortcuts" aria-label="Filter commands or shortcuts" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn" disabled={!Object.keys(custom).length} onClick={async () => { if (await confirmDialog('Restore all default shortcuts?', undefined, { ok: 'Restore' })) void save({}) }}>Restore Defaults</button>
        </div>
      )}
      {!q && <div className="set-hint">Click a shortcut and press the new keys. Esc cancels; Backspace removes the shortcut. Shortcuts need {isMac ? '⌘ or ⌃' : 'Ctrl'} unless they are function keys.</div>}
      {menus.map((m) => (
        <div key={m} className="set-group">
          <h3>{m === 'App' ? 'Application' : m}</h3>
          <div className="km-table">
            {visible.filter((c) => c.menu === m).map((c) => (
              <div key={c.id} className="set-row km-row">
                <span>{c.label.replace(/…$/, '')}</span>
                <button
                  className={`btn km-key ${rec === c.id ? 'recording' : ''} ${c.id in custom ? 'custom' : ''}`}
                  aria-label={`Shortcut for ${c.label}: ${pretty(map[c.id]) || 'not set'}${rec === c.id ? '. Press the new keys' : ''}`}
                  onClick={() => { setRec(c.id); setMsg(null) }}
                  onKeyDown={rec === c.id ? onKey(c) : undefined}
                  onBlur={() => rec === c.id && setRec(null)}
                >
                  {rec === c.id ? 'Press keys…' : pretty(map[c.id]) || <span className="faint">Not set</span>}
                </button>
                {c.id in custom ? <button className="btn sm" onClick={() => bind(c, c.accel ?? null)} aria-label={`Reset shortcut for ${c.label}`}>Reset</button> : <span />}
                {msg?.id === c.id && <div className="set-warn" role="alert" style={{ gridColumn: '1 / -1' }}>{msg.text}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

// ---------- connections & about ----------
function Connections(): ReactNode {
  const [dir, setDir] = useS('paths.queries')
  const [shared, setShared] = useS('queries.sharedFolders')
  const id = useId()
  const pick = async (title: string): Promise<string | undefined> => (await call<string[]>('dialog.open', { title, properties: ['openDirectory', 'createDirectory'] }))[0]
  return (
    <Group title="Saved queries">
      <Row label="Saved queries folder" htmlFor={id}>
        <input id={id} className="input grow mono" readOnly value={dir} placeholder="Default (inside the app data folder)" />
        <button className="btn sm" onClick={async () => { const d = await pick('Folder for saved queries'); if (d) setDir(d) }}>Choose…</button>
        {dir && <button className="btn sm" onClick={() => setDir('')}>Use Default</button>}
      </Row>
      <Row label="Shared query folders">
        <div className="col grow" style={{ gap: 'var(--sp-2)' }}>
          {shared.map((f) => (
            <div key={f} className="row">
              <span className="mono ellipsis grow selectable" title={f}>{f}</span>
              <button className="btn sm" onClick={() => setShared(shared.filter((x) => x !== f))} aria-label={`Remove ${f}`}>Remove</button>
            </div>
          ))}
          <div><button className="btn sm" onClick={async () => { const d = await pick('Add a shared query folder'); if (d && !shared.includes(d)) setShared([...shared, d]) }}>Add Folder…</button></div>
        </div>
      </Row>
    </Group>
  )
}

function About(): ReactNode {
  const [version, setVersion] = useState('')
  const [dir, setDir] = useState('')
  useEffect(() => {
    void call<string>('app.version').then(setVersion)
    void call<string>('app.dataPath').then(setDir)
  }, [])
  return (
    <Group>
      <Row label="Application"><b>Lagoon</b></Row>
      <Row label="Version"><span className="selectable">{version}</span></Row>
      <Row label="License"><span>All features are enabled — no license required.</span></Row>
      <Row label="Data folder">
        <span className="mono ellipsis selectable grow" title={dir}>{dir}</span>
        <button className="btn sm" disabled={!dir} onClick={() => void call('shell.reveal', dir)}>Show</button>
      </Row>
    </Group>
  )
}

const PANES: [string, () => ReactNode][] = [
  ['General', General], ['Table', Table], ['Editor', Editor], ['Fonts & Themes', Themes], ['Security', Security],
  ['CSV', Csv], ['Keymap', Keymap], ['Connections', Connections], ['About', About]
]

export function SettingsModal({ onClose }: { onClose: () => void }): ReactNode {
  const [pane, setPane] = useState('General')
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useCommands('settings', { 'edit.find': () => searchRef.current?.focus() })
  useEffect(() => focusScope('settings'), [])
  const q = search.trim().toLowerCase()
  return (
    <Modal title="Settings" onClose={onClose} className="settings">
      <nav className="set-nav" aria-label="Settings sections">
        <input ref={searchRef} className="input" type="search" placeholder="Search settings" aria-label="Search settings" value={search} onChange={(e) => setSearch(e.target.value)} />
        {PANES.map(([name]) => (
          <button key={name} aria-current={!q && pane === name ? 'page' : undefined} onClick={() => { setSearch(''); setPane(name) }}>{name}</button>
        ))}
      </nav>
      <div className="set-main">
        {PANES.filter(([name]) => q || name === pane).map(([name, Pane]) => (
          // a pane whose name matches the search shows in full
          <Query.Provider key={name} value={matches(q, name) ? '' : q}>
            <section className="set-pane" aria-label={name}>
              <h2>{name}</h2>
              <Pane />
            </section>
          </Query.Provider>
        ))}
        {q && <div className="empty set-none">No settings match “{search.trim()}”.</div>}
      </div>
    </Modal>
  )
}
