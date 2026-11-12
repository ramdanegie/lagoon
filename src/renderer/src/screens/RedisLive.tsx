// Redis Pub/Sub (subscribe to channels or patterns, publish) and MONITOR (every command the server runs), live.
import { type ReactNode, useEffect, useState } from 'react'
import type { RedisLiveEvent } from '@shared/types'
import { call, fail, toast } from '../lib/api'
import { useWs, type Tab } from '../lib/ws'
import { Grid } from '../components/Grid'
import { Icon } from '../components/Icon'

const KEEP = 5000
const time = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(at % 1000).padStart(3, '0')
const quote = (a: string): string => (/[\s"]/.test(a) || a === '' ? JSON.stringify(a) : a)

export function RedisLive({ tab }: { tab: Tab }): ReactNode {
  const sessionId = useWs((s) => s.sessionId)
  const monitor = tab.name === 'monitor'
  const [events, setEvents] = useState<RedisLiveEvent[]>([]) // newest first
  const [dropped, setDropped] = useState(0)
  const [running, setRunning] = useState(false)
  const [patterns, setPatterns] = useState<string[]>([])
  const [pattern, setPattern] = useState('')
  const [channel, setChannel] = useState('')
  const [message, setMessage] = useState('')
  const [filter, setFilter] = useState('')

  useEffect(() => window.api.on('redis:live', (id, batch, lost) => {
    if (id !== tab.id) return
    setEvents((e) => [...(batch as RedisLiveEvent[]).reverse(), ...e].slice(0, KEEP))
    if (lost) setDropped((d) => d + (lost as number))
  }), [tab.id])
  useEffect(() => () => { void call('redis.liveStop', tab.id) }, [tab.id])

  const subscribe = async (): Promise<void> => {
    const list = pattern.split(/[\s,]+/).filter((p) => p && !patterns.includes(p))
    if (!list.length || !sessionId) return
    try { await call('redis.subscribe', sessionId, tab.id, list); setPatterns((p) => [...p, ...list]); setPattern('') } catch (e) { fail(e) }
  }
  const unsubscribe = async (p: string): Promise<void> => {
    try { await call('redis.unsubscribe', tab.id, [p]); setPatterns((x) => x.filter((y) => y !== p)) } catch (e) { fail(e) }
  }
  const publish = async (): Promise<void> => {
    if (!channel.trim() || !sessionId) return
    try {
      const n = await call<number>('redis.write', sessionId, ['PUBLISH', channel.trim(), message])
      toast(`Delivered to ${n} subscriber${n === 1 ? '' : 's'}`)
    } catch (e) { fail(e) }
  }
  const toggleMonitor = async (): Promise<void> => {
    if (running) { await call('redis.liveStop', tab.id); setRunning(false); return }
    if (!sessionId) return
    try { await call('redis.monitor', sessionId, tab.id); setRunning(true) } catch (e) { fail(e) }
  }

  const q = filter.trim().toLowerCase()
  const rows = (monitor
    ? events.map((e) => [time(e.at), String(e.db ?? ''), e.source ?? '', (e.args ?? []).map(quote).join(' ')])
    : events.map((e) => [time(e.at), e.channel ?? '', e.pattern === e.channel ? '' : e.pattern ?? '', e.message ?? ''])
  ).filter((r) => !q || r.some((v) => v.toLowerCase().includes(q)))
  const columns = (monitor ? ['Time', 'DB', 'Client', 'Command'] : ['Time', 'Channel', 'Pattern', 'Message']).map((name) => ({ name, type: 'text' }))

  return (
    <div className="nosql">
      {monitor ? (
        <div className="nosql-head">
          <button className={`btn sm ${running ? '' : 'primary'}`} onClick={() => void toggleMonitor()}><Icon name={running ? 'stop' : 'play'} size={11} /> {running ? 'Stop' : 'Start monitor'}</button>
          <span className="muted">{running ? 'Showing every command the server runs, from every client.' : 'MONITOR slows a busy server down. Stop it when you are done.'}</span>
        </div>
      ) : (
        <>
          <div className="nosql-head">
            <input className="input" style={{ width: 260 }} placeholder="Channel or pattern, e.g. orders.*" aria-label="Channel or pattern to subscribe to" value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void subscribe()} />
            <button className="btn sm primary" disabled={!pattern.trim()} onClick={() => void subscribe()}>Subscribe</button>
            <div className="row" role="list" aria-label="Subscriptions" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
              {patterns.map((p) => (
                <span key={p} role="listitem" className="chip mono">{p}<button className="btn ghost icon sm" aria-label={`Unsubscribe from ${p}`} onClick={() => void unsubscribe(p)}><Icon name="x" size={9} /></button></span>
              ))}
              {!patterns.length && <span className="muted">Not subscribed to anything yet.</span>}
            </div>
          </div>
          <div className="nosql-head">
            <input className="input" style={{ width: 200 }} placeholder="Channel" aria-label="Channel to publish to" value={channel} onChange={(e) => setChannel(e.target.value)} />
            <input className="input grow" placeholder="Message" aria-label="Message to publish" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void publish()} />
            <button className="btn sm" disabled={!channel.trim()} onClick={() => void publish()}>Publish</button>
          </div>
        </>
      )}
      <Grid columns={columns} rows={rows} empty={monitor ? (running ? 'Waiting for commands…' : 'Start the monitor to see commands as they run.') : patterns.length ? 'Waiting for messages…' : 'Subscribe to a channel to see its messages here.'} />
      <div className="bottombar">
        <input className="input" style={{ width: 220, height: 22 }} placeholder="Filter" aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn sm" disabled={!events.length} onClick={() => { setEvents([]); setDropped(0) }}>Clear</button>
        <span className="grow" />
        {dropped > 0 && <span className="danger-text" title="The server sent more than the window can show; these were skipped">{dropped.toLocaleString()} skipped</span>}
        <span className="muted">{rows.length.toLocaleString()} {monitor ? 'commands' : 'messages'}{events.length >= KEEP ? ` · newest ${KEEP.toLocaleString()} kept` : ''}</span>
      </div>
    </div>
  )
}
