import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { parsePlist, fromTablePlus, fromDbeaver, fromNavicat, decryptNavicat, withoutDuplicates, defaultPath } from '../src/main/foreign.ts'

test('plist reader: nesting, entities, scalars, empty values', () => {
  const v = parsePlist(`<?xml version="1.0"?><plist version="1.0"><array><dict>
    <key>Name</key><string>a &amp; b</string><key>Port</key><integer>5432</integer><key>On</key><true/><key>Off</key><false/>
    <key>Empty</key><string/><key>Nested</key><dict><key>L</key><array><string>x</string><real>1.5</real></array></dict><key>D</key><dict/>
    <key>After</key><string>still here</string></dict></array></plist>`)
  assert.deepEqual(v, [{ Name: 'a & b', Port: 5432, On: true, Off: false, Empty: '', Nested: { L: ['x', 1.5] }, D: {}, After: 'still here' }])
})

test('TablePlus: drivers, SSH, SQLite path, production, unsupported skipped', () => {
  const plist = `<plist><array>
    <dict><key>ConnectionName</key><string>prod pg</string><key>Driver</key><string>PostgreSQL</string><key>DatabaseHost</key><string>10.0.0.5</string>
      <key>DatabasePort</key><string>5433</string><key>DatabaseUser</key><string>app</string><key>DatabaseName</key><string>shop</string>
      <key>isOverSSH</key><true/><key>ServerAddress</key><string>bastion.example</string><key>ServerPort</key><string>2222</string><key>ServerUser</key><string>ops</string>
      <key>isUsePrivateKey</key><false/><key>Enviroment</key><string>production</string><key>statusColor</key><string>#FF3B30</string></dict>
    <dict><key>ConnectionName</key><string>notes</string><key>Driver</key><string>SQLite</string><key>DatabasePath</key><string>/tmp/n.db</string><key>DatabasePort</key><string></string></dict>
    <dict><key>ConnectionName</key><string>ora</string><key>Driver</key><string>Oracle</string></dict>
  </array></plist>`
  const r = fromTablePlus(plist)
  assert.deepEqual(r.skipped, ['ora (Oracle is not supported)'])
  const [pg, lite] = r.connections
  assert.equal(pg.driver, 'postgres'); assert.equal(pg.host, '10.0.0.5'); assert.equal(pg.port, 5433); assert.equal(pg.database, 'shop')
  assert.equal(pg.passwordMode, 'ask', 'passwords stay in the Keychain')
  assert.equal(pg.safeMode, 1); assert.equal(pg.statusColor, '#FF3B30')
  assert.deepEqual(pg.ssh, { enabled: true, host: 'bastion.example', port: 2222, user: 'ops', useKey: false, keyPath: undefined, passwordMode: 'ask' })
  assert.equal(lite.driver, 'sqlite'); assert.equal(lite.filePath, '/tmp/n.db'); assert.equal(lite.host, undefined); assert.equal(lite.passwordMode, 'none')
  assert.throws(() => fromTablePlus('<plist><dict></dict></plist>'), /Not a TablePlus/)
})

const dbeaverSeal = (obj: unknown): Buffer => {
  const iv = randomBytes(16)
  const c = createCipheriv('aes-128-cbc', Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex'), iv)
  return Buffer.concat([iv, c.update(JSON.stringify(obj)), c.final()])
}

test('DBeaver: credentials, folders, SSH tunnel, MariaDB, URL-only, SQLite, prod', () => {
  const sources = JSON.stringify({
    folders: { Clients: {} },
    connections: {
      'postgres-jdbc-1': { provider: 'postgresql', driver: 'postgres-jdbc', name: 'Clients PG', folder: 'Clients', 'save-password': true,
        configuration: { host: 'db.internal', port: '5432', database: 'crm', type: 'prod', handlers: { ssh_tunnel: { enabled: true, properties: { host: 'jump', port: '22', authType: 'PUBLIC_KEY', keyPath: '/k/id_ed25519' } } } } },
      'mariaDB-2': { provider: 'mysql', driver: 'mariaDB', name: 'Maria', configuration: { host: 'm', port: '3307', database: 'x', type: 'dev' } },
      'mysql8-3': { provider: 'mysql', driver: 'mysql8', name: 'By URL', 'save-password': false, configuration: { url: 'jdbc:mysql://url.host:3310/appdb?useSSL=false', type: 'dev' } },
      'sqlite-4': { provider: 'sqlite', driver: 'sqlite_jdbc', name: 'Lite', configuration: { database: '/data/a.sqlite' } },
      'oracle-5': { provider: 'oracle', name: 'Ora', configuration: {} }
    }
  })
  const creds = dbeaverSeal({ 'postgres-jdbc-1': { '#connection': { user: 'crm_app', password: 's3cret' } }, 'mariaDB-2': { '#connection': { user: 'root' } } })
  const r = fromDbeaver(sources, creds)
  assert.deepEqual(r.skipped, ['Ora (oracle is not supported)'])
  const [pg, maria, url, lite] = r.connections
  assert.equal(pg.username, 'crm_app'); assert.equal(pg.password, 's3cret'); assert.equal(pg.passwordMode, 'store')
  assert.equal(pg.group, 'Clients'); assert.equal(pg.safeMode, 1); assert.equal(pg.port, 5432)
  assert.deepEqual(pg.ssh, { enabled: true, host: 'jump', port: 22, user: '', useKey: true, keyPath: '/k/id_ed25519', passwordMode: 'none' })
  assert.equal(maria.driver, 'mariadb'); assert.equal(maria.username, 'root'); assert.equal(maria.passwordMode, 'ask')
  assert.equal(url.host, 'url.host'); assert.equal(url.port, 3310); assert.equal(url.database, 'appdb'); assert.equal(url.passwordMode, 'ask')
  assert.equal(lite.filePath, '/data/a.sqlite'); assert.equal(lite.host, undefined)
  // an unreadable credentials file still imports the connections, without passwords
  assert.equal(fromDbeaver(sources, Buffer.from('garbage-garbage-garbage')).connections[0].password, undefined)
})

const navicatSeal = (s: string): string => {
  const c = createCipheriv('aes-128-cbc', Buffer.from('libcckeylibcckey'), Buffer.from('libcciv libcciv '))
  return Buffer.concat([c.update(s), c.final()]).toString('hex').toUpperCase()
}

test('Navicat .ncx: passwords, SSH, SQLite, SSL, unsupported skipped', () => {
  assert.equal(decryptNavicat('B75D320B6211468D63EB3B67C9E85933'), 'This is a test') // published Navicat 12 sample
  assert.equal(decryptNavicat(''), undefined)
  assert.equal(decryptNavicat('ABCD'), undefined)
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="shop &amp; co" ConnType="MYSQL" Host="127.0.0.1" Port="3306" Database="" UserName="root" Password="${navicatSeal('pa"ss')}" SavePassword="true" SSL="true" SSH="true" SSH_Host="gw" SSH_Port="2200" SSH_UserName="me" SSH_AuthenMethod="PASSWORD" SSH_Password="${navicatSeal('sshpw')}" SSH_SavePassword="true"/>
  <Connection ConnectionName="local file" ConnType="SQLITE" DatabaseFileName="/x/y.db" UserName="" Password="" SSH="false"/>
  <Connection ConnectionName="pg ask" ConnType="POSTGRESQL" Host="h" Port="5432" InitialDatabase="postgres" UserName="u" Password="${navicatSeal('nope')}" SavePassword="false" SSH="false"/>
  <Connection ConnectionName="mssql" ConnType="SQLSERVER" Host="h"/>
</Connections>`
  const r = fromNavicat(ncx)
  assert.deepEqual(r.skipped, ['mssql (SQLSERVER is not supported)'])
  const [my, lite, pg] = r.connections
  assert.equal(my.name, 'shop & co'); assert.equal(my.password, 'pa"ss'); assert.equal(my.passwordMode, 'store'); assert.equal(my.database, undefined)
  assert.deepEqual(my.ssl, { mode: 'REQUIRED' })
  assert.equal(my.sshPassword, 'sshpw'); assert.equal(my.ssh?.port, 2200); assert.equal(my.ssh?.passwordMode, 'store')
  assert.equal(lite.filePath, '/x/y.db'); assert.equal(lite.passwordMode, 'none')
  assert.equal(pg.password, undefined, 'SavePassword="false" keeps it out'); assert.equal(pg.passwordMode, 'ask'); assert.equal(pg.database, 'postgres')
  assert.throws(() => fromNavicat('<foo/>'), /Not a Navicat/)
})

test('duplicates are left out; default paths per platform', () => {
  const r = fromNavicat(`<Connections><Connection ConnectionName="a" ConnType="MYSQL" Host="h" Port="3306" UserName="u"/><Connection ConnectionName="b" ConnType="MYSQL" Host="h2" Port="3306" UserName="u"/></Connections>`)
  const d = withoutDuplicates(r, [{ id: '1', name: 'mine', driver: 'mysql', host: 'h', port: 3306, username: 'u', passwordMode: 'none', safeMode: 0 }])
  assert.equal(d.duplicates, 1); assert.deepEqual(d.connections.map((c) => c.name), ['b'])
  assert.equal(defaultPath('dbeaver', 'darwin', '/Users/me'), '/Users/me/Library/DBeaverData/workspace6/General/.dbeaver/data-sources.json')
  assert.equal(defaultPath('dbeaver', 'linux', '/home/me'), '/home/me/.local/share/DBeaverData/workspace6/General/.dbeaver/data-sources.json')
  assert.equal(defaultPath('tableplus', 'linux', '/home/me'), undefined)
  assert.equal(defaultPath('navicat', 'darwin', '/Users/me'), undefined)
})
