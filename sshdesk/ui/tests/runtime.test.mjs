// Run with: node --experimental-vm-modules --test ui/tests/runtime.test.mjs
// Keeps the native permission list, the consent copy, and the shipped app
// manifests from drifting apart. The gateway itself is tested in Rust.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

const root = new URL('../../', import.meta.url)
const rust = await readFile(new URL('src-tauri/src/runtime.rs', root), 'utf8')
const declared = [...rust.match(/const PERMISSIONS: &\[&str\] = &\[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1])
const copy = stripTypeScriptTypes(await readFile(new URL('ui/src/ext/permissions.ts', root), 'utf8'))
const { ACCESS } = await import('data:text/javascript,' + encodeURIComponent(copy))

test('every native permission has consent copy, and nothing else does', () => {
  assert.ok(declared.length >= 10)
  assert.deepEqual(Object.keys(ACCESS).sort(), [...declared].sort())
  for (const [name, [title, detail]] of Object.entries(ACCESS)) {
    assert.ok(title.length > 3 && detail.length > 20, `${name} needs a title and an explanation`)
  }
})

// What an app calls decides what it must declare. These are the obvious
// signatures; a false negative fails at runtime with PermissionDenied.
const NEEDS = [
  [/\bsdk\.exec\(|\bsdk\.capability\(/, 'remote.exec'],
  [/\bsdk\.sudo\(/, 'remote.sudo'],
  [/\bdbus\.(call|get|systemd|systemdProperty)\(|\bwatchUnits\(/, 'remote.dbus'],
  [/\.net\.(forward|forwardSocket|unforward|unforwardSocket|forwards)\(/, 'remote.tunnels'],
  [/\.net\.openUrl\(|\.ui\.open\(/, 'desktop.openUrl'],
  [/EmbeddedWebview/, 'desktop.embed'],
  [/\.fs\.(list|read|readBinary|disk|caps)\(/, 'remote.files.read'],
  [/\.fs\.(write|mkdir|rename|copy|remove)\(/, 'remote.files.write'],
  [/\.sys\.(snapshot|clock)\(/, 'remote.system'],
  [/\bfetch\(|new WebSocket\(/, 'network'],
]

test('shipped apps ship a static manifest that covers what their code calls', async () => {
  const plugins = (await readdir(new URL('plugins/', root), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => `plugins/${d.name}`)
  const dirs = [...plugins, 'examples/hello-app']
  assert.ok(dirs.length >= 5)
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(new URL(`${dir}/manifest.json`, root), 'utf8'))
    assert.equal(manifest.schemaVersion, 1, dir)
    assert.match(manifest.id, /^[a-z][a-z0-9_-]*$/, dir)
    assert.ok(manifest.name && manifest.version, `${dir} needs a name and version`)
    assert.ok(Array.isArray(manifest.permissions), `${dir} needs a permissions array`)
    for (const p of manifest.permissions) assert.ok(declared.includes(p), `${dir} requests the unknown permission ${p}`)
    if (manifest.requires?.length) assert.ok(manifest.permissions.includes('remote.exec'), `${dir} installs software but cannot run it`)
    const source = await readFile(new URL(`${dir}/index.js`, root), 'utf8')
    const id = source.match(/manifest\s*=\s*\{[^}]*?\bid:\s*['"]([^'"]+)['"]/)?.[1]
    if (id) assert.equal(id, manifest.id, `${dir}: index.js and manifest.json disagree on the app ID`)
    for (const [pattern, permission] of NEEDS) {
      if (pattern.test(source)) assert.ok(manifest.permissions.includes(permission), `${dir} calls an API that needs ${permission}`)
    }
  }
})
