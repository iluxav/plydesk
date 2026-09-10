/* eslint-disable react-refresh/only-export-components -- Standalone native webview entry, not a refreshable module. */
import '../fw/migrate'   // first: renames stored preferences before anything reads them
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import htm from 'htm'
import { invoke as native } from '@tauri-apps/api/core'
import { fw, setHost } from '../fw'
import { makeSdk, setPasswordPrompt } from './sdk'
import { installRuntimeGateway } from './invoke'
import { AppBoundary } from '../wm/AppBoundary'
import type { AppManifest } from './loader'
import '../index.css'
import '../apps/apps.css'
import './runtime.css'

installRuntimeGateway()
const pending = new Map<string, (value: unknown) => void>()
const send = (kind: string, payload: unknown = {}) => native('runtime_event', { kind, payload })
let failed = false, readySent = false
const deferred: string[] = []
/** A failure to boot or render: the desktop treats it as fatal until ready. */
const report = (reason: unknown) => { failed = true; console.error(reason); void send('error', String(reason)).catch(() => {}) }
/** A stray error in app code: surfaced in Developer settings, never a reason not to start. */
const warn = (reason: unknown) => {
  console.error(reason)
  if (readySent) void send('error', String(reason)).catch(() => {})
  else deferred.push(String(reason))
}
window.addEventListener('error', e => warn(e.error || e.message))
window.addEventListener('unhandledrejection', e => warn(e.reason))
// Apps own right-click, as on the desktop; text fields keep the native menu.
document.addEventListener('contextmenu', e => {
  const t = e.target as HTMLElement | null
  if (!t?.closest('input, textarea, [contenteditable], .select-text')) e.preventDefault()
})
// randomUUID needs a secure context, which a custom scheme may not be.
const requestId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
function context(value: { css?: string; seeds?: Record<string,string> }) {
  let style = document.getElementById('runtime-theme')
  if (!style) { style = document.createElement('style'); style.id = 'runtime-theme'; document.head.append(style) }
  style.textContent = value.css || ''
  for (const [key, entry] of Object.entries(value.seeds || {})) {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, entry) } catch { /* platform storage may be unavailable */ }
  }
}
window.addEventListener('plydesk:runtime', ((event: CustomEvent) => {
  const { kind, payload } = event.detail
  if (kind === 'context') context(payload)
  if (kind === 'reply') { pending.get(payload.id)?.(payload.value); pending.delete(payload.id) }
  if (kind === 'bus') fw.bus.emit(payload.topic, payload.payload)
}) as EventListener)
async function dialog(kind: string, options: unknown): Promise<any> {
  const id = requestId()
  const promise = new Promise(resolve => pending.set(id, resolve))
  try { await send('dialog', { id, kind, options }) }
  catch (e) { pending.delete(id); throw e }
  return promise
}

/** Content webviews have no SDK. The native parent owns their identity/lifetime. */
function EmbeddedContent({ url, title, onReady, onError }: { url: string; title: string; onReady?: () => void; onError?: (s: string) => void }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const callbacks = React.useRef({ onReady, onError })
  React.useLayoutEffect(() => { callbacks.current = { onReady, onError } })
  React.useEffect(() => {
    let disposed = false, ready = false, label = ''
    const sync = () => {
      if (!ready || disposed || !ref.current) return
      const r = ref.current.getBoundingClientRect()
      void native('runtime_embed_bounds', { bounds: [r.x,r.y,r.width,r.height] }).catch(() => {})
    }
    const resize = new ResizeObserver(sync)
    if (ref.current) resize.observe(ref.current)
    void native<string>('runtime_embed', { url }).then(created => {
      label = created
      if (disposed) { void native('runtime_embed_close', { label }).catch(() => {}); return }
      ready = true; sync(); callbacks.current.onReady?.()
    }).catch(e => { if (!disposed) callbacks.current.onError?.(String(e)) })
    return () => { disposed = true; resize.disconnect(); if (ready) void native('runtime_embed_close', { label }).catch(() => {}) }
  }, [url])
  return <div ref={ref} className="embedded-webview" aria-label={title} />
}

function Ready() {
  React.useLayoutEffect(() => { queueMicrotask(() => {
    if (failed) return
    readySent = true
    void send('ready').catch(() => {})
    for (const reason of deferred.splice(0)) void send('error', reason).catch(() => {})
  }) }, [])
  return null
}
async function boot() {
  const boot = await native<{ manifest: AppManifest; host: string; props: Record<string,unknown>; context: Parameters<typeof context>[0] }>('runtime_bootstrap')
  setHost(boot.host)
  context(boot.context)
  document.body.className = `runtime-body app-${boot.manifest.id}`
  document.body.dataset.host = boot.host
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = './style.css'; document.head.append(style)
  const api = fw.for(boot.host)
  fw.ui._installDialogs({ confirm: o => dialog('confirm',o), prompt: o => dialog('prompt',o), alert: o => dialog('alert',o) })
  fw.ui._install((appId, props) => { void send('open', { appId, props }).catch(report) })
  setPasswordPrompt(host => dialog('prompt', { title: 'Administrator password', label: `Allow this app to run an elevated command on ${host}.`, password: true, okLabel: 'Continue' }))
  // No global Tauri event subscription: only this session's signals are sent
  // through the native bridge. Closing the runtime cancels the subscription.
  api.sys.watchUnits = () => native('runtime_call', { command: 'watch_units', args: {} })
  fw.sys.watchUnits = api.sys.watchUnits
  const originalEmit = fw.bus.emit
  // Local listeners continue to work, while file changes reach desktop views.
  api.bus.emit = (topic, payload) => {
    originalEmit(topic, payload)
    if (topic === 'fs:changed') void send(topic, payload).catch(() => {})
  }
  const mod = await import(/* @vite-ignore */ new URL('./index.js', location.href).href)
  if (typeof mod.createApp !== 'function') throw new Error('index.js must export createApp')
  if (mod.manifest && mod.manifest.id !== boot.manifest.id) throw new Error('The JavaScript app ID does not match manifest.json')
  const adapter = mod.createAdapter ? mod.createAdapter(makeSdk(() => boot.host)) : {}
  const Component = mod.createApp({ React, h: React.createElement, html: htm.bind(React.createElement), fw: api, useFw: () => api, api: adapter, useApi: () => adapter, EmbeddedWebview: EmbeddedContent })
  if (typeof Component !== 'function' && !(typeof Component === 'object' && Component)) throw new Error('createApp must return a React component')
  const setTitle = (title: string) => { document.title = title; void send('title', String(title).slice(0,200)).catch(() => {}) }
  createRoot(document.getElementById('root')!).render(<AppBoundary name={boot.manifest.name} onError={report}>
    <Component {...boot.props} host={boot.host} setTitle={setTitle} /><Ready />
  </AppBoundary>)
  document.addEventListener('pointerdown', () => { void send('focus').catch(() => {}) }, true)
  // Readiness comes from React's commit, since hidden WKWebViews suspend RAF.
}
void boot().catch(error => {
  report(error)
  const root = document.getElementById('root')!
  root.textContent = `Couldn’t start this app: ${String(error)}`
  root.className = 'runtime-failure'
})
