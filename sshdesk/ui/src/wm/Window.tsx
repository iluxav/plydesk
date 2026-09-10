import { Icon } from './Icon'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useWM, type Win } from './store'
import { layoutRect } from './windowState'
import { workArea } from './workArea'

const HANDLES: [string, string][] = [
  ['top-0 left-2 right-2 h-1 cursor-ns-resize', 'n'],
  ['bottom-0 left-2 right-2 h-1 cursor-ns-resize', 's'],
  ['right-0 top-2 bottom-2 w-1 cursor-ew-resize', 'e'],
  ['left-0 top-2 bottom-2 w-1 cursor-ew-resize', 'w'],
  ['top-0 right-0 w-3 h-3 cursor-nesw-resize', 'ne'],
  ['top-0 left-0 w-3 h-3 cursor-nwse-resize', 'nw'],
  ['bottom-0 right-0 w-3 h-3 cursor-nwse-resize', 'se'],
  ['bottom-0 left-0 w-3 h-3 cursor-nesw-resize', 'sw'],
]
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max))

export function Window({ win, children }: { win: Win; children: ReactNode }) {
  const { state, dispatch } = useWM()
  const el = useRef<HTMLDivElement>(null)
  const current = useRef(win)
  useLayoutEffect(() => { current.current = win })
  const cleanup = useRef<(() => void) | null>(null)
  const front = state.wins.filter(w => w.host === win.host && !w.minimized).sort((a, b) => b.z - a.z)[0]
  const focused = front?.id === win.id
  const focus = () => dispatch({ t: 'focus', id: win.id })
  const toggleMax = () => {
    const pane = el.current?.parentElement
    if (!pane) return
    focus()
    dispatch({ t: 'toggleMax', id: win.id, ...workArea(pane) })
  }

  // Refit when a machine column or the native window changes size. Observing
  // the pane also covers a second machine connecting without a browser resize.
  useLayoutEffect(() => {
    const pane = el.current?.parentElement
    if (!pane) return
    const fit = () => {
      if (cleanup.current) return
      const w = current.current
      const width = Math.min(w.w, pane.clientWidth)
      const height = Math.min(w.h, pane.clientHeight)
      const area = workArea(pane)
      const next = w.layout
        ? layoutRect(w.layout, area.deskW, area.deskH)
        : { x: clamp(w.x, 0, pane.clientWidth - width), y: clamp(w.y, 0, pane.clientHeight - height), w: width, h: height }
      if (Object.entries(next).some(([key, value]) => w[key as 'x' | 'y' | 'w' | 'h'] !== value))
        dispatch({ t: 'geom', id: w.id, ...next })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(pane)
    return () => { observer.disconnect(); cleanup.current?.() }
  }, [dispatch, win.id, win.layout])

  function gesture(e: React.PointerEvent, dir?: string) {
    if (e.button !== 0 || win.maximized || cleanup.current) return
    e.preventDefault(); e.stopPropagation(); focus()
    const node = el.current!, pane = node.parentElement!
    const start = { mx: e.clientX, my: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h }
    let geometry = { x: win.x, y: win.y, w: win.w, h: win.h }
    node.setPointerCapture(e.pointerId)
    document.body.classList.add(dir ? 'desk-resizing' : 'desk-dragging')
    const move = (event: PointerEvent) => {
      const dx = event.clientX - start.mx, dy = event.clientY - start.my
      let { x, y, w, h } = start
      const minW = Math.min(360, pane.clientWidth), minH = Math.min(220, pane.clientHeight)
      if (!dir) {
        x = clamp(start.x + dx, 0, pane.clientWidth - w)
        y = clamp(start.y + dy, 0, pane.clientHeight - h)
      } else {
        if (dir.includes('e')) w = clamp(start.w + dx, minW, pane.clientWidth - x)
        if (dir.includes('s')) h = clamp(start.h + dy, minH, pane.clientHeight - y)
        if (dir.includes('w')) { x = clamp(start.x + dx, 0, start.x + start.w - minW); w = start.x + start.w - x }
        if (dir.includes('n')) { y = clamp(start.y + dy, 0, start.y + start.h - minH); h = start.y + start.h - y }
      }
      geometry = { x, y, w, h }
      Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
    }
    const end = () => {
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', end)
      node.removeEventListener('pointercancel', end)
      node.removeEventListener('lostpointercapture', end)
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId)
      document.body.classList.remove('desk-dragging', 'desk-resizing')
      cleanup.current = null
      dispatch({ t: 'geom', id: win.id, ...geometry, manual: true })
    }
    cleanup.current = end
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', end)
    node.addEventListener('pointercancel', end)
    node.addEventListener('lostpointercapture', end)
  }

  return (
    <section ref={el} data-window data-window-id={win.id} data-host={win.host} data-focused={focused} tabIndex={-1}
      aria-label={win.title} onPointerDown={focus} onFocusCapture={focus}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z,
        display: win.minimized ? 'none' : undefined }}
      className={`desktop-window app-${win.appId} ${win.maximized ? 'is-maximized' : ''}`}>
      <header className="window-titlebar" onPointerDown={e => gesture(e)} onDoubleClick={toggleMax}>
        <div className="window-controls" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
          <button className="window-control close" title="Close window" aria-label={`Close ${win.title}`}
            onClick={() => dispatch({ t: 'close', id: win.id })}><Icon id="lucide:x" size={9} /></button>
          <button className="window-control minimize" title="Minimize window" aria-label={`Minimize ${win.title}`}
            onClick={() => dispatch({ t: 'minimize', id: win.id })}><Icon id="lucide:minus" size={9} /></button>
          <button className="window-control maximize" title={win.maximized ? 'Restore window' : 'Maximize window'}
            aria-label={`${win.maximized ? 'Restore' : 'Maximize'} ${win.title}`} onClick={toggleMax}>
            <Icon id={win.maximized ? 'lucide:minimize-2' : 'lucide:maximize-2'} size={8} />
          </button>
        </div>
        <span className="window-title"><Icon token={`${win.appId}.app`} host={win.host} fallback={win.icon} size={15} />
          <span>{win.title}</span></span>
        <span className="window-host" title={win.host}><span className="status-dot" />{win.host.replace(/^.*@/, '')}</span>
      </header>
      <div className="window-content">{children}</div>
      {!win.maximized && HANDLES.map(([cls, dir]) => <div key={dir} aria-hidden
        onPointerDown={e => gesture(e, dir)} className={`absolute ${cls}`} />)}
    </section>
  )
}
