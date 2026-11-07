// Redis tab: database list, SCAN key list, per-type value editors and a command console.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue } from '@shared/sqlgen'
import { call, errText, fail, toast, useCommands } from '../lib/api'
import { busy, guard, setWs, updateTab, ws, type Tab } from '../lib/ws'
import { fmtCmd, fmtTtl, parseObject, redisReadOnly, renderRedis, shell } from '../lib/nosql'
import { Grid, type GridColumn, type GridHandle, type Sel } from '../components/Grid'
import { Icon } from '../components/Icon'
import { Modal, Resizer, confirmDialog, menuAt, promptDialog } from '../components/ui'
import '../styles/nosql.css'

interface RKey { key: string; type: string; ttl: number; size: number | null }
interface RVal { type: string; ttl: number; value: unknown }
type Args = (string | number)[]

const LEN: Record<string, string> = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' }
const TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream']
const KEY_COLS: GridColumn[] = [{ name: 'key' }, { name: 'type' }, { name: 'TTL' }, { name: 'size', type: 'integer' }]
const sid = (): string | undefined => ws().sessionId
const rows = (s: Sel | null): number[] => (s ? Array.from({ length: s.r1 - s.r0 + 1 }, (_, i) => s.r0 + i) : [])
const inSel = (s: Sel | null, r: number): number[] => (s && r >= s.r0 && r <= s.r1 ? rows(s) : [r])

/** Guarded writes, run in order. Returns the replies, or null when cancelled or failed. */
async function exec(cmds: Args[]): Promise<unknown[] | null> {
  if (!(await guard(cmds.map(fmtCmd)))) return null
  const out: unknown[] = []
  try {
    for (const c of cmds) out.push(await busy(call('redis.write', sid(), c)))
  } catch (e) {
    fail(e)
    return null
  }
  return out
}

export function RedisBrowser({ tab }: { tab: Tab }): ReactNode {
  const [dbs, setDbs] = useState<{ index: number; keys: number }[]>([])
  const [db, setDb] = useState(() => Number(ws().database ?? 0) || 0)
  const [pattern, setPattern] = useState('*')
  const [applied, setApplied] = useState('*')
  const [keys, setKeys] = useState<RKey[]>([])
  const [cursor, setCursor] = useState('0')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Sel | null>(null)
  const [gen, setGen] = useState(0) // remounts the key grid (clears selection)
  const [tick, setTick] = useState(0) // reloads the value panel
  const [keysW, setKeysW] = useState(380)
  const [creating, setCreating] = useState(false)
  const [selectKey, setSelectKey] = useState<string | null>(null)
  const grid = useRef<GridHandle>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const loadDbs = (): void => void call<{ index: number; keys: number }[]>('redis.databases', sid()).then(setDbs).catch(fail)

  /** SCAN until ~500 new keys or the end; sparse patterns may need several round trips. */
  const scan = async (reset: boolean, pat = applied): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      let cur = reset ? '0' : cursor
      const got: RKey[] = []
      let n = 0
      do {
        const r = await busy(call<{ cursor: string; keys: RKey[] }>('redis.scan', sid(), pat, cur, 500))
        // driver rounds PTTL/1000, which turns -1 (no expiry) into -0
        got.push(...r.keys.map((k) => (Object.is(k.ttl, -0) ? { ...k, ttl: -1 } : k)))
        cur = r.cursor
      } while (cur !== '0' && got.length < 500 && ++n < 20)
      setKeys((ks) => {
        const base = reset ? [] : ks
        const seen = new Set(base.map((k) => k.key))
        return [...base, ...got.filter((k) => !seen.has(k.key) && seen.add(k.key))]
      })
      setCursor(cur)
      setApplied(pat)
      if (reset) { setSel(null); setGen((g) => g + 1) }
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }

  const reloadAll = (): void => { loadDbs(); void scan(true); setTick((t) => t + 1) }
  const reloadRef = useRef(reloadAll)
  reloadRef.current = reloadAll
  useEffect(() => {
    reloadAll()
    const h = (): void => reloadRef.current()
    window.addEventListener('ws:reload', h)
    return () => window.removeEventListener('ws:reload', h)
  }, [])

  // select a key that was just created once it is in the list
  useEffect(() => {
    if (!selectKey) return
    const i = keys.findIndex((k) => k.key === selectKey)
    if (i >= 0) { grid.current?.setSelection({ r0: i, c0: 0, r1: i, c1: 0 }); setSelectKey(null) }
  }, [keys, selectKey])

  const switched = (i: number): void => {
    setDb(i)
    setWs({ database: String(i) })
    updateTab(tab.id, { title: `db${i}` })
    void scan(true)
    loadDbs()
  }
  const selectDb = async (i: number): Promise<void> => {
    if (i === db) return
    try { await call('redis.select', sid(), i) } catch (e) { fail(e); return }
    switched(i)
  }

  const patchKey = (key: string, p: Partial<RKey>): void => setKeys((ks) => ks.map((k) => (k.key === key ? { ...k, ...p } : k)))
  const selKeys = rows(sel).map((r) => keys[r]).filter(Boolean)
  const current = selKeys.length === 1 ? selKeys[0] : null

  const rename = async (k: RKey): Promise<void> => {
    const n = await promptDialog('Rename key', k.key, { ok: 'Rename' })
    if (!n || n === k.key) return
    const r = await exec([['RENAMENX', k.key, n]])
    if (!r) return
    if (Number(r[0]) === 0) toast(`A key named "${n}" already exists. Nothing was renamed.`, 'error')
    else patchKey(k.key, { key: n })
  }
  const setTtl = async (k: RKey): Promise<void> => {
    const v = await promptDialog('Set TTL', k.ttl > 0 ? String(k.ttl) : '', { message: `Seconds until "${k.key}" expires.`, ok: 'Set TTL' })
    if (v === null) return
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) { toast('Enter a whole number of seconds greater than 0.', 'error'); return }
    if (await exec([['EXPIRE', k.key, n]])) patchKey(k.key, { ttl: n })
  }
  const persist = async (k: RKey): Promise<void> => { if (await exec([['PERSIST', k.key]])) patchKey(k.key, { ttl: -1 }) }
  const del = async (list: RKey[]): Promise<void> => {
    if (!list.length) return
    const names = list.slice(0, 10).map((k) => k.key).join('\n') + (list.length > 10 ? `\n… and ${list.length - 10} more` : '')
    if (!(await confirmDialog(list.length === 1 ? 'Delete key?' : `Delete ${list.length} keys?`, names, { ok: 'Delete', danger: true }))) return
    if (!(await exec([['DEL', ...list.map((k) => k.key)]]))) return
    const gone = new Set(list.map((k) => k.key))
    setKeys((ks) => ks.filter((k) => !gone.has(k.key)))
    setSel(null)
    setGen((g) => g + 1)
    loadDbs()
  }

  const keyMenu = (e: React.MouseEvent, r: number): void => {
    const list = inSel(sel, r).map((i) => keys[i]).filter(Boolean)
    const one = list.length === 1 ? list[0] : null
    menuAt(e, [
      { label: list.length > 1 ? 'Copy key names' : 'Copy key name', onClick: () => void navigator.clipboard.writeText(list.map((k) => k.key).join('\n')) },
      { sep: true },
      { label: 'Rename…', disabled: !one, onClick: () => one && void rename(one) },
      { label: 'Set TTL…', disabled: !one, onClick: () => one && void setTtl(one) },
      { label: 'Persist (remove TTL)', disabled: !one || one.ttl === -1, onClick: () => one && void persist(one) },
      { sep: true },
      { label: list.length > 1 ? `Delete ${list.length} keys` : 'Delete', danger: true, onClick: () => void del(list) }
    ])
  }

  useCommands(`redis:${tab.id}`, {
    'edit.find': () => (ws().active === tab.id ? filterRef.current?.focus() : false),
    'edit.addRow': () => (ws().active === tab.id ? setCreating(true) : false)
  })

  const keyRows = useMemo(() => keys.map((k) => [k.key, k.type, fmtTtl(k.ttl), k.size]), [keys])

  return (
    <div className="nosql">
      <div className="nosql-row">
        <div className="redis-dbs" role="listbox" aria-label="Databases">
          <div className="section-title">Databases</div>
          {dbs.map((d) => (
            <div
              key={d.index}
              role="option"
              aria-selected={d.index === db}
              tabIndex={0}
              className={`list-item ${d.index === db ? 'selected' : ''}`}
              onClick={() => void selectDb(d.index)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void selectDb(d.index) } }}
            >
              db{d.index}
              {d.keys > 0 && <span className="count">{d.keys}</span>}
            </div>
          ))}
        </div>
        <div className="nosql-pane" style={{ width: keysW, flex: 'none' }}>
          <div className="nosql-head">
            <label htmlFor={`rk-${tab.id}`} className="sr-only">Key pattern</label>
            <input
              id={`rk-${tab.id}`}
              ref={filterRef}
              className="input sm mono grow"
              placeholder="Pattern, e.g. user:*"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void scan(true, pattern.trim() || '*')}
            />
            <button className="btn sm" onClick={() => void scan(true, pattern.trim() || '*')}><Icon name="filter" size={11} />Filter</button>
          </div>
          {error && <div className="nosql-error" role="alert">{error} <button className="btn sm" onClick={() => void scan(true)}>Retry</button></div>}
          <Grid
            key={gen}
            ref={grid}
            columns={KEY_COLS}
            rows={keyRows}
            onSelect={setSel}
            onCellMenu={(e, r) => keyMenu(e, r)}
            onKey={(e) => { if (e.key === 'Delete' || e.key === 'Backspace') { void del(selKeys); return true } return false }}
            empty={loading ? 'Loading keys…' : applied === '*' ? 'This database has no keys' : `No keys match ${applied}`}
          />
          <div className="bottombar" role="toolbar" aria-label="Keys">
            <button className="btn sm" onClick={() => setCreating(true)}><Icon name="plus" size={11} />New key</button>
            <button className="btn sm" disabled={!selKeys.length} onClick={() => void del(selKeys)}><Icon name="minus" size={11} />Delete</button>
            <button className="btn sm icon" aria-label="Refresh keys" title="Refresh keys" disabled={loading} onClick={reloadAll}><Icon name="refresh" size={11} /></button>
            <span className="grow" />
            <span className="muted" role="status">{loading ? 'Scanning…' : `${keys.length}${cursor !== '0' ? '+' : ''} keys`}</span>
            {cursor !== '0' && <button className="btn sm" disabled={loading} onClick={() => void scan(false)}>Load more</button>}
          </div>
        </div>
        <Resizer onDrag={(d) => setKeysW((w) => Math.max(220, Math.min(900, w + d)))} />
        <div className="nosql-pane redis-value">
          {current ? (
            <ValuePanel key={current.key} k={current} tick={tick} onPatch={(p) => patchKey(current.key, p)} onRename={() => void rename(current)} onTtl={() => void setTtl(current)} onPersist={() => void persist(current)} onDelete={() => void del([current])} />
          ) : (
            <div className="empty">{selKeys.length > 1 ? `${selKeys.length} keys selected` : keys.length ? 'Select a key to see its value' : ''}</div>
          )}
        </div>
      </div>
      <RedisConsole onSelected={switched} onWrite={reloadAll} />
      {creating && (
        <NewKey
          onClose={() => setCreating(false)}
          onCreated={(k) => { setCreating(false); setKeys((ks) => [k, ...ks.filter((x) => x.key !== k.key)]); setSelectKey(k.key); loadDbs() }}
        />
      )}
    </div>
  )
}

// ---------- value panel ----------
const CAP: Record<string, number> = { list: 1000, set: 1000, zset: 1000, stream: 500 }
const COLS: Record<string, GridColumn[]> = {
  hash: [{ name: 'field', readOnly: true }, { name: 'value' }],
  list: [{ name: 'index', type: 'integer', readOnly: true }, { name: 'value' }],
  set: [{ name: 'member', readOnly: true }],
  zset: [{ name: 'member', readOnly: true }, { name: 'score', type: 'double' }],
  stream: [{ name: 'id', readOnly: true }, { name: 'fields', readOnly: true }]
}

function ValuePanel(p: { k: RKey; tick: number; onPatch: (p: Partial<RKey>) => void; onRename: () => void; onTtl: () => void; onPersist: () => void; onDelete: () => void }): ReactNode {
  const { k } = p
  const [val, setVal] = useState<RVal | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [vsel, setVsel] = useState<Sel | null>(null)
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const seq = useRef(0)

  const load = async (): Promise<void> => {
    const my = ++seq.current
    setErr(null)
    try {
      const v = await call<RVal>('redis.get', sid(), k.key)
      if (my !== seq.current) return
      setVal(v)
      if (v.type === 'none') return
      const size = LEN[v.type] ? Number(await call('redis.write', sid(), [LEN[v.type], k.key])) : null
      if (my === seq.current) p.onPatch({ type: v.type, ttl: v.ttl, size })
    } catch (e) {
      if (my === seq.current) setErr(errText(e))
    }
  }
  useEffect(() => { void load() }, [p.tick])

  const w = async (cmds: Args[]): Promise<boolean> => {
    const ok = !!(await exec(cmds))
    if (ok) await load()
    return ok
  }

  const head = (
    <div className="nosql-head">
      <span className="badge" style={{ background: 'var(--accent)' }}>{k.type}</span>
      <span className="mono selectable ellipsis grow" title={k.key}>{k.key}</span>
      <span className="muted" title="Time to live">{fmtTtl(k.ttl)}</span>
      <button className="btn sm" onClick={p.onTtl}>TTL…</button>
      <button className="btn sm" disabled={k.ttl === -1} onClick={p.onPersist}>Persist</button>
      <button className="btn sm" onClick={p.onRename}>Rename…</button>
      <button className="btn sm icon" aria-label="Reload value" title="Reload value" onClick={() => void load()}><Icon name="refresh" size={11} /></button>
      <button className="btn sm icon" aria-label="Delete key" title="Delete key" onClick={p.onDelete}><Icon name="x" size={11} /></button>
    </div>
  )
  if (err) return <>{head}<div className="nosql-error" role="alert">{err}</div></>
  if (!val) return <>{head}<div className="empty">Loading…</div></>
  if (val.type === 'none') return <>{head}<div className="empty">This key no longer exists. Refresh the key list.</div></>
  if (val.type === 'string') return <>{head}<StringEditor value={String(val.value ?? '')} onSave={(t) => w([['SET', k.key, t, 'KEEPTTL']])} /></>

  const type = val.type
  // RESP3 already returns [member, score] pairs, which the driver pairs a second time: flatten that back
  const zfix = (v: unknown[]): [string, string][] => (Array.isArray((v[0] as unknown[] | undefined)?.[0]) ? (v as unknown[][]).flat().filter(Array.isArray) : v) as [string, string][]
  const hash = type === 'hash' ? (val.value as [string, string][]) : type === 'zset' ? zfix(val.value as unknown[]) : []
  const list = type === 'list' || type === 'set' ? (val.value as string[]) : []
  const stream = type === 'stream' ? (val.value as [string, Record<string, string>][]) : []
  const data: unknown[][] =
    type === 'hash' || type === 'zset' ? hash
      : type === 'list' ? list.map((v, i) => [i, v])
        : type === 'set' ? list.map((v) => [v])
          : type === 'stream' ? stream.map(([id, f]) => [id, shell(f)])
            : []
  if (!COLS[type]) return <>{head}<div className="empty">Values of type “{type}” cannot be shown here. Use the console below.</div></>
  const shown = data.length
  const name = (r: number): string => String(data[r][0])

  const edit = (r: number, _c: number, v: CellValue): void => {
    const s = String(v ?? '')
    if (type === 'hash') void w([['HSET', k.key, name(r), s]])
    else if (type === 'list') void w([['LSET', k.key, r, s]])
    else if (type === 'zset') {
      if (s.trim() === '' || !Number.isFinite(Number(s))) { toast('Score must be a number.', 'error'); return }
      void w([['ZADD', k.key, 'XX', Number(s), name(r)]])
    }
  }

  const remove = async (rs: number[]): Promise<void> => {
    if (!rs.length || !(await confirmDialog(rs.length === 1 ? 'Remove this item?' : `Remove ${rs.length} items?`, undefined, { ok: 'Remove', danger: true }))) return
    const names = rs.map(name)
    if (type === 'hash') await w([['HDEL', k.key, ...names]])
    else if (type === 'set') await w([['SREM', k.key, ...names]])
    else if (type === 'zset') await w([['ZREM', k.key, ...names]])
    else if (type === 'stream') await w([['XDEL', k.key, ...names]])
    else if (type === 'list') {
      // mark by index, then remove the marks, so equal values elsewhere stay
      const mark = `__lagoon_removed_${crypto.randomUUID()}__`
      await w([...rs.map((r): Args => ['LSET', k.key, r, mark]), ['LREM', k.key, 0, mark]])
    }
  }

  const itemMenu = (e: React.MouseEvent, r: number): void => {
    const rs = inSel(vsel, r)
    const value = String(data[r][type === 'set' || type === 'stream' ? 0 : 1] ?? '')
    menuAt(e, [
      { label: 'Copy value', onClick: () => void navigator.clipboard.writeText(type === 'stream' ? JSON.stringify(stream[r][1]) : value) },
      ...(type === 'list' ? [{ label: 'Remove all items with this value', onClick: () => void (async () => { if (await confirmDialog('Remove every item equal to this value?', value.slice(0, 200), { ok: 'Remove', danger: true })) await w([['LREM', k.key, 0, value]]) })() }] : []),
      { sep: true },
      { label: rs.length > 1 ? `Remove ${rs.length} items` : 'Remove', danger: true, onClick: () => void remove(rs) }
    ])
  }

  const add = async (cmd: Args | null): Promise<void> => {
    if (cmd && (await w([cmd]))) { setA(''); setB('') }
  }
  const addZ = (): Args | null => (a && b.trim() !== '' && Number.isFinite(Number(b)) ? ['ZADD', k.key, Number(b), a] : (toast('Enter a member and a numeric score.', 'error'), null))
  const addX = (): Args | null => {
    const r = parseObject(a)
    if ('error' in r || !Object.keys(r.value).length) { toast('Enter the entry fields as a JSON object, e.g. {"field": "value"}.', 'error'); return null }
    return ['XADD', k.key, '*', ...Object.entries(r.value).flatMap(([f, v]) => [f, typeof v === 'string' ? v : JSON.stringify(v)])]
  }
  const input = (label: string, value: string, set: (v: string) => void, onEnter: () => void): ReactNode => (
    <input className="input sm mono" aria-label={label} placeholder={label} value={value} onChange={(e) => set(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onEnter()} />
  )
  const addHash = (): void => void add(a ? ['HSET', k.key, a, b] : null)
  const addSet = (): void => void add(a ? ['SADD', k.key, a] : null)
  const addTail = (): void => void add(['RPUSH', k.key, a])

  return (
    <>
      {head}
      {(k.size ?? 0) > shown && shown >= (CAP[type] ?? Infinity) / 2 && <div className="muted" style={{ padding: 'var(--sp-2) var(--sp-4)', fontSize: 'var(--fs-sm)' }}>Showing the first {shown} of {k.size} items.</div>}
      <Grid
        columns={COLS[type]}
        rows={data}
        editable={type === 'hash' || type === 'list' || type === 'zset'}
        onEdit={edit}
        onSelect={setVsel}
        onCellMenu={(e, r) => itemMenu(e, r)}
        onKey={(e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && vsel) { void remove(rows(vsel)); return true } return false }}
        empty="Empty"
      />
      <div className="nosql-addbar">
        {type === 'hash' && <>{input('Field', a, setA, addHash)}{input('Value', b, setB, addHash)}<button className="btn sm" onClick={addHash}>Add field</button></>}
        {type === 'list' && <>{input('Value', a, setA, addTail)}<button className="btn sm" onClick={() => void add(['LPUSH', k.key, a])}>Add to head</button><button className="btn sm" onClick={addTail}>Add to tail</button></>}
        {type === 'set' && <>{input('Member', a, setA, addSet)}<button className="btn sm" onClick={addSet}>Add member</button></>}
        {type === 'zset' && <>{input('Member', a, setA, () => void add(addZ()))}{input('Score', b, setB, () => void add(addZ()))}<button className="btn sm" onClick={() => void add(addZ())}>Add member</button></>}
        {type === 'stream' && <>{input('{"field": "value"}', a, setA, () => void add(addX()))}<button className="btn sm" onClick={() => void add(addX())}>Add entry</button></>}
        <button className="btn sm" disabled={!vsel} onClick={() => void remove(rows(vsel))}><Icon name="minus" size={11} />Remove</button>
      </div>
    </>
  )
}

function StringEditor({ value, onSave }: { value: string; onSave: (v: string) => Promise<boolean> }): ReactNode {
  const isJson = useMemo(() => { try { const v = JSON.parse(value); return !!v && typeof v === 'object' } catch { return false } }, [value])
  const [pretty, setPretty] = useState(false)
  const [text, setText] = useState(value)
  useEffect(() => { setText(pretty && isJson ? JSON.stringify(JSON.parse(value), null, 2) : value) }, [value])
  const reformat = (on: boolean): void => {
    setPretty(on)
    try { setText(JSON.stringify(JSON.parse(text), null, on ? 2 : undefined)) } catch { /* edited into invalid JSON: leave as typed */ }
  }
  const out = (): string => { if (!pretty) return text; try { return JSON.stringify(JSON.parse(text)) } catch { return text } }
  const bytes = useMemo(() => new TextEncoder().encode(value).length, [value])
  return (
    <>
      <textarea className="textarea selectable" aria-label="String value" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="nosql-addbar">
        <span className="muted">{bytes.toLocaleString()} bytes</span>
        {isJson && <label className="check"><input type="checkbox" checked={pretty} onChange={(e) => reformat(e.target.checked)} />Pretty-print JSON</label>}
        <span className="grow" />
        <button className="btn sm" disabled={out() === value} onClick={() => setText(pretty && isJson ? JSON.stringify(JSON.parse(value), null, 2) : value)}>Revert</button>
        <button className="btn sm primary" disabled={out() === value} onClick={() => void onSave(out())}>Save</button>
      </div>
    </>
  )
}

// ---------- new key ----------
function NewKey({ onClose, onCreated }: { onClose: () => void; onCreated: (k: RKey) => void }): ReactNode {
  const [type, setType] = useState('string')
  const [name, setName] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [ttl, setTtl] = useState('')
  const [err, setErr] = useState('')

  const build = (): Args | string => {
    const lines = a.split('\n').filter((x) => x !== '')
    switch (type) {
      case 'string': return ['SET', name, a]
      case 'hash': return a ? ['HSET', name, a, b] : 'Enter the first field name.'
      case 'list': return lines.length ? ['RPUSH', name, ...lines] : 'Enter at least one value.'
      case 'set': return lines.length ? ['SADD', name, ...lines] : 'Enter at least one member.'
      case 'zset': return a && b.trim() !== '' && Number.isFinite(Number(b)) ? ['ZADD', name, Number(b), a] : 'Enter a member and a numeric score.'
      default: {
        const r = parseObject(a)
        if ('error' in r || !Object.keys(r.value).length) return 'Enter the first entry as a JSON object, e.g. {"field": "value"}.'
        return ['XADD', name, '*', ...Object.entries(r.value).flatMap(([f, v]) => [f, typeof v === 'string' ? v : JSON.stringify(v)])]
      }
    }
  }

  const create = async (): Promise<void> => {
    if (!name) { setErr('Enter a key name.'); return }
    const t = ttl.trim() ? Number(ttl) : 0
    if (!Number.isInteger(t) || t < 0) { setErr('TTL must be a whole number of seconds.'); return }
    const cmd = build()
    if (typeof cmd === 'string') { setErr(cmd); return }
    try {
      if (Number(await call('redis.write', sid(), ['EXISTS', name])) > 0) { setErr(`A key named "${name}" already exists.`); return }
    } catch (e) { setErr(errText(e)); return }
    if (await exec(t ? [cmd, ['EXPIRE', name, t]] : [cmd])) onCreated({ key: name, type, ttl: t || -1, size: null })
  }

  const field = (id: string, label: string, el: ReactNode): ReactNode => <div className="field"><label htmlFor={id}>{label}</label>{el}</div>
  const multi = type === 'string' || type === 'list' || type === 'set' || type === 'stream'
  return (
    <Modal
      title="New key"
      onClose={onClose}
      width={520}
      footer={
        <>
          <span className="grow danger-text ellipsis" role="alert" title={err}>{err}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void create()}>Create</button>
        </>
      }
    >
      {field('nk-type', 'Type', <select id="nk-type" className="select" value={type} onChange={(e) => { setType(e.target.value); setErr('') }}>{TYPES.map((x) => <option key={x} value={x}>{x}</option>)}</select>)}
      {field('nk-name', 'Key', <input id="nk-name" className="input mono" autoFocus value={name} onChange={(e) => { setName(e.target.value); setErr('') }} />)}
      {multi
        ? field('nk-a', { string: 'Value', list: 'Values (one per line)', set: 'Members (one per line)', stream: 'Fields (JSON)' }[type] ?? 'Value',
          <textarea id="nk-a" className="textarea" rows={5} spellCheck={false} placeholder={type === 'stream' ? '{"field": "value"}' : ''} value={a} onChange={(e) => { setA(e.target.value); setErr('') }} />)
        : <>
          {field('nk-a', type === 'hash' ? 'Field' : 'Member', <input id="nk-a" className="input mono" value={a} onChange={(e) => { setA(e.target.value); setErr('') }} />)}
          {field('nk-b', type === 'hash' ? 'Value' : 'Score', <input id="nk-b" className="input mono" value={b} onChange={(e) => { setB(e.target.value); setErr('') }} />)}
        </>}
      {field('nk-ttl', 'TTL (seconds)', <input id="nk-ttl" className="input" inputMode="numeric" placeholder="No expiry" value={ttl} onChange={(e) => { setTtl(e.target.value); setErr('') }} />)}
    </Modal>
  )
}

// ---------- console ----------
function RedisConsole({ onSelected, onWrite }: { onSelected: (db: number) => void; onWrite: () => void }): ReactNode {
  const [open, setOpen] = useState(true)
  const [h, setH] = useState(170)
  const [log, setLog] = useState<{ cmd: string; out: string; err?: boolean }[]>([])
  const [line, setLine] = useState('')
  const hist = useRef<string[]>([])
  const hi = useRef(-1)
  const outRef = useRef<HTMLDivElement>(null)
  useEffect(() => { outRef.current?.scrollTo(0, outRef.current.scrollHeight) }, [log, open])

  const run = async (): Promise<void> => {
    const cmd = line.trim()
    if (!cmd) return
    hist.current = [...hist.current.filter((c) => c !== cmd), cmd].slice(-200)
    hi.current = -1
    setLine('')
    if (/^clear$/i.test(cmd)) { setLog([]); return }
    const read = redisReadOnly(cmd)
    // reads skip the prompt on the "confirm writes" levels (2, 4); levels 1 and 3 confirm everything
    if (!(read && (ws().conn?.safeMode ?? 0) % 2 === 0) && !(await guard([cmd]))) return
    try {
      const r = await busy(call('redis.command', sid(), cmd))
      setLog((l) => [...l.slice(-499), { cmd, out: renderRedis(r) }])
      const [word, arg] = cmd.split(/\s+/)
      if (word.toUpperCase() === 'SELECT') onSelected(Number(arg))
      else if (!read) onWrite()
    } catch (e) {
      setLog((l) => [...l.slice(-499), { cmd, out: `(error) ${errText(e)}`, err: true }])
    }
  }

  const recall = (d: number): void => {
    const n = hist.current.length
    if (!n) return
    const i = hi.current < 0 ? (d < 0 ? n - 1 : -1) : hi.current + d
    hi.current = i >= n ? -1 : Math.max(0, i)
    setLine(hi.current < 0 ? '' : hist.current[hi.current])
  }

  return (
    <>
      {open && <Resizer vertical onDrag={(d) => setH((x) => Math.max(80, Math.min(600, x - d)))} />}
      <div className="nosql-head" style={{ borderTop: '1px solid var(--border)' }}>
        <button className="btn sm ghost" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />Console</button>
        <span className="grow" />
        {open && <button className="btn sm ghost" onClick={() => setLog([])}>Clear</button>}
      </div>
      {open && (
        <div className="nosql-pane" style={{ height: h, flex: 'none' }}>
          <div className="redis-console-out" ref={outRef} aria-live="polite" aria-label="Console output">
            {log.length ? log.map((x, i) => <div key={i}><div className="cmd">&gt; {x.cmd}</div><div className={x.err ? 'err' : ''}>{x.out}</div></div>) : <span className="faint">Type a Redis command such as GET key or HGETALL key and press Enter. ↑/↓ recalls history.</span>}
          </div>
          <div className="redis-console-in">
            <span className="faint" aria-hidden>&gt;</span>
            <input aria-label="Redis command" spellCheck={false} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void run() }
              else if (e.key === 'ArrowUp') { e.preventDefault(); recall(-1) }
              else if (e.key === 'ArrowDown') { e.preventDefault(); recall(1) }
            }} />
          </div>
        </div>
      )}
    </>
  )
}
