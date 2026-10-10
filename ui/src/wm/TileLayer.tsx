import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { useWM } from './store'
import { workArea } from './workArea'
import { layoutRects, tileArea, type Divider, type Rect } from './tiling'
import { value as tokenValue } from '../fw/tokens'

export const isTiling = (host: string) => tokenValue('desk.layout', host) === 'tiling'
/** Tile geometry is computed in pixels, so the gap token is read as a number. */
export function tileGap(host: string): number {
  const gap = parseFloat(tokenValue('desk.gap', host))
  return Number.isFinite(gap) ? Math.max(0, Math.min(gap, 64)) : 8
}

/**
 * One per machine pane. Tells the window manager whether this machine tiles and
 * how much room it has, and draws the dividers between its tiles.
 *
 * The pane reports, rather than the reducer asking, because the mode is a
 * per-machine setting and the area is DOM — neither is the reducer's to know.
 */
export function TileLayer({ host }: { host: string }) {
  const { state, dispatch } = useWM()
  const el = useRef<HTMLDivElement>(null)
  const on = isTiling(host), gap = tileGap(host)

  useLayoutEffect(() => {
    const pane = el.current?.parentElement
    if (!pane) return
    const report = () => dispatch({ t: 'tiling', host, on, gap, ...workArea(pane) })
    report()
    const observer = new ResizeObserver(report)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [dispatch, host, on, gap])

  const tile = state.tiles[host]
  // A tile filling the pane covers the dividers, and they would resize nothing visible.
  const filled = state.wins.some(w => w.host === host && w.tiled && w.maximized && !w.minimized)
  const area = tile && tileArea(tile, gap)
  return <div ref={el} className="tile-layer">
    {tile?.layout && area && !filled && layoutRects(tile.layout).dividers.map(divider =>
      <TileDivider key={divider.id} divider={divider} area={area} thickness={Math.max(gap, 8)}
        onResize={ratio => dispatch({ t: 'tileResize', host, split: divider.id, ratio })} />)}
  </div>
}

function TileDivider({ divider, area, thickness, onResize }: { divider: Divider; area: Rect; thickness: number; onResize: (ratio: number) => void }) {
  const origin = useRef<DOMRect | null>(null), frame = useRef(0), { axis, rect, ratio } = divider
  const style: CSSProperties = axis === 'row'
    ? { left: area.x + (rect.x + rect.w * ratio) * area.w, top: area.y + rect.y * area.h, height: rect.h * area.h, width: thickness }
    : { top: area.y + (rect.y + rect.h * ratio) * area.h, left: area.x + rect.x * area.w, width: rect.w * area.w, height: thickness }
  const end = (node: HTMLElement) => {
    origin.current = null
    node.classList.remove('is-dragging')
    document.body.classList.remove('desk-resizing')
    document.body.style.cursor = ''
  }
  return <div className={`tile-divider is-${axis}`} style={style} role="separator" tabIndex={0} aria-label="Resize tiled windows"
    aria-orientation={axis === 'row' ? 'vertical' : 'horizontal'} aria-valuemin={12} aria-valuemax={88} aria-valuenow={Math.round(ratio * 100)}
    onDoubleClick={() => onResize(.5)} onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
      origin.current = event.currentTarget.parentElement!.getBoundingClientRect()
      event.currentTarget.classList.add('is-dragging')
      // Keeps iframes from swallowing the drag, as a floating resize does.
      document.body.classList.add('desk-resizing')
      document.body.style.cursor = axis === 'row' ? 'col-resize' : 'row-resize'
    }} onPointerMove={event => {
      const bounds = origin.current
      if (!bounds || !event.currentTarget.hasPointerCapture(event.pointerId)) return
      const next = axis === 'row' ? ((event.clientX - bounds.left - area.x) / area.w - rect.x) / rect.w
        : ((event.clientY - bounds.top - area.y) / area.h - rect.y) / rect.h
      // Every tile and every app inside re-renders on a resize; once a frame is plenty.
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => onResize(next))
    }} onLostPointerCapture={event => end(event.currentTarget)}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onKeyDown={event => { const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? .04 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.04 : 0
      if (step) { event.preventDefault(); onResize(ratio + step) } }} />
}
