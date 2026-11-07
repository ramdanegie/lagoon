import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConnectionUrl, connectionToUrl } from '../src/shared/url.ts'

test('parse plain url', () => {
  const c = parseConnectionUrl('postgresql://postgres:p%40ss@127.0.0.1:5433/shop?name=Local&statusColor=007F3D&env=production')
  assert.equal(c.driver, 'postgres'); assert.equal(c.password, 'p@ss'); assert.equal(c.port, 5433); assert.equal(c.database, 'shop')
  assert.equal(c.name, 'Local'); assert.equal(c.statusColor, '#007F3D'); assert.equal(c.tagId, 'production')
})

test('parse ssh url', () => {
  const c = parseConnectionUrl('mysql+ssh://deploy@bastion.example.com:2222/root:secret@10.0.0.5:3306/app')
  assert.equal(c.ssh?.host, 'bastion.example.com'); assert.equal(c.ssh?.port, 2222); assert.equal(c.ssh?.user, 'deploy'); assert.equal(c.ssh?.useKey, true)
  assert.equal(c.host, '10.0.0.5'); assert.equal(c.username, 'root'); assert.equal(c.password, 'secret'); assert.equal(c.database, 'app')
})

test('sqlite + round trip', () => {
  assert.equal(parseConnectionUrl('sqlite:///Users/me/a.db').filePath, '/Users/me/a.db')
  const c = parseConnectionUrl('postgres://u@h/db')
  const url = connectionToUrl({ ...c, id: 'x', name: 'n', passwordMode: 'store', safeMode: 2 } as never, { password: 'p w' })
  const back = parseConnectionUrl(url)
  assert.equal(back.password, 'p w'); assert.equal(back.safeMode, 2); assert.equal(back.host, 'h')
  assert.throws(() => parseConnectionUrl('nope'))
})
