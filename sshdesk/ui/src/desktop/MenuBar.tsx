import { useEffect, useState } from 'react'
import { fw } from '../fw'
import { useContextMenu, type MenuItem } from '../wm/ContextMenu'
import { useWM } from '../wm/store'
import { APPS } from './registry'
import { Icon } from '../wm/Icon'
import { workArea } from '../wm/workArea'
import { useKeyboardPreferences } from '../keyboard/preferences'
import { formatShortcut, type ActionId } from '../keyboard/shortcuts'

export function MenuBar({ hosts, active, onSwitch, onAdd, onDisconnect, onReloadPlugins }: {
  hosts: string[]
  active: string
  onSwitch: (target: string) => void
  onAdd: () => void
  onDisconnect: (target: string) => void
  onReloadPlugins?: () => Promise<string[]>
}) {
  const menu = useContextMenu()
  const { state, dispatch } = useWM()
  const { bindings } = useKeyboardPreferences()
  const wins = state.wins.filter(w => w.host === active)
  const front = wins.filter(w => !w.minimized).sort((a, b) => b.z - a.z)[0]
  const application = APPS.find(app => app.id === front?.appId)
  const [skew, setSkew] = useState<{ target: string; deltaMs: number; offsetMin: number; zone: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const host = active.split('@').at(-1)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault()
        void onReloadPlugins?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onReloadPlugins])

  // Show the focused machine's time. Once synchronized, ticks are local;
  // switching machines never briefly displays the previous machine's clock.
  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const t = await fw.for(active).sys.clock()
        if (alive) setSkew({ target: active, deltaMs: t.epoch * 1000 - Date.now(), offsetMin: t.offset_minutes, zone: t.zone })
      } catch { /* A later sync can recover without interrupting the desktop. */ }
    }
    void sync()
    const resync = setInterval(sync, 5 * 60 * 1000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; clearInterval(resync); clearInterval(tick) }
  }, [active])

  let time = '', date = ''
  const clock = skew?.target === active ? skew : null
  if (clock) {
    const d = new Date(now + clock.deltaMs + clock.offsetMin * 60_000)
    time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  }
  const windowMenu: MenuItem[] = [
    { label: 'New window', icon: '+', disabled: !front,
      onSelect: () => { if (front) fw.ui.open(front.appId, { host: active }) } },
    ...([
      ['Snap left', 'snap-left', 'left'], ['Snap right', 'snap-right', 'right'],
      ['Maximize', 'maximize', 'maximized'], ['Restore size', 'restore', 'restore'],
    ] as const).map(([label, action, layout]) => ({ label, disabled: !front || (layout === 'restore' && !front.restore),
      shortcut: bindings[action as ActionId] ? formatShortcut(bindings[action as ActionId]) : undefined,
      onSelect: () => {
        const pane = front && document.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(front.id)}"]`)?.parentElement
        if (front && pane) dispatch({ t: 'layout', id: front.id, layout, ...workArea(pane) })
      } })),
    { type: 'separator' },
    { label: 'Minimize window', icon: '−', disabled: !front,
      onSelect: () => { if (front) dispatch({ t: 'minimize', id: front.id }) } },
    { label: 'Show desktop', icon: '▱', disabled: !wins.some(w => !w.minimized),
      onSelect: () => wins.forEach(w => dispatch({ t: 'minimize', id: w.id })) },
    ...(wins.length ? [{ type: 'separator' as const }, ...wins.map(w => ({
      label: w.title, icon: w.id === front?.id ? '✓' : w.minimized ? '−' : '',
      onSelect: () => dispatch({ t: 'focus', id: w.id }),
    }))] : []),
  ]

  return (
    <header data-tauri-drag-region className="desktop-menubar">
      <button className="menubar-brand" aria-haspopup="menu"
        onClick={ev => menu.open(ev, [
          { label: 'Connect to another machine…', icon: '+', onSelect: onAdd },
          { label: 'Settings…', onSelect: () => fw.ui.open('settings', { host: active }) },
          { type: 'separator' },
          { label: 'Reload plugins', icon: '⟳', shortcut: '⌘R', onSelect: () => { void onReloadPlugins?.() } },
          { type: 'separator' },
          { label: `Disconnect from ${host}`, onSelect: () => onDisconnect(active) },
          { label: 'Quit sshdesk', danger: true, onSelect: () => { void fw.win.close() } },
        ])}>sshdesk</button>
      <button className="menubar-item" aria-haspopup="menu"
        onClick={ev => menu.open(ev, APPS.filter(app => !app.hidden).map(app => ({
          label: app.title, onSelect: () => fw.ui.open(app.id, { host: active }),
        })))}>Applications</button>
      <button className="menubar-item" aria-haspopup="menu" onClick={ev => menu.open(ev, windowMenu)}>Window</button>
      <span className="menubar-divider" />
      <div className="menubar-hosts" aria-label="Connected machines">
        {hosts.map(h => {
          const addr = h.split('@').at(-1)
          const name = fw.conns.list().find(c => `${c.user}@${c.host}` === h)?.name
          const options: MenuItem[] = [
            { label: h, disabled: true, onSelect: () => {} },
            { type: 'separator' },
            { label: 'Open Files', onSelect: () => fw.ui.open('files', { host: h }) },
            { label: 'Open Terminal', onSelect: () => fw.ui.open('terminal', { host: h }) },
            { type: 'separator' },
            { label: 'Disconnect', onSelect: () => onDisconnect(h) },
          ]
          return <button key={h} className="menubar-host" aria-pressed={h === active}
            aria-haspopup="menu" title={`${h} — machine options`}
            onClick={ev => h === active ? menu.open(ev, options) : onSwitch(h)}
            onContextMenu={ev => menu.open(ev, options)}>
            <span className="status-dot" /><span>{name || addr}</span>
            <Icon id="lucide:chevron-down" size={10} />
          </button>
        })}
      </div>
      <button className="menubar-item" aria-label="Connect another machine" title="Connect another machine" onClick={onAdd}>
        <Icon id="lucide:plus" size={14} />
      </button>
      <div className="menubar-tray">
        <span className="menubar-connected">{application?.title || 'Desktop'}</span>
        <span className="menubar-clock" title={`Time on ${active}`}>
          {clock ? <><span>{date}</span><strong className="font-medium">{time}</strong><small>{clock.zone}</small></>
            : <small>Syncing clock…</small>}
        </span>
      </div>
    </header>
  )
}
