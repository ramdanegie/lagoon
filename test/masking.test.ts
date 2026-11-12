import { test } from 'node:test'
import assert from 'node:assert/strict'
import { masker, maskValue, maskedColumns, MASK_PRESETS } from '../src/shared/masking.ts'

test('mask methods', () => {
  assert.equal(maskValue('budi@example.com', { column: '', method: 'email' }), 'b***@example.com')
  assert.equal(maskValue('no-at-sign', { column: '', method: 'email' }), '***')
  assert.equal(maskValue('4111111111111111', { column: '', method: 'keepLast', arg: '4' }), '************1111')
  assert.equal(maskValue('abc', { column: '', method: 'keepLast', arg: '9' }), 'abc')
  const d = maskValue('+62 812-3456', { column: '', method: 'digits' }) as string
  assert.match(d, /^\+\d\d \d\d\d-\d\d\d\d$/)
  assert.equal(maskValue(null, { column: '', method: 'fixed', arg: 'x' }), null, 'NULL stays NULL')
  assert.equal(maskValue(42, { column: '', method: 'null' }), null)
  assert.equal(maskValue('Jl. Merdeka 1', { column: '', method: 'fixed', arg: 'redacted' }), 'redacted')
})

test('hash: same input and salt give the same pseudonym; another salt gives another', () => {
  const r = { column: '', method: 'hash' as const }
  assert.equal(maskValue('ann', r, 's1'), maskValue('ann', r, 's1'))
  assert.notEqual(maskValue('ann', r, 's1'), maskValue('bob', r, 's1'))
  assert.notEqual(maskValue('ann', r, 's1'), maskValue('ann', r, 's2'))
})

test('masker: glob rules match column names in any case, first rule wins, others untouched', () => {
  const m = masker(['id', 'Email', 'user_password', 'note'], [{ column: '*email*', method: 'email' }, { column: '*pass*', method: 'null' }, { column: '*', method: 'fixed', arg: 'z' }])!
  assert.deepEqual(m([1, 'a@b.co', 'secret', 'hi']), ['z', 'a***@b.co', null, 'z'])
  assert.equal(masker(['id', 'name'], [{ column: '*email*', method: 'email' }]), null)
  assert.equal(masker(['id'], [{ column: '  ', method: 'null' }]), null, 'blank patterns match nothing')
  assert.deepEqual(maskedColumns(['email', 'phone_no', 'card_number', 'city'], MASK_PRESETS), ['email', 'phone_no', 'card_number'])
  assert.deepEqual(maskedColumns(['a.b', 'axb'], [{ column: 'a.b', method: 'null' }]), ['a.b'], 'dots are literal')
})
