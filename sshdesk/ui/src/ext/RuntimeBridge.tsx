import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { fw } from '../fw'
import { useDialog } from '../wm/Dialog'
import { useWM } from '../wm/store'
import { onRuntimeEvent, runtimeEventsReady } from './runtimeEvents'

export function RuntimeBridge() {
  const { dispatch } = useWM()
  const { confirm, prompt, alert } = useDialog()
  useEffect(() => {
    void runtimeEventsReady()
    let dialogOpen = false
    return onRuntimeEvent(e => {
      const { runtime: r, kind, payload } = e
      if (kind === 'title' && typeof payload === 'string') dispatch({ t: 'title', id: r.winId, title: payload.slice(0,200) })
      if (kind === 'focus') {
        dispatch({ t: 'focus', id: r.winId })
        document.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(r.winId)}"]`)?.parentElement?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      }
      if (kind === 'fs:changed') fw.bus.emit(kind, { ...payload, host: r.host })
      // The gateway allows a path only; nothing else an app sends reaches another app.
      if (kind === 'open') fw.ui.open(String(payload.appId), { ...(typeof payload.props?.path === 'string' ? { path: payload.props.path } : {}), host: r.host })
      if (kind === 'dialog') {
        if (dialogOpen || document.querySelector('[aria-modal="true"]')) {
          void invoke('runtime_reply', { label: r.label, id: payload.id, value: null }).catch(() => {})
          return
        }
        dialogOpen = true
        const options = payload.options || {}
        // Attribution is supplied by the trusted native session, not the app.
        const title = `${r.name} — ${String(options.title || 'Request').slice(0,160)}`
        const body = `${r.host}\n${String(options.message || options.label || '').slice(0,4000)}`
        const request = payload.kind === 'confirm' ? confirm({ title, message: body, okLabel: String(options.okLabel || 'Continue'), danger: !!options.danger })
          // Masked input is exactly what the gateway gated on remote.sudo.
          : payload.kind === 'prompt' ? prompt({ title, label: body, password: options.password === true, value: String(options.value || ''), placeholder: String(options.placeholder || ''), okLabel: String(options.okLabel || 'Continue') })
          : alert({ title, message: body })
        void request.then(value => invoke('runtime_reply', { label: r.label, id: payload.id, value: value ?? null }))
          .catch(() => {}).finally(() => { dialogOpen = false })
      }
    })
  }, [dispatch, confirm, prompt, alert])
  return null
}
