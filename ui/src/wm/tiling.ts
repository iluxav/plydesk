/**
 * A binary split tree: the layout behind Terminal panes and tiled windows.
 *
 * Geometry is never stored. A leaf's rectangle is whatever the ratios above it
 * say it is, so closing one leaf cannot leave a hole and resizing the
 * container cannot leave anything stranded outside it.
 */
export type Axis = 'row' | 'column'
export type Layout = { kind: 'pane'; id: string } | { kind: 'split'; id: string; axis: Axis; ratio: number; first: Layout; second: Layout }
export type Rect = { x: number; y: number; w: number; h: number }
export type Divider = { id: string; axis: Axis; ratio: number; rect: Rect }

export const leaf = (id: string): Layout => ({ kind: 'pane', id })
export const paneIds = (layout: Layout): string[] => layout.kind === 'pane' ? [layout.id] : [...paneIds(layout.first), ...paneIds(layout.second)]

export function replace(layout: Layout, id: string, next: Layout): Layout {
  if (layout.kind === 'pane') return layout.id === id ? next : layout
  return { ...layout, first: replace(layout.first, id, next), second: replace(layout.second, id, next) }
}
/** Removing a leaf hands its space to its sibling. */
export function remove(layout: Layout, id: string): Layout | null {
  if (layout.kind === 'pane') return layout.id === id ? null : layout
  const first = remove(layout.first, id), second = remove(layout.second, id)
  return first && second ? { ...layout, first, second } : first || second
}
export function resize(layout: Layout, id: string, ratio: number): Layout {
  if (layout.kind === 'pane') return layout
  return layout.id === id ? { ...layout, ratio: Math.max(.12, Math.min(.88, ratio)) }
    : { ...layout, first: resize(layout.first, id, ratio), second: resize(layout.second, id, ratio) }
}

export function layoutRects(layout: Layout, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): { panes: Record<string, Rect>; dividers: Divider[] } {
  if (layout.kind === 'pane') return { panes: { [layout.id]: rect }, dividers: [] }
  const { ratio, axis } = layout
  const first = axis === 'row' ? { ...rect, w: rect.w * ratio } : { ...rect, h: rect.h * ratio }
  const second = axis === 'row' ? { ...rect, x: rect.x + first.w, w: rect.w - first.w } : { ...rect, y: rect.y + first.h, h: rect.h - first.h }
  const a = layoutRects(layout.first, first), b = layoutRects(layout.second, second)
  return { panes: { ...a.panes, ...b.panes }, dividers: [{ id: layout.id, axis, ratio, rect }, ...a.dividers, ...b.dividers] }
}

// ---- tiled windows --------------------------------------------------------

/** One machine's tiled windows, and the area they share. */
export type Tile = { layout: Layout | null; deskW: number; deskH: number }

/**
 * Give a new leaf half of `target`, cut across its longer side.
 *
 * That is the whole of the dwindle layout: the newest window always takes half
 * of the focused one, and the cut follows the shape of what is being cut, so
 * windows stay as close to square as the screen allows.
 */
export function splitLeaf(tile: Tile, target: string | undefined, id: string, splitId: string): Layout {
  if (!tile.layout) return leaf(id)
  const ids = paneIds(tile.layout)
  const at = target && ids.includes(target) ? target : ids[ids.length - 1]
  const rect = layoutRects(tile.layout).panes[at]
  const axis: Axis = rect.w * tile.deskW >= rect.h * tile.deskH ? 'row' : 'column'
  return replace(tile.layout, at, { kind: 'split', id: splitId, axis, ratio: .5, first: leaf(at), second: leaf(id) })
}

/** The area tiles share, in pixels: the pane less half a gap on every side. */
export function tileArea(tile: Tile, gap: number): Rect {
  return { x: gap / 2, y: gap / 2, w: Math.max(1, tile.deskW - gap), h: Math.max(1, tile.deskH - gap) }
}

/**
 * Pixel rectangles for every tiled window.
 *
 * Each cell gives up half a gap per side, which with the area's own inset makes
 * the space between two windows equal to the space between a window and the
 * edge. Whole pixels, so a native child view is not resized by rounding noise.
 */
export function tileRects(tile: Tile, gap: number): Record<string, Rect> {
  if (!tile.layout) return {}
  const area = tileArea(tile, gap), out: Record<string, Rect> = {}
  for (const [id, r] of Object.entries(layoutRects(tile.layout).panes)) {
    const left = Math.round(area.x + r.x * area.w + gap / 2), top = Math.round(area.y + r.y * area.h + gap / 2)
    const right = Math.round(area.x + (r.x + r.w) * area.w - gap / 2), bottom = Math.round(area.y + (r.y + r.h) * area.h - gap / 2)
    out[id] = { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) }
  }
  return out
}
