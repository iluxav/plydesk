import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../wm/Icon'
import { APPS } from './registry'
import { useWM } from '../wm/store'
import { useContextMenu, type MenuItem } from '../wm/ContextMenu'
import { fw } from '../fw'
import { availableOn } from '../shortcuts/model'
import { editShortcut } from '../shortcuts/store'

export function Dock({ host }: { host: string }) {
  const [shown, setShown] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const { state, dispatch } = useWM()
  const menu = useContextMenu()
  const mine = state.wins.filter(w => w.host === host)
  const front = mine.filter(w => !w.minimized).sort((a, b) => b.z - a.z)[0]
  // Keep apps discoverable; only tuck the dock away when a maximized window
  // actually needs its space. Focusing the dock reveals it for keyboard users.
  const open = !front?.maximized || shown

  const reveal = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setShown(true)
  }, [])
  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setShown(false), 400)
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent) => { if (window.innerHeight - e.clientY <= 18) reveal() }
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [reveal])

  const launch = (appId: string) => fw.ui.open(appId, { host })
  const activate = (appId: string, newWindow: boolean) => {
    const existing = mine.filter(w => w.appId === appId).sort((a, b) => b.z - a.z)[0]
    if (existing && !newWindow) dispatch({ t: 'focus', id: existing.id })
    else launch(appId)
  }
  const dockMenu = (appId: string): MenuItem[] => {
    const wins = mine.filter(w => w.appId === appId)
    return [
      { label: 'New window', icon: '+', onSelect: () => launch(appId) },
      ...(APPS.find(a => a.id === appId)?.shortcut ? [{ label: 'Edit shortcut…', onSelect: () => editShortcut(appId) }] : []),
      ...(wins.length ? [
        { type: 'separator' as const },
        ...wins.map(w => ({
          label: w.title.replace(/^Files — /, ''), icon: w.minimized ? '−' : '•',
          onSelect: () => dispatch({ t: 'focus', id: w.id }),
        })),
      ] : []),
    ]
  }
  const apps = APPS.filter(app => availableOn(app.shortcut, host) && (!app.hidden || mine.some(w => w.appId === app.id)))

  return <>
    {!open && <div className="dock-reveal" onPointerEnter={reveal} />}
    <nav aria-label="Applications" className={`desktop-dock ${open ? 'is-open' : ''}`}
      onPointerEnter={reveal} onPointerLeave={hide} onFocus={reveal}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) hide() }}>
      <div className="dock-shelf">
        {apps.map(app => {
          const wins = mine.filter(w => w.appId === app.id)
          return <button key={app.id} className={`dock-app ${front?.appId === app.id ? 'is-active' : ''}`}
            aria-label={app.title} title={`${app.title} · Shift-click for a new window`}
            onClick={e => activate(app.id, e.shiftKey)}
            onContextMenu={e => menu.open(e, dockMenu(app.id))}>
            <span className={`app-tile app-tile-${app.id}`}><Icon token={`${app.id}.app`} host={host} fallback={app.icon} size={26} /></span>
            <span className="dock-tooltip">{app.title}{wins.length > 1 ? ` · ${wins.length} windows` : ''}</span>
            <span className={`dock-indicator ${wins.length ? 'is-running' : ''}`} />
          </button>
        })}
        {mine.some(w => w.minimized) && <div className="dock-separator" />}
        {mine.filter(w => w.minimized).map(w => <button key={w.id} className="dock-minimized"
          onClick={() => dispatch({ t: 'focus', id: w.id })} aria-label={`Restore ${w.title}`} title={`Restore ${w.title}`}>
          <Icon token={`${w.appId}.app`} host={host} fallback={w.icon} size={18} />
          <span>{w.title.replace(/^Files — /, '')}</span>
          <span className="dock-minimized-line" />
        </button>)}
      </div>
    </nav>
  </>
}
