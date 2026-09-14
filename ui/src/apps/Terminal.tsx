import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from 'react'
import { useFw } from '../wm/host'
import { useWM } from '../wm/store'
import { Icon } from '../wm/Icon'
import { useDialog } from '../wm/Dialog'
import { useContextMenu } from '../wm/ContextMenu'
import { closesOnExit, type Shortcut } from '../shortcuts/model'
import { TerminalPane, type PaneController, type PaneInfo } from './terminal/TerminalPane'
import { folderName, initialWorkspace, layoutRects, paneIds, parsePins, workspaceReducer, type Axis, type Divider, type Pin, type Rect } from './terminal/model'
import { terminalKey } from './terminal/shortcuts'
import './terminal/terminal.css'

type Props = { setTitle?: (title: string) => void; shortcut?: Extract<Shortcut, { kind: 'tui' }>; winId?: string; cwd?: string }
const uid = () => crypto.randomUUID()
const rectStyle = (r: Rect): CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` })
const statusLabel = (info?: PaneInfo) => info?.status === 'running' ? 'SSH session' : info?.status === 'closed' ? info.message || 'Session ended' : info?.status === 'error' ? 'Couldn’t start session' : 'Connecting…'

export function Terminal(props: Props) {
  return props.shortcut ? <CommandTerminal {...props} shortcut={props.shortcut} /> : <TerminalWorkspace {...props} />
}

function TerminalWorkspace({ setTitle, winId, cwd }: Props) {
  const fw = useFw(), target = fw.host.current(), dlg = useDialog(), menu = useContextMenu()
  const { state: windows, dispatch: windowDispatch } = useWM()
  const [workspace, dispatch] = useReducer(workspaceReducer, cwd, path => initialWorkspace(uid(), { id: uid(), cwd: path }))
  const [infos, setInfos] = useState<Record<string, PaneInfo>>({})
  const controllers = useRef(new Map<string, PaneController>())
  const [pins, setPins] = useState(() => parsePins(fw.prefs.hostGet('terminal.pins', [])))
  const [sidebar, setSidebar] = useState(() => fw.prefs.hostGet('terminal.sidebar', true))
  const [fontSize, setFontSize] = useState(() => Math.max(10, Math.min(28, Number(fw.prefs.get('terminal.fontSize', 13)) || 13)))
  const [home, setHome] = useState(''), [zoomed, setZoomed] = useState<string | null>(null), [error, setError] = useState('')
  const [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(''), [matchCase, setMatchCase] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const current = workspace.tabs.find(t => t.id === workspace.activeTab)
  const activeId = current?.activePane || '', info = infos[activeId], activePath = info?.cwd
  const nameOf = (id: string) => { const path = infos[id]?.cwd || workspace.panes[id]?.cwd; return path === home ? 'Home' : folderName(path) }
  const own = windows.wins.find(w => w.id === winId)
  const front = [...windows.wins].filter(w => w.host === target && !w.minimized).sort((a, b) => b.z - a.z)[0]?.id
  const windowFocused = !winId || front === winId
  const currentRef = useRef({ workspace, activeId, activePath })
  useLayoutEffect(() => { currentRef.current = { workspace, activeId, activePath } })

  const onInfo = useCallback((id: string, patch: Partial<PaneInfo>) => setInfos(previous => {
    if (Object.entries(patch).every(([key, value]) => previous[id]?.[key as keyof PaneInfo] === value)) return previous
    return { ...previous, [id]: { ...previous[id], ...patch } }
  }), [])
  const onController = useCallback((id: string, controller?: PaneController) => {
    if (controller) controllers.current.set(id, controller); else controllers.current.delete(id)
  }, [])
  const onFocus = useCallback((id: string) => {
    const tab = currentRef.current.workspace.tabs.find(t => paneIds(t.layout).includes(id))
    if (tab && (tab.id !== currentRef.current.workspace.activeTab || tab.activePane !== id)) dispatch({ type: 'focus', tab: tab.id, pane: id })
  }, [])
  useEffect(() => {
    let live = true
    void fw.fs.list('~').then(listing => { if (live) setHome(listing.path) }).catch(() => {})
    const off = fw.bus.on('terminal:pins', (value: { host?: string }) => {
      if (value.host === target) setPins(parsePins(fw.prefs.hostGet('terminal.pins', [])))
    })
    return () => { live = false; off() }
  }, [fw, target])
  useEffect(() => { fw.prefs.set('terminal.fontSize', fontSize) }, [fw, fontSize])
  useEffect(() => { fw.prefs.hostSet('terminal.sidebar', sidebar) }, [fw, sidebar])
  useEffect(() => {
    setInfos(previous => Object.keys(previous).some(id => !workspace.panes[id])
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => workspace.panes[id])) : previous)
    if (zoomed && !workspace.panes[zoomed]) setZoomed(null)
  }, [workspace.panes, zoomed])
  useEffect(() => { setTitle?.(`Terminal — ${current?.name || activePath || target}`) }, [setTitle, current?.name, activePath, target])
  useEffect(() => {
    if (searchOpen && query) controllers.current.get(activeId)?.search(query, false, matchCase)
    else if (searchOpen) controllers.current.get(activeId)?.clearSearch()
  }, [activeId, searchOpen, query, matchCase])

  const savePins = (next: Pin[]) => { fw.prefs.hostSet('terminal.pins', next); setPins(next); fw.bus.emit('terminal:pins', { host: target }) }
  const pinCurrent = async () => {
    const path = await controllers.current.get(activeId)?.directory()
    if (!path) { setError('The active shell’s directory is not available yet.'); return }
    const saved = parsePins(fw.prefs.hostGet('terminal.pins', []))
    savePins(saved.some(p => p.path === path) ? saved.filter(p => p.path !== path) : [...saved, { path, label: folderName(path) }])
    setError('')
  }
  const addPin = async () => {
    const entered = await dlg.prompt({ title: 'Pin a directory', label: 'Directory on this machine', placeholder: '~/projects', okLabel: 'Pin directory' })
    if (!entered) return
    try {
      const listing = await fw.fs.list(entered), saved = parsePins(fw.prefs.hostGet('terminal.pins', []))
      if (!saved.some(p => p.path === listing.path)) savePins([...saved, { path: listing.path, label: folderName(listing.path) }])
      setError('')
    } catch (e) { setError(String(e)) }
  }
  const openFiles = async () => {
    const path = await controllers.current.get(activeId)?.directory()
    if (path) { setError(''); fw.ui.open('files', { path, host: target }) }
    else setError('The active shell’s directory is not available yet.')
  }
  const openTab = async (path?: string, inherit = true) => {
    const source = currentRef.current.activeId
    const directory = path ?? (inherit ? await controllers.current.get(source)?.directory() || currentRef.current.activePath : undefined)
    setZoomed(null); setError('')
    dispatch({ type: 'tab', id: uid(), pane: { id: uid(), cwd: directory } })
  }
  const split = async (axis: Axis) => {
    const snapshot = currentRef.current, tab = snapshot.workspace.tabs.find(t => t.id === snapshot.workspace.activeTab)
    if (!tab) return
    const directory = await controllers.current.get(tab.activePane)?.directory() || snapshot.activePath
    setZoomed(null); dispatch({ type: 'split', tab: tab.id, pane: { id: uid(), cwd: directory }, splitId: uid(), axis })
  }
  const closeTab = (id: string) => {
    if (workspace.tabs.length === 1 && winId) windowDispatch({ t: 'close', id: winId })
    else { dispatch({ type: 'close-tab', tab: id }); setZoomed(null) }
  }
  const closePane = (tabId: string, paneId: string) => {
    const tab = workspace.tabs.find(t => t.id === tabId)
    if (tab && paneIds(tab.layout).length === 1) closeTab(tabId)
    else dispatch({ type: 'close-pane', tab: tabId, pane: paneId })
  }
  const renameTab = async (id: string) => {
    const tab = workspace.tabs.find(t => t.id === id)
    if (!tab) return
    const name = await dlg.prompt({ title: 'Rename tab', label: 'Leave blank to follow the directory', value: tab.name || '', placeholder: nameOf(tab.activePane), okLabel: 'Rename', allowEmpty: true })
    if (name !== null) dispatch({ type: 'rename', tab: id, name })
  }
  const expandPane = (id: string | null) => {
    if (id) onFocus(id)
    setZoomed(id)
    requestAnimationFrame(() => controllers.current.get(id || currentRef.current.activeId)?.focus())
  }
  const closeSearch = () => { setSearchOpen(false); controllers.current.get(activeId)?.clearSearch(); controllers.current.get(activeId)?.focus() }
  const actionRef = useRef<(action: string) => void>(() => {})
  actionRef.current = action => {
    if (action === 'new-tab') void openTab()
    else if (action === 'split') void split('row')
    else if (action === 'close-pane' && current) closePane(current.id, activeId)
    else if (action === 'close-tab' && current) closeTab(current.id)
    else if (action === 'search') { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()) }
    else if (action === 'clear') controllers.current.get(activeId)?.clear()
    else if (action === 'zoom-in') setFontSize(size => Math.min(28, size + 1))
    else if (action === 'zoom-out') setFontSize(size => Math.max(10, size - 1))
    else if (action === 'zoom-reset') setFontSize(13)
    else if (action === 'next-tab' || action === 'previous-tab') {
      const next = (workspace.tabs.findIndex(t => t.id === workspace.activeTab) + workspace.tabs.length + (action === 'next-tab' ? 1 : -1)) % workspace.tabs.length
      if (workspace.tabs[next]) { setZoomed(null); dispatch({ type: 'focus', tab: workspace.tabs[next].id }) }
    }
  }
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ winId: string; action: string }>).detail
      if (detail.winId === winId) actionRef.current(detail.action)
    }
    window.addEventListener('terminal-action', handler)
    return () => window.removeEventListener('terminal-action', handler)
  }, [winId])

  const pinActive = pins.some(p => p.path === activePath)
  return <div className="desk-app terminal-workspace" onKeyDownCapture={event => {
    const action = terminalKey(event.nativeEvent)
    if (!action || event.defaultPrevented) return
    event.preventDefault(); event.stopPropagation(); if (!event.repeat) actionRef.current(action)
  }}>
    <div className="terminal-toolbar" role="toolbar" aria-label="Terminal tools">
      <button className="terminal-tool" aria-label="Toggle pinned directories" title="Pinned directories" aria-expanded={sidebar} onClick={() => setSidebar(value => !value)}><Icon id="lucide:panel-left" size={16} /></button>
      <div className="terminal-location" title={activePath || 'Waiting for the shell directory'}><Icon id="lucide:folder-open" size={15} /><span>{activePath || 'Opening shell…'}</span></div>
      <button className="terminal-tool" disabled={!activePath || info?.status !== 'running'} aria-label={pinActive ? 'Unpin current directory' : 'Pin current directory'} title={pinActive ? 'Unpin current directory' : 'Pin current directory'} aria-pressed={pinActive} onClick={() => void pinCurrent()}><Icon id="lucide:pin" size={15} /></button>
      <span className="terminal-toolbar-divider" />
      <button className="terminal-tool terminal-files-button" disabled={!activePath || info?.status !== 'running'} onClick={() => void openFiles()} title="Open active directory in Files"><Icon id="lucide:folder-symlink" size={16} /><span>Open in Files</span></button>
      <button className="terminal-tool" aria-label="Split right" title="Split right (⇧⌘T)" onClick={() => void split('row')}><Icon id="lucide:columns-2" size={16} /></button>
      <button className="terminal-tool" aria-label="Split below" title="Split below" onClick={() => void split('column')}><Icon id="lucide:rows-2" size={16} /></button>
      <button className="terminal-tool" aria-label="Find in terminal" title="Find in terminal (⌘F)" aria-pressed={searchOpen} onClick={() => actionRef.current('search')}><Icon id="lucide:search" size={16} /></button>
      <button className="terminal-tool" aria-label="More terminal actions" title="More actions" onClick={event => menu.open(event, [
        { label: 'New tab', shortcut: '⌘T', onSelect: () => void openTab() },
        { label: 'Rename tab', onSelect: () => current && void renameTab(current.id) },
        { type: 'separator' },
        { label: 'Clear scrollback', shortcut: '⌘K', onSelect: () => controllers.current.get(activeId)?.clear() },
        { label: 'Increase text size', shortcut: '⌘+', onSelect: () => actionRef.current('zoom-in') },
        { label: 'Decrease text size', shortcut: '⌘−', onSelect: () => actionRef.current('zoom-out') },
        { label: 'Reset text size', shortcut: '⌘0', onSelect: () => actionRef.current('zoom-reset') },
      ])}><Icon id="lucide:ellipsis" size={17} /></button>
    </div>
    {error && <div className="terminal-notice" role="alert"><span>{error}</span><button aria-label="Dismiss terminal error" onClick={() => setError('')}><Icon id="lucide:x" size={14} /></button></div>}
    <div className="terminal-body">
      {sidebar && <aside className="terminal-sidebar" aria-label="Pinned directories">
        <div className="terminal-sidebar-heading">Places</div>
        <button className="terminal-place" onClick={() => void openTab(undefined, false)} title="Open Home in a new tab"><Icon id="lucide:house" size={15} /><span>Home</span></button>
        <button className="terminal-place" onClick={() => void openTab('/', false)} title="Open File system in a new tab"><Icon id="lucide:hard-drive" size={15} /><span>File system</span></button>
        <div className="terminal-sidebar-heading terminal-pins-heading"><span>Pinned directories</span><button className="terminal-tool" aria-label="Add pinned directory" title="Pin a directory by path" onClick={() => void addPin()}><Icon id="lucide:plus" size={13} /></button></div>
        <div className="terminal-pin-list">
          {pins.map(pin => <button key={pin.path} className={`terminal-place ${pin.path === activePath ? 'is-current' : ''}`} onClick={() => void openTab(pin.path, false)}
            title={`${pin.path} — open in a new tab`} onContextMenu={event => menu.open(event, [
              { label: 'Open in new tab', onSelect: () => void openTab(pin.path, false) },
              { label: 'Open in Files', onSelect: () => fw.ui.open('files', { path: pin.path, host: target }) },
              { type: 'separator' },
              { label: 'Rename pin', onSelect: async () => { const name = await dlg.prompt({ title: 'Rename pin', value: pin.label, okLabel: 'Rename' });
                if (name?.trim()) savePins(parsePins(fw.prefs.hostGet('terminal.pins', [])).map(p => p.path === pin.path ? { ...p, label: name.trim() } : p)) } },
              { label: 'Unpin directory', onSelect: () => savePins(parsePins(fw.prefs.hostGet('terminal.pins', [])).filter(p => p.path !== pin.path)) },
            ])}><Icon id="lucide:folder" size={15} /><span>{pin.label}</span></button>)}
          {!pins.length && <p className="terminal-pins-empty">Keep project folders close.<br />Pin the current directory above, or add a path.</p>}
        </div>
        <div className="terminal-sidebar-host" title={target}><Icon id="lucide:server" size={14} /><span>{target}</span></div>
      </aside>}
      <div className="terminal-main">
        <div className="terminal-tabs-row">
          <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
            {workspace.tabs.map(tab => {
              const ids = paneIds(tab.layout), selected = tab.id === workspace.activeTab, label = tab.name || nameOf(tab.activePane)
              return <div key={tab.id} className={`terminal-tab ${selected ? 'is-active' : ''}`}>
                <button role="tab" id={`tab-${tab.id}`} aria-selected={selected} aria-controls={`panel-${tab.id}`} tabIndex={selected ? 0 : -1}
                  title={infos[tab.activePane]?.cwd || label} onClick={() => { setZoomed(null); dispatch({ type: 'focus', tab: tab.id }) }}
                  onDoubleClick={() => void renameTab(tab.id)} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault(); actionRef.current(event.key === 'ArrowRight' ? 'next-tab' : 'previous-tab') } }}
                  onContextMenu={event => menu.open(event, [ { label: 'Rename tab', onSelect: () => void renameTab(tab.id) },
                    { label: 'Close tab', shortcut: '⇧⌘W', onSelect: () => closeTab(tab.id) } ])}>
                  <Icon id="lucide:terminal" size={13} /><span>{label}</span>{ids.length > 1 && <small>{ids.length}</small>}
                  {!selected && ids.some(id => infos[id]?.unread) && <i className="terminal-activity" aria-label="New output" />}
                </button><button className="terminal-tab-close" aria-label={`Close tab ${label}`} title="Close tab" onClick={() => closeTab(tab.id)}><Icon id="lucide:x" size={12} /></button>
              </div>
            })}
          </div><button className="terminal-tool terminal-new-tab" aria-label="New terminal tab" title="New tab (⌘T)" onClick={() => void openTab()}><Icon id="lucide:plus" size={16} /></button>
        </div>
        {searchOpen && <div className="terminal-find" role="search" aria-label="Find in active terminal">
          <Icon id="lucide:search" size={14} /><input ref={searchInput} value={query} aria-label="Find in terminal output" placeholder="Find in this pane…" autoFocus
            onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch() }
              if (event.key === 'Enter') { event.preventDefault(); controllers.current.get(activeId)?.search(query, event.shiftKey, matchCase) }
            }} />
          <span className="terminal-find-results" role="status">{query && (info?.resultCount ? `${(info.resultIndex ?? -1) + 1} of ${info.resultCount}` : 'No matches')}</span>
          <button className="terminal-tool" aria-label="Match case" title="Match case" aria-pressed={matchCase} onClick={() => setMatchCase(value => !value)}>Aa</button>
          <button className="terminal-tool" aria-label="Previous match" title="Previous match (⇧Enter)" onClick={() => controllers.current.get(activeId)?.search(query, true, matchCase)}><Icon id="lucide:chevron-up" size={14} /></button>
          <button className="terminal-tool" aria-label="Next match" title="Next match (Enter)" onClick={() => controllers.current.get(activeId)?.search(query, false, matchCase)}><Icon id="lucide:chevron-down" size={14} /></button>
          <button className="terminal-tool" aria-label="Close terminal search" title="Close search (Esc)" onClick={closeSearch}><Icon id="lucide:x" size={14} /></button>
        </div>}
        <div className="terminal-tab-panels">
          {workspace.tabs.map(tab => {
            const geometry = layoutRects(tab.layout), ids = paneIds(tab.layout), selected = tab.id === workspace.activeTab
            return <div key={tab.id} id={`panel-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} className="terminal-pane-layout" hidden={!selected}>
              {ids.map(id => {
                const paneInfo = infos[id], expanded = zoomed === id, visible = selected && (!zoomed || expanded) && !own?.minimized
                return <section key={id} className={`terminal-pane-frame ${id === tab.activePane ? 'is-active' : ''}`} aria-label={`Terminal pane ${nameOf(id)}`}
                  style={{ ...rectStyle(expanded ? { x: 0, y: 0, w: 1, h: 1 } : geometry.panes[id]), display: zoomed && !expanded ? 'none' : undefined }}
                  onPointerDown={() => onFocus(id)}>
                  {ids.length > 1 && <div className="terminal-pane-heading"><span title={paneInfo?.cwd || paneInfo?.title}>{nameOf(id)}</span>
                    <button className="terminal-tool" aria-label={expanded ? 'Restore split panes' : `Expand pane ${nameOf(id)}`} title={expanded ? 'Restore split panes' : 'Expand this pane'} onClick={() => expandPane(expanded ? null : id)}><Icon id={expanded ? 'lucide:minimize-2' : 'lucide:maximize-2'} size={12} /></button>
                    <button className="terminal-tool" aria-label={`Close pane ${nameOf(id)}`} title="Close pane (⌘W)" onClick={() => closePane(tab.id, id)}><Icon id="lucide:x" size={12} /></button></div>}
                  <TerminalPane pane={workspace.panes[id]} visible={visible} focused={visible && id === tab.activePane && windowFocused} fontSize={fontSize}
                    onInfo={onInfo} onController={onController} onFocus={onFocus} />
                  {(paneInfo?.status === 'closed' || paneInfo?.status === 'error') && <div className="terminal-ended"><span>{statusLabel(paneInfo)}</span><button className="app-button" onClick={() => controllers.current.get(id)?.restart()}><Icon id="lucide:rotate-cw" size={12} />Restart session</button></div>}
                </section>
              })}
              {!zoomed && geometry.dividers.map(divider => <SplitDivider key={divider.id} divider={divider} onResize={ratio => dispatch({ type: 'resize', tab: tab.id, split: divider.id, ratio })} />)}
            </div>
          })}
          {!workspace.tabs.length && <div className="app-empty-state"><Icon id="lucide:terminal" size={28} /><p>No open sessions</p><button className="app-button" onClick={() => void openTab(undefined, false)}>New tab</button></div>}
        </div>
      </div>
    </div>
    <footer className="app-statusbar terminal-statusbar"><span className={`terminal-session-dot ${info?.status === 'running' ? 'is-running' : ''}`} /><span>{statusLabel(info)}</span>
      <span className="terminal-status-summary">{workspace.tabs.length} {workspace.tabs.length === 1 ? 'tab' : 'tabs'} · {Object.keys(workspace.panes).length} {Object.keys(workspace.panes).length === 1 ? 'pane' : 'panes'}</span>
      {zoomed && <button onClick={() => expandPane(null)}>Show all panes</button>}
      <span className="app-status-end">{fontSize !== 13 && <span>{fontSize}px · </span>}{info?.cols && info?.rows ? `${info.cols} × ${info.rows}` : ''}</span>
    </footer>
  </div>
}

function SplitDivider({ divider, onResize }: { divider: Divider; onResize: (ratio: number) => void }) {
  const origin = useRef<DOMRect | null>(null), { axis, rect, ratio } = divider
  const style: CSSProperties = axis === 'row'
    ? { left: `${(rect.x + rect.w * ratio) * 100}%`, top: `${rect.y * 100}%`, height: `${rect.h * 100}%` }
    : { top: `${(rect.y + rect.h * ratio) * 100}%`, left: `${rect.x * 100}%`, width: `${rect.w * 100}%` }
  return <div className={`terminal-divider is-${axis}`} style={style} role="separator" tabIndex={0} aria-label="Resize terminal panes"
    aria-orientation={axis === 'row' ? 'vertical' : 'horizontal'} aria-valuemin={12} aria-valuemax={88} aria-valuenow={Math.round(ratio * 100)}
    onDoubleClick={() => onResize(.5)} onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
      origin.current = event.currentTarget.parentElement!.getBoundingClientRect()
      event.currentTarget.classList.add('is-dragging')
    }} onPointerMove={event => {
      const bounds = origin.current
      if (!bounds || !event.currentTarget.hasPointerCapture(event.pointerId)) return
      onResize(axis === 'row' ? ((event.clientX - bounds.left) / bounds.width - rect.x) / rect.w : ((event.clientY - bounds.top) / bounds.height - rect.y) / rect.h)
    }} onLostPointerCapture={event => { origin.current = null; event.currentTarget.classList.remove('is-dragging') }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onKeyDown={event => { const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? .04 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.04 : 0
      if (step) { event.preventDefault(); onResize(ratio + step) } }} />
}

function CommandTerminal({ shortcut, setTitle, winId }: Props & { shortcut: Extract<Shortcut, { kind: 'tui' }> }) {
  const { dispatch } = useWM(), fw = useFw(), pane = useRef({ id: uid() }).current
  const [info, setInfo] = useState<PaneInfo>({ status: 'opening' }), controller = useRef<PaneController | undefined>(undefined)
  const onInfo = useCallback((_id: string, patch: Partial<PaneInfo>) => setInfo(value => ({ ...value, ...patch })), [])
  const onController = useCallback((_id: string, value?: PaneController) => { controller.current = value }, [])
  const onFocus = useCallback(() => {}, [])
  useEffect(() => setTitle?.(shortcut.name), [setTitle, shortcut.name])
  return <div className="desk-app terminal-command"><TerminalPane pane={pane} visible focused fontSize={13} shortcut={shortcut}
    onInfo={onInfo} onController={onController} onFocus={onFocus} onExit={code => { if (closesOnExit(code) && winId) dispatch({ t: 'close', id: winId }) }} />
    <footer className="app-statusbar"><span>{info.message || statusLabel(info)}</span>
      {(info.status === 'closed' || info.status === 'error') && <button className="app-button" onClick={() => controller.current?.restart()}>Run again</button>}
      <span className="app-status-end">{fw.host.current()}</span></footer></div>
}
