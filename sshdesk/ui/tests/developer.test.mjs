// Exercise the real loader with a deterministic native bridge and module host.
// Run: node --experimental-vm-modules --test ui/tests/developer.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { resolveObjectURL } from 'node:buffer'
import vm from 'node:vm'

const source = await readFile(new URL('../src/ext/loader.ts', import.meta.url), 'utf8')
const bundle = (id, text = id, extra = '') => `export const manifest = { id: '${id}', name: '${text}' }; export function createApp() { ${extra} return function App() {} }`
async function harness() {
  const apps = [{ id: 'settings', title: 'Settings', component() {} }]
  const styles = [], tokens = new Map(), files = new Map(), ticks = new Set(), removed = []
  let config = { enabled: false, apps: [] }
  const shipped = [{ dir: '/shipped/system', name: 'system', source: bundle('system', 'Shipped System'), style: '.system {color: blue}' }]
  const context = vm.createContext({ Blob, URL, console: { error() {}, warn() {} }, Date, Map, Set,
    setInterval: fn => { ticks.add(fn); return fn }, clearInterval: fn => ticks.delete(fn),
    document: { querySelector: () => null, querySelectorAll: () => styles.slice(),
      createElement: () => { const el = { dataset: {}, textContent: '', remove() { styles.splice(styles.indexOf(el), 1) } }; return el },
      head: { appendChild: el => styles.push(el) } },
    window: { __TAURI__: { core: { invoke: async (command, args) => {
      if (command === 'list_plugins') return shipped
      if (command === 'developer_apps_get') return structuredClone(config)
      if (command === 'developer_app_read') {
        const raw = files.get(args.directory)
        if (!raw) throw new Error('Entry file is missing')
        return { dir: args.directory, name: args.directory.split('/').pop(), ...raw }
      }
      if (command === 'developer_app_stamps') return config.apps.filter(a => config.enabled && a.enabled && a.watch).map(a => [a.directory, files.get(a.directory)?.stamp || 'missing'])
      if (command === 'developer_apps_change') {
        const c = args.change
        if (c.op === 'mode') config.enabled = c.enabled
        if (c.op === 'add') config.apps.push({ directory: c.directory, enabled: true, watch: false })
        if (c.op === 'describe') Object.assign(config.apps.find(a => a.directory === c.directory), { name: c.name, icon: c.icon })
        if (c.op === 'update') Object.assign(config.apps.find(a => a.directory === c.directory), c)
        if (c.op === 'remove') config.apps = config.apps.filter(a => a.directory !== c.directory)
        return structuredClone(config)
      }
      throw new Error(command)
    } } } },
  })
  const mock = values => new vm.SyntheticModule(Object.keys(values), function() {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value)
  }, { context })
  const modules = {
    react: mock({ createElement() {} }), htm: mock({ default: { bind: () => () => {} } }),
    '../fw': mock({ fw: {} }),
    '../fw/tokens': mock({ declareTokens: (id, value) => tokens.set(id, value), removeTokenDeclarations: id => tokens.delete(id) }),
    './sdk': mock({ makeSdk: () => ({}) }),
    '../wm/host': mock({ useHost: () => 'test@host', useFw: () => ({}) }),
    '../desktop/registry': mock({ APPS: apps }),
    '../wm/EmbeddedWebview': mock({ EmbeddedWebview() {} }),
  }
  const loader = new vm.SourceTextModule(stripTypeScriptTypes(source), {
    context, identifier: 'loader',
    importModuleDynamically: async specifier => {
      const blob = resolveObjectURL(specifier)
      const mod = new vm.SourceTextModule(await blob.text(), { context })
      await mod.link(() => { throw new Error('Unbundled import') })
      await mod.evaluate()
      return mod
    },
  })
  await loader.link(name => modules[name])
  await loader.evaluate()
  const api = loader.namespace
  api.onPluginsChanged(ids => removed.push(...ids))
  await api.loadPlugins()
  return { api, apps, styles, tokens, files, ticks, removed,
    setFile(dir, id, text, style = '', extra = '') { files.set(dir, { source: bundle(id, text, extra), style, stamp: String(Math.random()) }) },
    async add(dir) { await api.changeDeveloperApps({ op: 'mode', enabled: true }); await api.changeDeveloperApps({ op: 'add', directory: dir }) },
    async tick() { for (const tick of ticks) tick(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) },
  }
}

test('targeted reload replaces only its app and CSS, without retiring windows', async () => {
  const h = await harness()
  const shipped = h.apps.find(a => a.id === 'system')
  h.setFile('/local/one', 'one', 'First', '.one {color: red}')
  await h.add('/local/one')
  const old = h.apps.find(a => a.id === 'one')
  h.setFile('/local/one', 'one', 'Updated', '.one {color: green}')
  await h.api.reloadLocalApp('/local/one')
  assert.notEqual(h.apps.find(a => a.id === 'one').component, old.component)
  assert.equal(h.apps.find(a => a.id === 'one').title, 'Updated')
  assert.equal(h.apps.find(a => a.id === 'system'), shipped)
  assert.equal(h.styles.filter(s => s.dataset.plugin === 'one').length, 1)
  assert.equal(h.styles.find(s => s.dataset.plugin === 'one').textContent, '.one {color: green}')
  assert.deepEqual(h.removed, [])
})

test('invalid builds retain the previous definition, styles, and recover on reload', async () => {
  const h = await harness()
  h.setFile('/local/one', 'one', 'First', '.one {}')
  await h.add('/local/one')
  const first = h.apps.find(a => a.id === 'one')
  h.files.set('/local/one', { source: 'export broken !!', style: '.bad {}', stamp: 'bad' })
  await h.api.reloadLocalApp('/local/one')
  assert.equal(h.apps.find(a => a.id === 'one'), first)
  assert.equal(h.styles.find(s => s.dataset.plugin === 'one').textContent, '.one {}')
  assert.match(h.api.developerSnapshot().runtime['/local/one'].error, /SyntaxError/)
  h.setFile('/local/one', 'one', 'Fixed')
  await h.api.reloadLocalApp('/local/one')
  assert.equal(h.apps.find(a => a.id === 'one').title, 'Fixed')
  assert.equal(h.api.developerSnapshot().runtime['/local/one'].error, undefined)
})

test('local overrides restore shipped definitions; removing unique apps retires only those windows', async () => {
  const h = await harness()
  const shipped = h.apps.find(a => a.id === 'system')
  h.setFile('/local/system', 'system', 'Local System')
  await h.add('/local/system')
  assert.equal(h.apps.find(a => a.id === 'system').title, 'Local System')
  await h.api.changeDeveloperApps({ op: 'update', directory: '/local/system', enabled: false })
  assert.equal(h.apps.find(a => a.id === 'system'), shipped)
  assert.deepEqual(h.removed, [])
  h.setFile('/local/one', 'one', 'One')
  await h.add('/local/one')
  await h.api.changeDeveloperApps({ op: 'remove', directory: '/local/one' })
  assert.deepEqual(h.removed, ['one'])
  assert.equal(h.tokens.has('one'), false)
  assert.ok(h.files.has('/local/one'))
})

test('reserved IDs, duplicate local IDs, and ID changes cannot replace other apps', async () => {
  const h = await harness()
  h.setFile('/local/reserved', 'settings', 'Imposter')
  await h.add('/local/reserved')
  assert.match(h.api.developerSnapshot().runtime['/local/reserved'].error, /reserved/)
  assert.equal(h.apps.find(a => a.id === 'settings').title, 'Settings')
  h.setFile('/local/one', 'one', 'One')
  await h.add('/local/one')
  h.setFile('/local/two', 'one', 'Duplicate')
  await h.add('/local/two')
  assert.match(h.api.developerSnapshot().runtime['/local/two'].error, /already registered/)
  assert.equal(h.apps.find(a => a.id === 'one').title, 'One')
  h.setFile('/local/one', 'renamed', 'Renamed')
  await h.api.reloadLocalApp('/local/one')
  assert.match(h.api.developerSnapshot().runtime['/local/one'].error, /ID changed/)
  assert.ok(h.apps.find(a => a.id === 'one'))
  assert.ok(!h.apps.find(a => a.id === 'renamed'))
})

test('watch waits for stable output and developer mode stops all local reloads', async () => {
  const h = await harness()
  h.setFile('/local/one', 'one', 'One')
  await h.add('/local/one')
  await h.api.changeDeveloperApps({ op: 'update', directory: '/local/one', watch: true })
  h.setFile('/local/one', 'one', 'Changed')
  await h.tick()
  assert.equal(h.apps.find(a => a.id === 'one').title, 'One')
  await h.tick()
  assert.equal(h.apps.find(a => a.id === 'one').title, 'Changed')
  await h.api.changeDeveloperApps({ op: 'mode', enabled: false })
  assert.equal(h.ticks.size, 0)
  assert.ok(!h.apps.find(a => a.id === 'one'))
  assert.equal(h.api.developerSnapshot().config.apps.length, 1)
  assert.equal(h.api.developerSnapshot().config.apps[0].name, 'Changed')
  await h.api.changeDeveloperApps({ op: 'mode', enabled: true })
  assert.equal(h.apps.find(a => a.id === 'one').title, 'Changed')
})


test('malformed appearance declarations never reach the desktop token registry', async () => {
  const h = await harness()
  h.files.set('/local/bad', { source: "export const manifest = { id: 'bad', name: 'Bad', tokens: { accent: null } }; export function createApp() { return function() {} }", stamp: 'bad' })
  await h.add('/local/bad')
  assert.match(h.api.developerSnapshot().runtime['/local/bad'].error, /Invalid appearance token/)
  assert.equal(h.tokens.has('bad'), false)
  h.setFile('/local/desk', 'desk', 'Desktop override')
  await h.add('/local/desk')
  assert.match(h.api.developerSnapshot().runtime['/local/desk'].error, /reserved/)
})


test('render errors are reported separately and clear on a successful reload', async () => {
  const h = await harness()
  h.setFile('/local/one', 'one', 'One')
  await h.add('/local/one')
  h.api.reportPluginError('/local/one', 'Render failed')
  assert.equal(h.api.developerSnapshot().runtime['/local/one'].errorStage, 'render')
  await h.api.reloadLocalApp('/local/one')
  assert.equal(h.api.developerSnapshot().runtime['/local/one'].error, undefined)
})
