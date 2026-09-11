import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { EmbeddedWebview } from '../wm/EmbeddedWebview'
import { Icon } from '../wm/Icon'
import type { Shortcut } from './model'
import './shortcuts.css'

export function WebShortcut({ shortcut, setTitle }: { shortcut: Extract<Shortcut, { kind: 'web' }>; setTitle?: (title: string) => void }) {
  const [attempt, setAttempt] = useState(0)
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [page, setPage] = useState({ url: shortcut.url, loading: true })
  const [slow, setSlow] = useState(false)
  useEffect(() => { setTitle?.(shortcut.name) }, [shortcut.name, setTitle])
  useEffect(() => {
    setSlow(false)
    if (!page.loading) return
    const timer = setTimeout(() => setSlow(true), 20_000)
    return () => clearTimeout(timer)
  }, [page, attempt])
  return <div className="desk-app">
    <div className="web-shortcut-surface"><EmbeddedWebview key={attempt} url={shortcut.url} title={shortcut.name}
      shortcutId={shortcut.id} onCreated={setLabel} onLoad={setPage} onError={setError} /></div>
    <footer className="app-statusbar">
      {page.loading && !error && !slow ? <span className="ui-spinner" /> : <Icon id="lucide:globe" size={12} />}<span className="web-shortcut-status" role="status" title={error || page.url}>{error || (slow ? 'Page hasn’t finished loading. Check your connection or reload.' : new URL(page.url).hostname)}</span>
      <button className="shortcut-status-button" onClick={() => { setLabel(''); setError(''); setPage({ url: shortcut.url, loading: true }); setAttempt(n => n + 1) }}><Icon id="lucide:rotate-cw" size={12} />Reload</button>
      <button className="shortcut-status-button" disabled={!label} onClick={() => {
        void invoke('shortcut_web_browser', { label }).catch(e => setError(String(e)))
      }}><Icon id="lucide:arrow-up-right" size={12} />Open in browser</button>
    </footer>
  </div>
}
