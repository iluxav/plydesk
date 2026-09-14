import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useWM } from '../wm/store'
import { Icon } from '../wm/Icon'
import { workArea } from '../wm/workArea'
import { ACTIONS, MAC_CODES, META, CTRL, ALT, modifiers, type Shortcut } from './shortcuts'
import { useKeyboardPreferences } from './preferences'
import './keyboard.css'
import { TERMINAL_KEYS } from '../apps/terminal/shortcuts'

type NativeEvent = { action: string; code: number; modifiers: number; repeat: boolean }
type Status = { native: boolean; accessibility: boolean; captureReady: boolean }
type Recorder = ((shortcut: Shortcut | null) => void) | null
type Switcher = { ids: string[]; index: number; held: number }
const Context = createContext<{ status: Status; error: string; setRecorder: (recorder: Recorder) => void; refresh: () => void } | null>(null)
// All updates, including Strict Mode cleanup and unmount, reach AppKit in order.
let nativeQueue: Promise<unknown> = Promise.resolve()
const configure = (config: unknown) => {
  const request = nativeQueue.catch(() => {}).then(() => invoke<Status>('keyboard_configure', { config }))
  nativeQueue = request
  return request
}
export function useKeyboard() {
  const value = useContext(Context)
  if (!value) throw new Error('Keyboard settings require a desktop')
  return value
}

export function KeyboardProvider({ active, onSwitchHost, onLauncher, disabled, children }: {
  active: string; onSwitchHost: (host: string) => void; onLauncher?: () => void; disabled: boolean; children: ReactNode
}) {
  const { state, dispatch } = useWM()
  const preferences = useKeyboardPreferences()
  const frontWindow = [...state.wins].filter(w => w.host === active && !w.minimized).sort((a, b) => b.z - a.z)[0]
  const terminalActive = frontWindow?.appId === 'terminal'
  const [status, setStatus] = useState<Status>({ native: false, accessibility: false, captureReady: false })
  const [error, setError] = useState('')
  const [listening, setListening] = useState(!isTauri())
  const [recording, setRecording] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [switcher, setSwitcher] = useState<Switcher | null>(null)
  const isSwitching = !!switcher
  const [revision, setRevision] = useState(0)
  const recorder = useRef<Recorder>(null)
  const switching = useRef<Switcher | null>(null)
  const latest = useRef({ state, active, disabled, blocked, preferences, status })
  useLayoutEffect(() => { latest.current = { state, active, disabled, blocked, preferences, status } })
  const refresh = useCallback(() => setRevision(n => n + 1), [])
  const setRecorder = useCallback((value: Recorder) => { recorder.current = value; setRecording(!!value) }, [])
  const updateSwitcher = useCallback((value: Switcher | null) => { switching.current = value; setSwitcher(value) }, [])

  const focusWindow = useCallback((id: string) => {
    const win = latest.current.state.wins.find(w => w.id === id)
    if (!win) return
    onSwitchHost(win.host)
    dispatch({ t: 'focus', id })
    requestAnimationFrame(() => {
      const node = document.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(id)}"]`)
      const target = node?.querySelector<HTMLElement>('.window-content [tabindex="0"], .window-content textarea, .window-content input') || node
      target?.focus({ preventScroll: true })
    })
  }, [dispatch, onSwitchHost])
  const finish = useCallback((commit: boolean) => {
    const current = switching.current
    updateSwitcher(null)
    if (commit && current) focusWindow(current.ids[current.index])
  }, [focusWindow, updateSwitcher])

  const handle = useCallback((event: NativeEvent) => {
    const current = latest.current
    if (event.action === 'blur') { finish(false); recorder.current?.(null); return }
    if (event.action === 'capture-disabled') { setStatus(s => ({ ...s, captureReady: false })); setError('macOS paused shortcut capture. Turn capture off and on to retry.'); return }
    if (current.disabled) return
    if (event.action === 'modifiers') {
      if (switching.current && !(event.modifiers & switching.current.held)) finish(true)
      return
    }
    if (event.action === 'cancel-recording') { recorder.current?.(null); return }
    if (event.action === 'record') {
      const code = Object.keys(MAC_CODES).find(code => MAC_CODES[code] === event.code)
      if (code && !event.repeat) recorder.current?.({ code, modifiers: event.modifiers })
      return
    }
    if (current.blocked || recorder.current) return
    if (event.action === 'cancel-switch' || event.action === 'commit-switch') { finish(event.action === 'commit-switch'); return }
    if (event.action === 'next-window' || event.action === 'previous-window') {
      // Keep a fixed MRU order throughout the gesture, so repeated presses
      // visit every window instead of oscillating between the most recent two.
      const direction = event.action === 'next-window' ? 1 : -1
      let next = switching.current
      if (!next) {
        const wins = [...current.state.wins].sort((a, b) => b.z - a.z)
        if (!wins.length) return
        const front = wins.find(w => w.host === current.active && !w.minimized)
        const ids = wins.map(w => w.id)
        const start = front ? ids.indexOf(front.id) : direction === 1 ? -1 : 0
        next = { ids, index: (start + direction + ids.length) % ids.length, held: event.modifiers & META ? META : event.modifiers & CTRL ? CTRL : ALT }
        if (isTauri()) void getCurrentWebview().setFocus().catch(() => {})
      } else next = { ...next, index: (next.index + direction + next.ids.length) % next.ids.length }
      updateSwitcher(next)
      return
    }
    if (event.repeat) return
    if (event.action === 'launcher') { finish(false); onLauncher?.(); return }
    const front = [...current.state.wins].filter(w => w.host === current.active && !w.minimized).sort((a, b) => b.z - a.z)[0]
    if (!front) return
    if (event.action.startsWith('terminal-') && front.appId === 'terminal') {
      window.dispatchEvent(new CustomEvent('terminal-action', { detail: { winId: front.id, action: event.action.slice(9) } }))
      return
    }
    if (event.action === 'minimize') { dispatch({ t: 'minimize', id: front.id }); return }
    const layouts: Record<string, 'left' | 'right' | 'maximized' | 'restore'> = { 'snap-left': 'left', 'snap-right': 'right', maximize: 'maximized', restore: 'restore' }
    const layout = layouts[event.action]
    const pane = document.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(front.id)}"]`)?.parentElement
    if (layout && pane) dispatch({ t: 'layout', id: front.id, layout, ...workArea(pane) })
  }, [dispatch, finish, updateSwitcher, onLauncher])

  useEffect(() => {
    const check = () => setBlocked(!!document.querySelector('[aria-modal="true"]:not(:has([data-shortcut-recorder])), [role="menu"], .desk-dragging, .desk-resizing'))
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-modal', 'role'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (switcher && switcher.ids.some(id => !state.wins.some(w => w.id === id))) finish(false)
  }, [state.wins, switcher, finish])

  useEffect(() => {
    let disposed = false
    const cleanups: (() => void)[] = []
    if (isTauri()) {
      void listen<NativeEvent>('desktop-shortcut', e => handle(e.payload)).then(stop => {
        if (disposed) stop(); else { cleanups.push(stop); setListening(true) }
      }).catch(e => setError(String(e)))
      void getCurrentWindow().onFocusChanged(e => {
        if (e.payload) refresh(); else { finish(false); recorder.current?.(null) }
      }).then(stop => { if (disposed) stop(); else cleanups.push(stop) })
    }
    const down = (e: KeyboardEvent) => {
      // AppKit already handles native keys, including keys inside child views.
      if (latest.current.status.native || !document.hasFocus() || latest.current.disabled) return
      const mods = modifiers(e)
      let action = ''
      if (recorder.current) action = e.code === 'Escape' ? 'cancel-recording' : mods & 14 ? 'record' : ''
      else if (latest.current.blocked) return
      else if (switching.current && e.code === 'Escape') action = 'cancel-switch'
      else if (switching.current && e.code === 'Enter') action = 'commit-switch'
      else action = ACTIONS.find(a => {
        const binding = latest.current.preferences.bindings[a.id]
        return binding?.code === e.code && binding.modifiers === mods
      })?.id || ''
      if (!action || e.isComposing) return
      e.preventDefault(); e.stopImmediatePropagation()
      handle({ action, modifiers: mods, code: MAC_CODES[e.code], repeat: e.repeat })
    }
    const up = (e: KeyboardEvent) => { if (!latest.current.status.native) handle({ action: 'modifiers', code: 0, modifiers: modifiers(e), repeat: false }) }
    const blur = () => { if (!isTauri()) { finish(false); recorder.current?.(null) } }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      disposed = true; cleanups.forEach(stop => stop())
      window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
      if (isTauri()) void configure({ bindings: [], enabled: false, recording: false, switching: false, captureSystem: false }).catch(() => {})
    }
  }, [handle, finish, refresh])

  useEffect(() => {
    if (!isTauri() || !listening) return
    let live = true
    const bindings: Array<{ action: string; code: number; modifiers: number }> = ACTIONS.flatMap(a => {
      const shortcut = preferences.bindings[a.id]
      return shortcut ? [{ action: a.id, code: MAC_CODES[shortcut.code], modifiers: shortcut.modifiers }] : []
    })
    if (terminalActive) bindings.push(...TERMINAL_KEYS.filter(key => !bindings.some(b => b.code === MAC_CODES[key.code] && b.modifiers === key.modifiers))
      .map(key => ({ action: `terminal-${key.action}`, code: MAC_CODES[key.code], modifiers: key.modifiers })))
    void configure({ bindings, enabled: !disabled && (!blocked || recording), recording,
      switching: isSwitching, captureSystem: preferences.captureSystem }).then(value => {
        if (live) { setStatus(value); setError('') }
      }).catch(e => { if (live) setError(String(e)) })
    return () => { live = false }
  }, [preferences, disabled, blocked, recording, isSwitching, listening, revision, terminalActive])

  const context = useMemo(() => ({ status, error, setRecorder, refresh }), [status, error, setRecorder, refresh])
  return <Context.Provider value={context}>
    {children}
    {switcher && <div className="window-switcher-scrim" data-window-switcher onPointerDown={() => finish(false)}>
      <div className="window-switcher" role="listbox" aria-label="Open windows" aria-activedescendant={`switcher-${switcher.ids[switcher.index]}`}
        onPointerDown={e => e.stopPropagation()}>
        <div className="window-switcher-heading"><strong>Open windows</strong><span>Release to switch · Esc to cancel</span></div>
        <div className="window-switcher-items">{switcher.ids.map((id, index) => {
          const win = state.wins.find(w => w.id === id)
          return win && <button key={id} id={`switcher-${id}`} role="option" aria-selected={index === switcher.index}
            onClick={() => { updateSwitcher(null); focusWindow(id) }}>
            <span className={`app-tile app-tile-${win.appId}`}><Icon id={win.icon} size={28} /></span>
            <strong>{win.title}</strong><small>{win.host.replace(/^.*@/, '')}{win.minimized ? ' · Minimized' : ''}</small>
          </button>
        })}</div>
      </div>
    </div>}
  </Context.Provider>
}
