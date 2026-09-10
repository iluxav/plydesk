import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Webview } from '@tauri-apps/api/webview'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import type { AppDef } from '../desktop/registry'
import { Requires } from '../wm/Requires'
import { Icon } from '../wm/Icon'
import { buildCss } from '../fw/theme'
import { onTokensChanged } from '../fw/tokens'
import { useWM } from '../wm/store'
import { reportPluginError } from './loader'
import { forgetRuntime, onRuntimeEvent, replayRuntime, runtimeEventsReady, type RuntimeEvent } from './runtimeEvents'
import type { AppManifest } from './loader'
import { ACCESS } from './permissions'
import './runtime.css'

type Preview = { ticket: string; manifest: AppManifest; digest: string; approved: boolean; developer: boolean }
type View = { label: string; native: Webview; shown: boolean; bounds: number[]; child?: { label: string; native: Webview; bounds: number[]; shown: boolean } }
function context(app: AppDef, host: string) {
  const seeds: Record<string,string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!
    if (key.startsWith(`sshdesk:${app.id}.`) || key.startsWith(`sshdesk:host:${host}:${app.id}.`)) seeds[key] = localStorage.getItem(key)!
  }
  return { css: buildCss([host], host), seeds }
}
function Launch({ start }: { start: () => void }) { useEffect(start, [start]); return null }

export function PluginView({ app, appProps, host, winId }: { app: AppDef; appProps: Record<string,unknown>; host: string; winId: string }) {
  const { dispatch } = useWM()
  const slot = useRef<HTMLDivElement>(null)
  const active = useRef<View | null>(null)
  const candidate = useRef<string | null>(null)
  const generation = useRef(0)
  const alive = useRef(true)
  const started = useRef(new Set<string>())
  const requestSync = useRef(() => {})
  const current = useRef({ app, host, winId })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [accepted, setAccepted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeLabel, setActiveLabel] = useState('')
  const hasView = !!activeLabel
  const [retry, setRetry] = useState(0)
  const [snapshot, setSnapshot] = useState('')
  const [lastSnapshot, setLastSnapshot] = useState('')
  const loadingRef = useRef(loading)
  useLayoutEffect(() => { current.current = { app, host, winId }; loadingRef.current = loading; requestSync.current() })
  const close = useCallback((label: string) => { forgetRuntime(label); return invoke('runtime_close', { label }).catch(() => {}) }, [])

  // The component survives catalog revisions: only the candidate changes.
  useEffect(() => {
    const gen = ++generation.current
    let ticket = ''
    setPreview(null); setAccepted(false); setLoading(true); setError('')
    void invoke<Preview>('runtime_prepare', { directory: app.plugin!.directory, host }).then(p => {
      ticket = p.ticket
      if (!alive.current || gen !== generation.current) { void invoke('runtime_discard', { ticket }); return }
      setPreview(p); setAccepted(p.approved)
    }).catch(e => { if (alive.current && gen === generation.current) { setError(String(e)); setLoading(false) } })
    return () => { generation.current++; if (ticket) void invoke('runtime_discard', { ticket }).catch(() => {}) }
  }, [app.plugin!.directory, app.plugin!.revision, host, retry])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false; generation.current++
      if (active.current) void close(active.current.label)
      if (candidate.current) void close(candidate.current)
      active.current = null; candidate.current = null
    }
  }, [close])

  const attachChild = useCallback((e: RuntimeEvent) => {
    const view = active.current
    if (!view || e.runtime.label !== view.label) return
    if (!e.payload.label) { view.child = undefined; requestSync.current(); return }
    const childLabel = e.payload.label as string
    void Webview.getByLabel(childLabel).then(child => {
      if (!child || active.current !== view) return
      view.child = { label: childLabel, native: child, bounds: e.payload.bounds, shown: view.child?.label === childLabel && view.child.shown || false }
      void child.setAutoResize(false)
      requestSync.current()
    })
  }, [])

  const start = useCallback(() => {
    if (!preview || !accepted || started.current.has(preview.ticket)) return
    started.current.add(preview.ticket)
    const gen = generation.current
    let label = '', timeout: ReturnType<typeof setTimeout> | undefined
    let stop = () => {}
    const fail = (reason: unknown) => {
      clearTimeout(timeout); stop()
      if (label) void close(label)
      if (candidate.current === label) candidate.current = null
      if (!alive.current || gen !== generation.current) return
      setError(String(reason)); setLoading(false)
      reportPluginError(app.plugin!.directory, String(reason))
    }
    const event = (event: RuntimeEvent) => {
      if (event.runtime.label !== label || !alive.current || gen !== generation.current) return
      if (event.kind === 'error') { fail(event.payload); return }
      if (event.kind === 'ready') {
        clearTimeout(timeout); stop()
        void Webview.getByLabel(label).then(async view => {
          if (!view || !alive.current || gen !== generation.current) { void close(label); return }
          await view.setAutoResize(false)
          const previous = active.current
          active.current = { label, native: view, shown: false, bounds: [] }
          candidate.current = null
          if (previous) await close(previous.label)
          setActiveLabel(label); setLoading(false); setError(''); setPreview(null); setSnapshot(''); setLastSnapshot('')
          requestSync.current()
          replayRuntime(label, e => { if (e.kind === 'embedded') attachChild(e) })
        }).catch(fail)
      }
    }
    void (async () => {
      await runtimeEventsReady()
      label = await invoke<string>('runtime_start', { ticket: preview.ticket, approve: accepted, winId, props: appProps, context: context(app, host) })
      if (!alive.current || gen !== generation.current) { await close(label); return }
      candidate.current = label
      stop = onRuntimeEvent(event)
      timeout = setTimeout(() => fail('This app did not finish starting. Reload to try again.'), 30000)
      replayRuntime(label, event)
    })().catch(fail)
  }, [preview, accepted, app, appProps, host, winId, close, attachChild])

  useEffect(() => onRuntimeEvent(e => {
    if (e.runtime.label !== active.current?.label) return
    if (e.kind === 'embedded') attachChild(e)
    if (e.kind === 'error') { setError(String(e.payload)); reportPluginError(current.current.app.plugin!.directory, String(e.payload)) }
  }), [attachChild])

  // Geometry is owned by the desktop, never by plugin-supplied coordinates.
  useLayoutEffect(() => {
    const element = slot.current!, windowElement = element.closest<HTMLElement>('[data-window]')!
    let frame = 0, busy = false, dirty = false, disposed = false
    const sync = async () => {
      if (busy) { dirty = true; return }
      busy = true
      try {
        do {
          dirty = false
          const view = active.current
          if (!view || disposed) break
          const r = element.getBoundingClientRect()
          const dock = document.querySelector<HTMLElement>('.desktop-dock')
          const bottom = window.innerHeight - (dock?.offsetHeight || 0) - 18
          const height = Math.max(0, Math.min(r.bottom, bottom) - r.top)
          const visible = !loadingRef.current && r.width > 1 && height > 1 && windowElement.dataset.focused === 'true'
            && !element.closest('[inert]') && !document.querySelector('[role="menu"], [aria-modal="true"], [data-window-switcher]')
          if (!visible) {
            if (view.child?.shown) { await view.child.native.hide(); view.child.shown = false }
            if (view.shown) {
              // A cached native snapshot keeps covered apps recognizable while
              // their webviews are hidden behind HTML chrome and dialogs.
              void invoke<string>('runtime_snapshot', { label: view.label }).then(data => {
                if (alive.current && active.current === view && data) { setSnapshot(data); setLastSnapshot(view.label) }
              }).catch(() => {})
              await view.native.hide(); view.shown = false
            }
            continue
          }
          const b = [r.x,r.y,r.width,height].map(Math.round)
          if (b[0] !== view.bounds[0] || b[1] !== view.bounds[1]) await view.native.setPosition(new LogicalPosition(b[0],b[1]))
          if (b[2] !== view.bounds[2] || b[3] !== view.bounds[3]) await view.native.setSize(new LogicalSize(b[2],b[3]))
          view.bounds = b
          if (!view.shown && !disposed) { await view.native.show(); await view.native.setFocus(); view.shown = true }
          if (view.child) {
            const c = view.child, [x,y,w,h] = c.bounds
            const cx = Math.max(0,Math.min(x,b[2])), cy = Math.max(0,Math.min(y,b[3]))
            const cw = Math.max(0,Math.min(w,b[2]-cx)), ch = Math.max(0,Math.min(h,b[3]-cy))
            if ([cx,cy,cw,ch].every(Number.isFinite) && cw > 1 && ch > 1) {
              await c.native.setPosition(new LogicalPosition(b[0]+cx,b[1]+cy)); await c.native.setSize(new LogicalSize(cw,ch))
              if (!c.shown) { await c.native.show(); await c.native.setFocus(); c.shown = true }
            } else if (c.shown) { await c.native.hide(); c.shown = false }
          }
        } while (dirty && !disposed)
      } catch { /* closing a native view may race an already scheduled move */ }
      finally { busy = false }
    }
    const schedule = () => { if (frame || disposed) return; frame = requestAnimationFrame(() => { frame = 0; void sync() }) }
    requestSync.current = schedule
    const resize = new ResizeObserver(schedule); resize.observe(element)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style','class','data-focused','inert','aria-modal','role'] })
    window.addEventListener('resize', schedule)
    const theme = onTokensChanged(() => {
      const c = current.current
      if (active.current) void invoke('runtime_context', { label: active.current.label, context: context(c.app,c.host) }).catch(() => {})
    })
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize',schedule); theme() }
  }, [])

  const deny = () => {
    if (preview) void invoke('runtime_discard', { ticket: preview.ticket })
    if (hasView) { setPreview(null); setLoading(false); setError('The update was not allowed. The previous version is still open.') }
    else dispatch({ t: 'close', id: winId })
  }
  return <div className="app-runtime-host" data-runtime-label={activeLabel}>
    <div ref={slot} className="app-runtime-slot">
      {loading && preview && !accepted ? <div className="app-access">
        <div className="app-access-heading"><span className="app-access-mark"><Icon id={app.icon} size={26} /></span><div><h2>Allow {preview.manifest.name} access?</h2><p>Version {preview.manifest.version} · {host}</p></div></div>
        <p>This app requests the following access on this machine. Your approval is saved by SSHDesk before its code runs.</p>
        <ul className="app-access-list">{preview.manifest.permissions.map(p => <li key={p}><strong>{ACCESS[p]?.[0] || p}</strong><p>{ACCESS[p]?.[1]}</p></li>)}</ul>
        <p className="app-access-source">Source: {app.plugin!.directory}</p>
        {preview.developer && <p>Developer app: approval also covers code edits in this folder. Changing manifest.json asks again.</p>}
        <div className="app-access-actions"><button className="app-button" onClick={deny}>Deny</button><button className="app-button is-primary" onClick={() => setAccepted(true)}>Allow and open</button></div>
      </div> : loading && preview && accepted ? <Requires key={preview.ticket} requires={preview.manifest.requires} name={app.title}><Launch start={start} /><div className="app-runtime-placeholder"><span className="ui-spinner" /><strong>Opening {app.title}…</strong></div></Requires>
        : snapshot && lastSnapshot === activeLabel ? <img className="app-runtime-preview" src={snapshot} alt={`${app.title} preview`} />
        : <div className="app-runtime-placeholder"><Icon id={app.icon} size={32} /><strong>{loading ? `Opening ${app.title}…` : app.title}</strong><span>{loading ? 'Preparing app runtime' : hasView ? 'Select this window to continue' : 'This app could not start'}</span></div>}
    </div>
    {error && <div className="app-runtime-notice" role="alert"><span>{error}{hasView ? ' The existing view remains available.' : ''}</span><button className="app-button" onClick={() => setRetry(n => n+1)}>Reload</button></div>}
  </div>
}
