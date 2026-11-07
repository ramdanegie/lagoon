import { type ReactNode, useEffect } from 'react'
import type { PluginInfo, PluginList } from '@shared/plugin'
import { COMMANDS, prettyAccel } from '@shared/commands'
import { effectiveKeymap, findConflict } from '@shared/keymap'
import { call, fail, isMac, setting, toast } from '../lib/api'
import { refreshPlugins, usePlugins } from '../lib/plugins'
import { Modal, confirmDialog } from '../components/ui'
import '../styles/settings.css'

const WHERE = { tools: 'Tools menu', cell: 'cell menu', sidebarItem: 'sidebar menu' }

const trust = (): Promise<boolean> =>
  confirmDialog('Install this plugin?', 'Plugins run JavaScript on this computer. They can read and change data in any database you use them with. Only install plugins from people you trust.', { ok: 'Install' })

export function PluginManager({ onClose }: { onClose: () => void }): ReactNode {
  const list = usePlugins((s) => s.list)
  useEffect(() => void refreshPlugins().catch(fail), [])
  const act = async (f: () => Promise<PluginList>, done: string): Promise<void> => {
    try { await refreshPlugins(await f()); toast(done, 'success') } catch (e) { fail(e) }
  }
  const install = async (path: string, name: string): Promise<void> => {
    if (await trust()) await act(() => call('plugin.install', path), `${name} installed`)
  }
  const fromFolder = async (): Promise<void> => {
    const [dir] = await call<string[]>('dialog.open', { title: 'Choose a plugin folder (with manifest.json)', properties: ['openDirectory'] })
    if (dir) await install(dir, 'Plugin')
  }
  const remove = async (p: PluginInfo): Promise<void> => {
    if (await confirmDialog(`Remove ${p.name}?`, 'Its commands disappear from all menus.', { ok: 'Remove', danger: true })) await act(() => call('plugin.remove', p.id), `${p.name} removed`)
  }
  const keymap = effectiveKeymap(COMMANDS, setting<Record<string, string | null>>('keymap', {}))
  const clash = (accel: string): string | undefined => {
    const id = findConflict(accel, keymap, undefined, isMac)
    return id && COMMANDS.find((c) => c.id === id)?.label
  }

  return (
    <Modal
      title="Plugins"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} onClick={() => list && void call('shell.reveal', list.dir)} disabled={!list}>Show Plugins Folder</button>
          <button className="btn" onClick={fromFolder}>Install from Folder…</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </>
      }
    >
      <section className="col" style={{ gap: 'var(--sp-4)' }} aria-labelledby="pl-installed">
        <div id="pl-installed" className="section-title">Installed</div>
        {!list ? <div className="empty">Loading…</div> : !list.installed.length ? <div className="empty">No plugins installed yet.</div> : (
          <div className="plugin-list">
            {list.installed.map((p) => (
              <div key={p.path} className="plugin-card">
                <div className="row">
                  <b className="ellipsis">{p.name}</b>
                  {p.version && <span className="faint">{p.version}</span>}
                  <span className="grow" />
                  {!p.error && <button className="btn sm" onClick={() => act(() => call('plugin.reinstall', p.id), `${p.name} reinstalled`)}>Reinstall</button>}
                  <button className="btn sm" onClick={() => remove(p)} aria-label={`Remove ${p.name}`}>Remove</button>
                </div>
                {p.error ? <div className="danger-text">This plugin cannot be loaded: {p.error}</div> : p.description && <div className="muted">{p.description}</div>}
                {p.commands.map((c) => {
                  const other = c.shortcut && c.placement === 'tools' ? clash(c.shortcut) : undefined
                  return (
                    <div key={c.id} className="cmds">
                      {c.title} · {WHERE[c.placement]}
                      {c.shortcut && c.placement === 'tools' && <> · {prettyAccel(c.shortcut, isMac)}</>}
                      {other && <span className="set-warn"> — shortcut also used by “{other}”, which takes precedence</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="col" style={{ gap: 'var(--sp-4)' }} aria-labelledby="pl-available">
        <div id="pl-available" className="section-title">Available</div>
        {!list?.available.length ? <div className="empty">Every bundled plugin is installed.</div> : (
          <div className="plugin-list">
            {list.available.map((p) => (
              <div key={p.path} className="plugin-card">
                <div className="row">
                  <b className="ellipsis">{p.name}</b>
                  <span className="faint">{p.version}</span>
                  <span className="grow" />
                  <button className="btn sm primary" onClick={() => install(p.path, p.name)} aria-label={`Install ${p.name}`}>Install</button>
                </div>
                {p.description && <div className="muted">{p.description}</div>}
                <div className="cmds">{p.commands.map((c) => `${c.title} (${WHERE[c.placement]})`).join(' · ')}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </Modal>
  )
}
