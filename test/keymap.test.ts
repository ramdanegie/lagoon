import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordKey, canonicalAccel, sameAccel, effectiveKeymap, findConflict, setBinding, parseThemes, splitColor, joinColor, sha256Hex } from '../src/shared/keymap.ts'
import type { KeyLike } from '../src/shared/keymap.ts'

const ev = (code: string, mods: Partial<KeyLike> = {}, key = code.replace(/^Key/, '').toLowerCase()): KeyLike =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

test('recordKey builds accelerators and enforces the modifier rule', () => {
  assert.deepEqual(recordKey(ev('KeyS', { metaKey: true, shiftKey: true }), true), { kind: 'accel', accel: 'CmdOrCtrl+Shift+S' })
  assert.deepEqual(recordKey(ev('KeyS', { ctrlKey: true }), false), { kind: 'accel', accel: 'CmdOrCtrl+S' })
  assert.deepEqual(recordKey(ev('BracketRight', { metaKey: true, altKey: true }, '‘'), true), { kind: 'accel', accel: 'CmdOrCtrl+Alt+]' })
  assert.deepEqual(recordKey(ev('KeyC', { metaKey: true, ctrlKey: true }), true), { kind: 'accel', accel: 'CmdOrCtrl+Ctrl+C' })
  assert.deepEqual(recordKey(ev('F5', {}, 'F5'), true), { kind: 'accel', accel: 'F5' })
  assert.equal(recordKey(ev('KeyS', { altKey: true }), true).kind, 'error')
  assert.equal(recordKey(ev('KeyS', { metaKey: true }), false).kind, 'error') // Windows key alone is not Ctrl
  assert.equal(recordKey(ev('Escape', {}, 'Escape'), true).kind, 'cancel')
  assert.equal(recordKey(ev('Backspace', {}, 'Backspace'), true).kind, 'clear')
  assert.equal(recordKey(ev('MetaLeft', { metaKey: true }, 'Meta'), true).kind, 'wait')
})

test('canonical form compares across spellings and platforms', () => {
  assert.equal(canonicalAccel('CmdOrCtrl+Shift+s', true), 'Shift+Cmd+S')
  assert.equal(canonicalAccel('Shift+CommandOrControl+S', false), 'Ctrl+Shift+S')
  assert.ok(sameAccel('Cmd+Alt+[', 'Alt+CmdOrCtrl+[', true))
  assert.ok(!sameAccel('Cmd+S', 'CmdOrCtrl+S', false)) // Cmd is Super off macOS
  assert.ok(sameAccel('CmdOrCtrl+Ctrl+C', 'CmdOrCtrl+Alt+Shift+C', false)) // menu remap off macOS
  assert.ok(!sameAccel('CmdOrCtrl+Ctrl+C', 'CmdOrCtrl+Alt+Shift+C', true))
  assert.ok(!sameAccel(undefined, 'CmdOrCtrl+S', true))
})

test('conflicts honour custom keymap and the edited command', () => {
  const cmds = [{ id: 'a', accel: 'CmdOrCtrl+S' }, { id: 'b', accel: 'CmdOrCtrl+D' }, { id: 'c' }]
  const map = effectiveKeymap(cmds, { b: null, c: 'CmdOrCtrl+E' })
  assert.deepEqual(map, { a: 'CmdOrCtrl+S', b: undefined, c: 'CmdOrCtrl+E' })
  assert.equal(findConflict('Cmd+S', map, 'c', true), 'a')
  assert.equal(findConflict('CmdOrCtrl+S', map, 'a', true), undefined)
  assert.equal(findConflict('CmdOrCtrl+D', map, 'c', true), undefined) // b was removed
  assert.deepEqual(setBinding({ a: 'CmdOrCtrl+X' }, 'a', 'CmdOrCtrl+S', 'CmdOrCtrl+S'), {})
  assert.deepEqual(setBinding({}, 'b', null, 'CmdOrCtrl+D'), { b: null })
  assert.deepEqual(setBinding({ c: 'CmdOrCtrl+E' }, 'c', null, undefined), {})
})

test('theme JSON validation', () => {
  const vars = ['--accent', '--bg-app']
  assert.deepEqual(parseThemes({ name: ' Ink ', base: 'dark', colors: { '--accent': '#AbC' } }, vars), [{ name: 'Ink', base: 'dark', colors: { '--accent': '#AbC' } }])
  assert.equal(parseThemes({ themes: [{ name: 'a', base: 'light' }, { name: 'b', base: 'dark', colors: { '--bg-app': 'rgba(1, 2, 3, 0.5)' } }] }, vars).length, 2)
  assert.throws(() => parseThemes({ name: 'x', base: 'blue' }, vars), /base/)
  assert.throws(() => parseThemes({ name: 'x', base: 'dark', colors: { '--evil': '#fff' } }, vars), /unknown color/)
  assert.throws(() => parseThemes({ name: 'x', base: 'dark', colors: { '--accent': 'url(x)' } }, vars), /not a color/)
  assert.throws(() => parseThemes([], vars), /no themes/)
})

test('color split/join keeps alpha', () => {
  assert.deepEqual(splitColor('#ABC'), { hex: '#aabbcc', alpha: 1 })
  assert.deepEqual(splitColor('rgba(63, 191, 111, 0.18)'), { hex: '#3fbf6f', alpha: 0.18 })
  assert.equal(splitColor('#11223380')?.hex, '#112233')
  assert.equal(splitColor('hsl(1 2% 3%)'), undefined)
  assert.equal(joinColor('#3FBF6F', 1), '#3fbf6f')
  assert.equal(joinColor('#3fbf6f', 0.5), '#3fbf6f80')
})

test('passcode digest is standard SHA-256 hex', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
