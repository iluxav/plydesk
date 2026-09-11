import { useLayoutEffect, useRef, useState } from 'react'
import { Webview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

let nextView = 0
export type WebLoad = { label: string; url: string; loading: boolean }

/** A first-party webview inside a desktop window, with the desktop owning its lifetime. */
export function EmbeddedWebview({ url, title, shortcutId, onCreated, onLoad, onReady, onError }: {
  url: string
  title: string
  shortcutId?: string
  onCreated?: (label: string) => void
  onLoad?: (state: WebLoad) => void
  onReady?: () => void
  onError?: (message: string) => void
}) {
  const slot = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onCreated, onLoad, onReady, onError })
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  useLayoutEffect(() => { callbacks.current = { onCreated, onLoad, onReady, onError } })

  useLayoutEffect(() => {
    const element = slot.current
    const desktopWindow = element?.closest<HTMLElement>('[data-window]')
    if (!element || !desktopWindow) return
    let disposed = false
    let created = false
    let ready = false
    let shown = false
    let pending = false
    let dirty = false
    let frame = 0
    let previousBounds: number[] = []
    let view: Webview | undefined
    let offLoad: (() => void) | undefined
    const close = (current: Webview) => shortcutId
      ? invoke('shortcut_web_close', { label: current.label }).catch(() => {})
      : current.close().catch(() => {})
    setError('')
    setPreview('')

    const fail = (reason: unknown) => {
      if (disposed) return
      const message = String(reason)
      setError(message)
      callbacks.current.onError?.(message)
    }

    // Native child views sit above HTML. Hide them while a desktop menu,
    // dialog, or another window is in front; the page and its session stay alive.
    const sync = async () => {
      if (disposed || !ready || !view) return
      if (pending) { dirty = true; return }
      pending = true
      try {
        do {
          dirty = false
          const rect = element.getBoundingClientRect()
          // Leave the dock/reveal area in the HTML surface's control, even
          // when a floating window is moved down over it.
          const dock = document.querySelector<HTMLElement>('.desktop-dock')
          const bottom = dock ? window.innerHeight - dock.offsetHeight - 18 : window.innerHeight
          const height = Math.min(rect.bottom, bottom) - rect.top
          const visible = rect.width > 1 && height > 1
            && desktopWindow.dataset.focused === 'true'
            && !element.closest('[inert]')
            && !document.querySelector('[role="menu"], [aria-modal="true"], [data-window-switcher]')
          if (!visible) {
            if (shown) {
              if (shortcutId) {
                const snapshot = await invoke<string>('shortcut_web_snapshot', { label: view.label }).catch(() => '')
                if (!disposed && snapshot) setPreview(snapshot)
              }
              await view.hide(); shown = false
            }
            continue
          }
          const bounds = [rect.x, rect.y, rect.width, height].map(Math.round)
          // A move only changes position. Avoid resizing the editor on every
          // pointer move, which needlessly relayouts its contents during a drag.
          if (bounds[0] !== previousBounds[0] || bounds[1] !== previousBounds[1])
            await view.setPosition(new LogicalPosition(bounds[0], bounds[1]))
          if (bounds[2] !== previousBounds[2] || bounds[3] !== previousBounds[3])
            await view.setSize(new LogicalSize(bounds[2], bounds[3]))
          previousBounds = bounds
          if (!disposed && !shown) {
            await view.show()
            await view.setFocus()
            shown = true
          }
        } while (dirty && !disposed)
      } catch (reason) { fail(reason) }
      finally { pending = false }
    }
    const schedule = () => {
      if (frame || disposed) return
      frame = requestAnimationFrame(() => { frame = 0; void sync() })
    }

    // Observe actual DOM geometry, including the window manager's direct style
    // updates during gestures and machine panes changing width.
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['style', 'class', 'data-focused', 'inert', 'aria-modal', 'role'] })
    window.addEventListener('resize', schedule)

    const prepare = async (current: Webview) => {
      created = true
      if (disposed) { await close(current); return }
      try {
        await current.setAutoResize(false)
        await current.hide()
        ready = true
        callbacks.current.onCreated?.(current.label)
        await sync()
        if (!disposed) callbacks.current.onReady?.()
      } catch (reason) { fail(reason) }
    }
    if (shortcutId) {
      void (async () => {
        const loads = new Map<string, WebLoad>()
        offLoad = await listen<WebLoad>('shortcut-web-load', ({ payload }) => {
          if (disposed) return
          if (payload.label === view?.label) callbacks.current.onLoad?.(payload)
          else if (!view) loads.set(payload.label, payload)
        })
        if (disposed) { offLoad(); return }
        const label = await invoke<string>('shortcut_web_open', { id: shortcutId })
        if (disposed) { await invoke('shortcut_web_close', { label }); return }
        view = await Webview.getByLabel(label) ?? undefined
        if (!view) { await invoke('shortcut_web_close', { label }); throw new Error('The website window could not be created.') }
        const load = loads.get(label)
        if (load) callbacks.current.onLoad?.(load)
        loads.clear()
        await prepare(view)
      })().catch(fail)
    } else try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname))
        throw new Error('Embedded apps must use a local SSH-forwarded address.')
      view = new Webview(getCurrentWindow(), `embedded-${++nextView}`, {
        url, x: -10000, y: -10000, width: 1, height: 1,
        focus: false, dragDropEnabled: false,
      })
      const current = view
      void current.once('tauri://created', () => prepare(current))
      void current.once('tauri://error', event => fail(event.payload))
    } catch (reason) { fail(reason) }

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      offLoad?.()
      window.removeEventListener('resize', schedule)
      if (created && view) void close(view)
    }
  }, [url, shortcutId])

  return <div ref={slot} className="embedded-webview" aria-label={title}>
    {preview && !error ? <img className="web-shortcut-preview" src={preview} alt={`${title} preview`} /> : <div className="embedded-webview-placeholder">
      <span aria-hidden="true">{'</>'}</span>
      <strong>{title}</strong>
      <p>{error || 'Select this window to continue.'}</p>
    </div>}
  </div>
}
