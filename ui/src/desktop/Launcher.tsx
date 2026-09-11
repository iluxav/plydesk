import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fw, type IndexStatus } from '../fw'
import { APPS, handlerFor } from './registry'
import { Icon } from '../wm/Icon'
import { useModalFocus } from '../wm/useModalFocus'
import { actionFor, matchApps, mergeResults, parentOf, step, type LauncherItem } from './launcherModel'
import './launcher.css'
import { availableOn, shortcutKind } from '../shortcuts/model'
import { editShortcut, onShortcutsChanged } from '../shortcuts/store'

const ROWS = 12

/**
 * Search apps and files on the focused machine.
 *
 * A core overlay rather than an app: it needs the registry, the pane model,
 * and a place above every window, none of which crosses the app sandbox.
 * `aria-modal` also makes the desktop hide native app views beneath it.
 */
export function Launcher({ host, open, onClose }: { host: string; open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<LauncherItem[]>([])
  const [index, setIndex] = useState(0)
  const [revision, setRevision] = useState(0)
  useEffect(() => onShortcutsChanged(() => setRevision(n => n + 1)), [])
  const [status, setStatus] = useState<IndexStatus | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const request = useRef(0)
  useModalFocus(panel, open)

  // Results follow the query. Apps are known locally; files come from the
  // native index, which answers in milliseconds, so there is no debounce.
  useEffect(() => {
    if (!open) return
    const apps = matchApps(APPS.filter(a => availableOn(a.shortcut, host)), query)
    const q = query.trim()
    if (!q) { setItems(mergeResults(apps, [], ROWS)); setIndex(0); return }
    const id = ++request.current
    let live = true
    void fw.for(host).search.query(q, ROWS).then(hits => {
      if (!live || id !== request.current) return
      setItems(mergeResults(apps, hits, ROWS)); setIndex(0)
    }).catch(() => { if (live && id === request.current) { setItems(mergeResults(apps, [], ROWS)); setIndex(0) } })
    return () => { live = false }
  }, [open, query, host, revision])

  // The index is built on connect; a machine connected before that, or one
  // whose walk failed, gets another attempt when the bar opens.
  useEffect(() => {
    if (!open) return
    let live = true
    const api = fw.for(host)
    const poll = () => api.search.status().then(s => { if (live) setStatus(s) }).catch(() => {})
    void api.search.status().then(s => {
      if (!live) return
      setStatus(s)
      if (!s.building && s.ageSecs === null) void api.search.build().then(next => { if (live) setStatus(next) }).catch(() => {})
    }).catch(() => {})
    const timer = setInterval(() => { void poll() }, 1000)
    return () => { live = false; clearInterval(timer); setQuery(''); setIndex(0) }
  }, [open, host])

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`#launcher-${index}`)?.scrollIntoView({ block: 'nearest' })
  }, [index, items])

  const activate = useCallback((item: LauncherItem | undefined, reveal: boolean) => {
    if (!item) return
    const action = actionFor(item, reveal, handlerFor)
    onClose()
    fw.ui.open(action.appId, { ...action.props, host })
  }, [host, onClose])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); setIndex(i => step(i, 1, items.length)) }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); setIndex(i => step(i, -1, items.length)) }
    else if (e.key === 'Enter') { e.preventDefault(); activate(items[index], e.metaKey) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  if (!open) return null
  const machine = host.replace(/^.*@/, '')
  const selected = items[index]
  return <div className="launcher-scrim" onPointerDown={onClose}>
    <div ref={panel} className="launcher" role="dialog" aria-modal="true" aria-label="Search apps and files"
      onPointerDown={e => e.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="launcher-input">
        <Icon id="lucide:search" size={18} />
        <input data-autofocus value={query} placeholder={`Search apps and files on ${machine}`} spellCheck={false} autoComplete="off"
          aria-controls="launcher-results" aria-activedescendant={selected ? `launcher-${index}` : undefined}
          onChange={e => setQuery(e.target.value)} />
        <kbd>esc</kbd>
      </div>
      <ul ref={list} id="launcher-results" className="launcher-results" role="listbox" aria-label="Results">
        {items.map((item, i) => <li key={item.kind === 'app' ? `app:${item.id}` : item.path} id={`launcher-${i}`} role="option" aria-selected={i === index}
          onPointerMove={() => { if (i !== index) setIndex(i) }} onClick={e => activate(item, e.metaKey)}>
          {item.kind === 'app'
            ? <><span className={`app-tile app-tile-${item.id} launcher-tile`}><Icon token={`${item.id}.app`} host={host} fallback={item.icon} size={20} /></span>
              <span className="launcher-text"><strong>{item.title}</strong><small>{APPS.find(a => a.id === item.id)?.shortcut ? shortcutKind(APPS.find(a => a.id === item.id)!.shortcut!) : 'Application'}</small></span></>
            : <><span className="launcher-tile launcher-file"><Icon token={item.dir ? 'files.directory' : 'files.file'} host={host} size={20} /></span>
              <span className="launcher-text"><strong>{item.name}</strong><small title={item.path}>{parentOf(item.path)}</small></span></>}
          {i === index && <span className="launcher-hint">{item.kind === 'app' ? '↩ Open' : '↩ Open · ⌘↩ Reveal'}</span>}
        </li>)}
        {!items.length && query.trim() && <li className="launcher-empty">Nothing on {machine} matches “{query.trim()}”</li>}
      </ul>
      <footer className="launcher-status" role="status">
        {status?.building ? <><span className="ui-spinner" />Indexing the home folder…</>
          : status?.count ? `${status.count.toLocaleString()} names in your home folder${status.truncated ? ' (first 200,000)' : ''}`
          : status?.error ? `File search is unavailable on ${machine}: ${status.error}`
          : 'File search starts once the home folder is indexed'}
        <button className="settings-button shortcut-footer-button" onClick={() => { onClose(); editShortcut() }}><Icon id="lucide:plus" size={13} />Create app</button>
      </footer>
    </div>
  </div>
}
