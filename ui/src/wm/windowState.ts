import { remove, resize, splitLeaf, tileRects, type Tile } from './tiling.ts'

export interface Win {
  id: string
  appId: string
  /** The machine this window acts on. Fixed for the window's lifetime. */
  host: string
  title: string
  icon: string
  x: number; y: number; w: number; h: number
  z: number
  minimized: boolean
  maximized: boolean
  layout?: 'left' | 'right' | 'maximized'
  restore?: { x: number; y: number; w: number; h: number }
  /** The app asks to stay floating even on a tiling machine: Settings, Preview. */
  float?: boolean
  /** Placed by the machine's split tree; x, y, w and h are not used while set. */
  tiled?: boolean
  props?: Record<string, unknown>
}

export type Action =
  | { t: 'open'; win: Omit<Win, 'z' | 'minimized' | 'maximized' | 'tiled'> }
  | { t: 'close'; id: string }
  | { t: 'focus'; id: string }
  | { t: 'geom'; id: string; x?: number; y?: number; w?: number; h?: number; manual?: boolean }
  | { t: 'layout'; id: string; layout: 'left' | 'right' | 'maximized' | 'restore'; deskW: number; deskH: number }
  | { t: 'minimize'; id: string }
  | { t: 'toggleMax'; id: string; deskW: number; deskH: number }
  | { t: 'title'; id: string; title: string }
  /** Sent by each machine's pane: whether it tiles, and the area it has. */
  | { t: 'tiling'; host: string; on: boolean; deskW: number; deskH: number; gap?: number }
  | { t: 'tileResize'; host: string; split: string; ratio: number }

/** A machine has an entry in `tiles` exactly while it is in tiling mode. */
export interface State { wins: Win[]; topZ: number; tiles: Record<string, Tile>; tileSeq: number }
export const initialState: State = { wins: [], topZ: 0, tiles: {}, tileSeq: 0 }

export function layoutRect(layout: NonNullable<Win['layout']>, width: number, height: number) {
  const half = Math.floor(width / 2)
  return { x: layout === 'right' ? half : 0, y: 0,
    w: layout === 'maximized' ? width : layout === 'left' ? half : width - half, h: height }
}

/** Put a window into its machine's tree, beside `target` or the focused tile. */
function place(s: State, host: string, id: string, target?: string): State {
  const tile = s.tiles[host]
  if (!tile) return s
  const beside = target ?? s.wins.filter(w => w.host === host && w.tiled && !w.minimized && w.id !== id).sort((a, b) => b.z - a.z)[0]?.id
  const tileSeq = s.tileSeq + 1
  return { ...s, tileSeq, tiles: { ...s.tiles, [host]: { ...tile, layout: splitLeaf(tile, beside, id, `split-${tileSeq}`) } } }
}
function unplace(s: State, host: string, id: string): State {
  const tile = s.tiles[host]
  if (!tile?.layout) return s
  return { ...s, tiles: { ...s.tiles, [host]: { ...tile, layout: remove(tile.layout, id) } } }
}
/** Only one tile can fill the pane, and a tile behind it could not be seen. */
const unfill = (wins: Win[], host: string) => wins.map(w => w.host === host && w.tiled && w.maximized ? { ...w, maximized: false } : w)

export function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'open': {
      const z = s.topZ + 1, host = a.win.host
      const tiled = !!s.tiles[host] && !a.win.float
      const win = { ...a.win, z, minimized: false, maximized: false, tiled }
      if (!tiled) return { ...s, topZ: z, wins: [...s.wins, win] }
      const next = place(s, host, win.id)
      return { ...next, topZ: z, wins: [...unfill(s.wins, host), win] }
    }
    case 'close': {
      const w = s.wins.find(x => x.id === a.id)
      const next = w?.tiled ? unplace(s, w.host, w.id) : s
      return { ...next, wins: s.wins.filter(x => x.id !== a.id) }
    }
    case 'focus': {
      const w = s.wins.find(x => x.id === a.id)
      if (!w || (w.z === s.topZ && !w.minimized)) return s
      const z = w.z === s.topZ ? s.topZ : s.topZ + 1
      // A minimized tile gave its space away, so coming back takes a new split.
      const next = w.tiled && w.minimized ? place(s, w.host, w.id) : s
      return { ...next, topZ: z, wins: (w.tiled ? unfill(s.wins, w.host) : s.wins).map(x => x.id === a.id ? { ...x, z, minimized: false } : x) }
    }
    case 'geom':
      return { ...s, wins: s.wins.map(w => w.id === a.id
        ? { ...w, x: a.x ?? w.x, y: a.y ?? w.y, w: a.w ?? w.w, h: a.h ?? w.h,
          ...(a.manual ? { layout: undefined, restore: undefined, maximized: false } : {}) } : w) }
    case 'minimize': {
      const w = s.wins.find(x => x.id === a.id)
      if (!w || w.minimized) return s
      const next = w.tiled ? unplace(s, w.host, w.id) : s
      return { ...next, wins: s.wins.map(x => x.id === a.id ? { ...x, minimized: true, ...(x.tiled ? { maximized: false } : {}) } : x) }
    }
    case 'toggleMax':
    case 'layout':
      return { ...s, wins: s.wins.map(w => {
        if (w.id !== a.id) return w
        const layout = a.t === 'layout' ? a.layout : w.maximized ? 'restore' : 'maximized'
        // A tile has no halves to snap to; filling the pane is all that applies.
        if (w.tiled) return layout === 'left' || layout === 'right' || w.maximized === (layout === 'maximized')
          ? w : { ...w, maximized: layout === 'maximized' }
        if (layout === 'restore') {
          if (!w.restore) return w
          const width = Math.min(w.restore.w, a.deskW), height = Math.min(w.restore.h, a.deskH)
          return { ...w, ...w.restore, w: width, h: height,
            x: Math.max(0, Math.min(w.restore.x, a.deskW - width)),
            y: Math.max(0, Math.min(w.restore.y, a.deskH - height)),
            maximized: false, layout: undefined, restore: undefined }
        }
        return { ...w, layout, maximized: layout === 'maximized',
          restore: w.restore ?? { x: w.x, y: w.y, w: w.w, h: w.h },
          ...layoutRect(layout, a.deskW, a.deskH) }
      }) }
    case 'title': {
      // Bail out if unchanged: returning a fresh object here re-renders the
      // whole desktop and invalidates every callback passed down to apps.
      const cur = s.wins.find(w => w.id === a.id)
      if (!cur || cur.title === a.title) return s
      return { ...s, wins: s.wins.map(w => w.id === a.id ? { ...w, title: a.title } : w) }
    }
    case 'tiling': {
      const tile = s.tiles[a.host]
      if (!a.on) {
        if (!tile) return s
        // Leave every window where it was, so switching modes moves nothing.
        const rects = tileRects(tile, a.gap ?? 0), tiles = { ...s.tiles }
        delete tiles[a.host]
        return { ...s, tiles, wins: s.wins.map(w => w.host === a.host && w.tiled
          ? { ...w, ...rects[w.id], tiled: false, maximized: false } : w) }
      }
      if (tile) return tile.deskW === a.deskW && tile.deskH === a.deskH ? s
        : { ...s, tiles: { ...s.tiles, [a.host]: { ...tile, deskW: a.deskW, deskH: a.deskH } } }
      // Oldest first, each beside the one before, so the front window ends up
      // in the smallest split — where it would be had they been opened in turn.
      const mine = s.wins.filter(w => w.host === a.host && !w.float).sort((x, y) => x.z - y.z)
      let next: State = { ...s, tiles: { ...s.tiles, [a.host]: { layout: null, deskW: a.deskW, deskH: a.deskH } },
        wins: s.wins.map(w => mine.includes(w) ? { ...w, tiled: true, maximized: false, layout: undefined, restore: undefined } : w) }
      let previous: string | undefined
      for (const w of mine) if (!w.minimized) { next = place(next, a.host, w.id, previous); previous = w.id }
      return next
    }
    case 'tileResize': {
      const tile = s.tiles[a.host]
      if (!tile?.layout) return s
      return { ...s, tiles: { ...s.tiles, [a.host]: { ...tile, layout: resize(tile.layout, a.split, a.ratio) } } }
    }
  }
}
