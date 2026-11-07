import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validateManifest, applyActions, emptyActions } from '../src/shared/plugin.ts'

const good = { id: 'com.example.uuid', name: 'UUID', version: '1.0.0', script: 'main.js', commands: [{ id: 'gen', title: 'New UUID', placement: 'cell', handler: 'generate', shortcut: 'CmdOrCtrl+Alt+U' }] }

test('valid manifest is cleaned', () => {
  const m = validateManifest({ ...good, extra: 1 })
  assert.equal(m.id, 'com.example.uuid')
  assert.equal(m.commands[0].shortcut, 'CmdOrCtrl+Alt+U')
  assert.equal('extra' in m, false)
})

test('manifest rejects unsafe or broken fields', () => {
  const bad = (patch: object, re: RegExp): void => assert.throws(() => validateManifest({ ...good, ...patch }), re)
  bad({ id: '../evil' }, /"id"/)
  bad({ id: '..' }, /"id"/)
  bad({ script: '../x.js' }, /script/)
  bad({ script: '/etc/passwd' }, /script/)
  bad({ script: 'a\\b.js' }, /script/)
  bad({ commands: [] }, /commands/)
  bad({ commands: [{ ...good.commands[0], placement: 'menu' }] }, /placement/)
  bad({ commands: [{ ...good.commands[0], handler: 'a b' }] }, /handler/)
  bad({ commands: [good.commands[0], good.commands[0]] }, /duplicate/)
  bad({ commands: [{ ...good.commands[0], shortcut: 'U' }] }, /shortcut/)
  bad({ name: '' }, /"name"/)
  assert.throws(() => validateManifest(null), /object/)
  assert.doesNotThrow(() => validateManifest({ ...good, commands: [{ ...good.commands[0], shortcut: 'F5' }] }))
})

test('bundled example plugins are valid', () => {
  const dir = join(import.meta.dirname, '..', 'plugins-examples')
  const names = readdirSync(dir)
  assert.ok(names.length >= 3)
  for (const n of names) {
    const m = validateManifest(JSON.parse(readFileSync(join(dir, n, 'manifest.json'), 'utf8')))
    assert.ok(readFileSync(join(dir, n, m.script), 'utf8').length > 0, n)
  }
})

test('applyActions routes each action and reports unhandled ones', () => {
  const log: string[] = []
  const a = { ...emptyActions(), clipboard: 'x', notifications: [{ title: 't', body: 'b' }], cellValue: 'v', editorText: 'e' }
  const skipped = applyActions(a, { clipboard: (t) => log.push(`clip:${t}`), notify: (t, b) => log.push(`note:${t}/${b}`), setValue: (v) => log.push(`cell:${v}`) })
  assert.deepEqual(log, ['clip:x', 'note:t/b', 'cell:v'])
  assert.deepEqual(skipped, ['editor text'])
  assert.deepEqual(applyActions({ ...emptyActions(), cellValue: null }, { clipboard: () => 0, notify: () => 0, setValue: (v) => log.push(`null:${v}`) }), [])
  assert.equal(log.at(-1), 'null:null')
})
