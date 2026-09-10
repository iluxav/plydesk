import * as React from 'react'
import htm from 'htm'
import { fw } from '../fw'
import { declareTokens, removeTokenDeclarations, type TokenMap } from '../fw/tokens'
import type { Requirement } from '../fw'
import { makeSdk, type Sdk } from './sdk'
import { useFw, useHost } from '../wm/host'
import { APPS, type AppDef } from '../desktop/registry'
import { EmbeddedWebview } from '../wm/EmbeddedWebview'

interface PluginModule {
  manifest?: {
    id: string
    name: string
    description?: string
    version?: string
    author?: string
    icon?: string
    window?: { w?: number; h?: number }
    /** Tokens this plugin owns; Settings renders an editor for each. */
    tokens?: TokenMap
    /** Content types this plugin opens, e.g. ['application/pdf', 'text/csv']. */
    opens?: string[]
    /** What this plugin needs on the remote; checked when a window opens. */
    requires?: Requirement[]
  }
  createAdapter?: (sdk: Sdk) => Record<string, unknown>
  createApp?: (ctx: {
    React: typeof React
    h: typeof React.createElement
    /** htm tagged template — JSX-like markup with no build step. */
    html: ReturnType<typeof htm.bind>
    /** Ambient API, bound to the focused host. Fine for one-shot actions. */
    fw: typeof fw
    /** Hook returning the API pinned to *this window's* host. Prefer it. */
    useFw: typeof useFw
    /** Ambient adapter, bound to the focused host. */
    api: Record<string, unknown>
    /** Hook returning the adapter pinned to *this window's* host. Prefer it. */
    useApi: () => Record<string, unknown>
    /** First-party web content attached inside this desktop window. */
    EmbeddedWebview: typeof EmbeddedWebview
  }) => React.ComponentType<any>
}

export interface RawPlugin { name: string; dir: string; source: string; style?: string | null; stamp?: string }
interface Prepared { def: AppDef; tokens: TokenMap; style?: string | null }
export interface PluginFailure { name: string; directory: string; message: string }
export interface LocalApp { directory: string; enabled: boolean; watch: boolean; name?: string; icon?: string }
export interface DeveloperConfig { enabled: boolean; apps: LocalApp[] }
export type DeveloperChange =
  | { op: 'mode'; enabled: boolean }
  | { op: 'add'; directory: string }
  | { op: 'update'; directory: string; enabled?: boolean; watch?: boolean }
  | { op: 'remove'; directory: string }
interface Runtime { prepared?: Prepared; error?: string; errorStage?: 'load' | 'render'; loadedAt?: number; stamp?: string }
export interface DeveloperSnapshot {
  ready: boolean; busy: boolean; error: string; config: DeveloperConfig
  runtime: Record<string, { appId?: string; name?: string; icon?: string; error?: string; errorStage?: 'load' | 'render'; loadedAt?: number }>
}

let base = new Map<string, Prepared>()
const local = new Map<string, Runtime>()
let config: DeveloperConfig = { enabled: false, apps: [] }
let ready = false, settingsError = '', pending = 0, revision = 0
let failures: PluginFailure[] = []
let snapshot: DeveloperSnapshot = { ready, busy: false, error: '', config, runtime: {} }
const watchers = new Set<(removed: string[]) => void>()
const developerWatchers = new Set<() => void>()
let queue: Promise<unknown> = Promise.resolve()
let timer: ReturnType<typeof setInterval> | undefined
const observed = new Map<string, string>()

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (window as any).__TAURI__.core.invoke(cmd, args)

export function pluginFailures() { return failures }
export function onPluginsChanged(fn: (removed: string[]) => void) {
  watchers.add(fn)
  return () => { watchers.delete(fn) }
}
export function onDeveloperChanged(fn: () => void) {
  developerWatchers.add(fn)
  return () => { developerWatchers.delete(fn) }
}
export function developerSnapshot() { return snapshot }
function announceDeveloper() {
  snapshot = { ready, busy: pending > 0, error: settingsError, config,
    runtime: Object.fromEntries([...local].map(([dir, r]) => [dir, {
      appId: r.prepared?.def.id, name: r.prepared?.def.title, icon: r.prepared?.def.icon,
      error: r.error, errorStage: r.errorStage, loadedAt: r.loadedAt,
    }])) }
  developerWatchers.forEach(fn => fn())
}
function serial<T>(work: () => Promise<T>, quiet = false): Promise<T> {
  pending++; if (!quiet) announceDeveloper()
  const result = queue.then(work)
  queue = result.catch(() => {})
  return result.finally(() => { pending--; announceDeveloper() })
}

async function prepare(p: RawPlugin, developer = false): Promise<Prepared> {
  // Give dynamically loaded bundles recognizable paths in the inspector.
  const debugPath = `sshdesk-plugin://${p.dir.split('/').map(encodeURIComponent).join('/')}/index.js`
  const url = URL.createObjectURL(new Blob([p.source, `\n//# sourceURL=${debugPath}\n`], { type: 'text/javascript' }))
  let mod: PluginModule
  try { mod = await import(/* @vite-ignore */ url) as PluginModule }
  finally { URL.revokeObjectURL(url) }
  const m = mod.manifest
  if (!m || typeof m.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(m.id) || typeof m.name !== 'string' || !m.name.trim()) {
    throw new Error('Export a manifest with an id (lowercase letters, digits, hyphens or underscores) and a name.')
  }
  if (m.id === 'desk' || APPS.some(a => a.id === m.id && !a.plugin)) throw new Error(`“${m.id}” is reserved for a built-in app.`)
  if (typeof mod.createApp !== 'function') throw new Error('Export a createApp function that returns a React component.')
  if (m.icon !== undefined && typeof m.icon !== 'string') throw new Error('manifest.icon must be an icon name or emoji string.')
  for (const value of [m.window?.w, m.window?.h]) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      throw new Error('manifest.window dimensions must be positive numbers.')
    }
  }
  if (m.tokens !== undefined) {
    if (!m.tokens || typeof m.tokens !== 'object' || Array.isArray(m.tokens)) throw new Error('manifest.tokens must be an object.')
    for (const [name, token] of Object.entries(m.tokens)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || !token || !['icon', 'color', 'length', 'image'].includes(token.type)
        || typeof token.default !== 'string' || typeof token.label !== 'string' || (token.hint !== undefined && typeof token.hint !== 'string')) {
        throw new Error(`Invalid appearance token “${name}”: supply a type, string default, and label.`)
      }
    }
  }
  const build = mod.createAdapter
  const api = build ? build(makeSdk()) : {}
  const perHost = new Map<string, Record<string, unknown>>()
  const useApi = () => {
    const h = useHost()
    if (!build) return api
    let a = perHost.get(h)
    if (!a) { a = build(makeSdk(() => h)); perHost.set(h, a) }
    return a
  }
  const Component = mod.createApp({ React, h: React.createElement, html: htm.bind(React.createElement), fw, useFw, api, useApi, EmbeddedWebview })
  if (typeof Component !== 'function' && !(typeof Component === 'object' && Component !== null)) {
    throw new Error('createApp must return a React component.')
  }
  return {
    def: {
      id: m.id, title: m.name, icon: m.icon ?? '🧩', component: Component,
      w: m.window?.w ?? 860, h: m.window?.h ?? 540,
      opens: m.opens, requires: m.requires,
      description: typeof m.description === 'string' ? m.description : undefined,
      plugin: { directory: p.dir, version: typeof m.version === 'string' ? m.version : undefined, author: typeof m.author === 'string' ? m.author : undefined, developer, revision: ++revision },
    },
    tokens: { app: { type: 'icon', default: m.icon ?? '🧩', label: 'App icon' }, ...(m.tokens ?? {}) },
    style: p.style,
  }
}

// Only changed definitions are replaced. Existing window records (and all other
// apps) stay intact; React remounts just the changed component and its boundary.
function publish() {
  const effective = new Map(base)
  if (config.enabled) for (const entry of config.apps) {
    const prepared = local.get(entry.directory)?.prepared
    if (entry.enabled && prepared) effective.set(prepared.def.id, prepared)
  }
  const removed = APPS.filter(a => a.plugin && !effective.has(a.id)).map(a => a.id)
  for (let i = APPS.length - 1; i >= 0; i--) if (removed.includes(APPS[i].id)) APPS.splice(i, 1)
  for (const [id, prepared] of effective) {
    const at = APPS.findIndex(a => a.id === id)
    if (APPS[at] === prepared.def) continue
    document.querySelectorAll<HTMLStyleElement>('style[data-plugin]').forEach(el => { if (el.dataset.plugin === id) el.remove() })
    if (prepared.style) {
      const style = document.createElement('style')
      style.dataset.plugin = id; style.textContent = prepared.style; document.head.appendChild(style)
    }
    if (at < 0) APPS.push(prepared.def)
    else APPS[at] = prepared.def
    declareTokens(id, prepared.tokens)
  }
  for (const id of removed) {
    document.querySelectorAll<HTMLStyleElement>('style[data-plugin]').forEach(el => { if (el.dataset.plugin === id) el.remove() })
    removeTokenDeclarations(id)
  }
  watchers.forEach(fn => { try { fn(removed) } catch (e) { console.error(e) } })
  announceDeveloper()
}

async function loadLocal(directory: string) {
  const previous = local.get(directory)
  let stamp = previous?.stamp
  try {
    const raw = await invoke<RawPlugin>('developer_app_read', { directory })
    stamp = raw.stamp
    const prepared = await prepare(raw, true)
    if (previous?.prepared && previous.prepared.def.id !== prepared.def.id) {
      throw new Error('The app ID changed. Remove this registration and load the folder again to use a new ID.')
    }
    for (const [other, runtime] of local) {
      if (other !== directory && runtime.prepared?.def.id === prepared.def.id) {
        throw new Error(`App ID “${prepared.def.id}” is already registered from ${other}. Use a unique ID or remove that registration.`)
      }
    }
    const entry = config.apps.find(a => a.directory === directory)
    if (entry && (entry.name !== prepared.def.title || entry.icon !== prepared.def.icon)) {
      config = await invoke<DeveloperConfig>('developer_apps_change', {
        change: { op: 'describe', directory, name: prepared.def.title, icon: prepared.def.icon },
      })
    }
    local.set(directory, { prepared, stamp, loadedAt: Date.now() })
  } catch (e) {
    local.set(directory, { ...previous, stamp, error: String(e), errorStage: 'load' })
    console.error(`sshdesk: local app ${directory}:`, e)
  }
}

async function syncLocal() {
  const active = config.enabled ? config.apps.filter(a => a.enabled) : []
  for (const directory of local.keys()) if (!active.some(a => a.directory === directory)) local.delete(directory)
  for (const entry of active) if (!local.has(entry.directory)) await loadLocal(entry.directory)
  observed.clear()
  if (timer) clearInterval(timer)
  timer = config.enabled && config.apps.some(a => a.enabled && a.watch) ? setInterval(() => { void checkForChanges() }, 1000) : undefined
  publish()
}

async function checkForChanges() {
  if (pending || document.querySelector('[aria-modal="true"], .desk-dragging, .desk-resizing')) return
  await serial(async () => {
    try {
      const stamps = await invoke<Array<[string, string]>>('developer_app_stamps')
      for (const [directory, stamp] of stamps) {
        const runtime = local.get(directory)
        if (stamp !== runtime?.stamp && observed.get(directory) === stamp) {
          await loadLocal(directory)
          // Missing/broken files are retried after the next disk change, not
          // every second. Two stable observations debounce build output.
          const loaded = local.get(directory)
          if (loaded) loaded.stamp = stamp
          publish()
        }
        observed.set(directory, stamp)
      }
    } catch (e) { settingsError = String(e) }
  }, true)
}

export function changeDeveloperApps(change: DeveloperChange) {
  return serial(async () => {
    try {
      config = await invoke<DeveloperConfig>('developer_apps_change', { change })
      settingsError = ''; ready = true
      await syncLocal()
    } catch (e) { settingsError = String(e); throw e }
  })
}

export function reloadLocalApp(directory: string) {
  return serial(async () => {
    if (!config.enabled || !config.apps.some(a => a.directory === directory && a.enabled)) return
    await loadLocal(directory)
    observed.delete(directory)
    publish()
  })
}

export function reportPluginError(directory: string, message: string) {
  const runtime = local.get(directory)
  if (runtime) { local.set(directory, { ...runtime, error: message, errorStage: 'render' }); announceDeveloper() }
}

export function loadPlugins(): Promise<string[]> {
  if (!(window as any).__TAURI__?.core?.invoke) return Promise.resolve([])
  return serial(async () => {
    const raw = await invoke<RawPlugin[]>('list_plugins')
    const next = new Map<string, Prepared>()
    failures = []
    for (const p of raw) {
      try {
        const prepared = await prepare(p)
        if (next.has(prepared.def.id)) throw new Error(`Duplicate app ID: ${prepared.def.id}`)
        next.set(prepared.def.id, prepared)
      } catch (e) {
        failures.push({ name: p.name, directory: p.dir, message: String(e) })
        console.error(`sshdesk: plugin ${p.name}:`, e)
      }
    }
    base = next
    try {
      config = await invoke<DeveloperConfig>('developer_apps_get')
      settingsError = ''; ready = true
      for (const entry of config.apps) if (config.enabled && entry.enabled) await loadLocal(entry.directory)
    } catch (e) { settingsError = String(e); ready = true }
    await syncLocal()
    return APPS.filter(a => a.plugin).map(a => a.id)
  })
}

/** Explicit reload-all retains its existing save/close confirmation in Settings. */
export async function reloadPlugins(closeWindows: (appIds: string[]) => void) {
  closeWindows(APPS.filter(a => a.plugin).map(a => a.id))
  return loadPlugins()
}
