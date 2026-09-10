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
  props?: Record<string, unknown>
}

export type Action =
  | { t: 'open'; win: Omit<Win, 'z' | 'minimized' | 'maximized'> }
  | { t: 'close'; id: string }
  | { t: 'focus'; id: string }
  | { t: 'geom'; id: string; x?: number; y?: number; w?: number; h?: number; manual?: boolean }
  | { t: 'layout'; id: string; layout: 'left' | 'right' | 'maximized' | 'restore'; deskW: number; deskH: number }
  | { t: 'minimize'; id: string }
  | { t: 'toggleMax'; id: string; deskW: number; deskH: number }
  | { t: 'title'; id: string; title: string }

export interface State { wins: Win[]; topZ: number }

export function layoutRect(layout: NonNullable<Win['layout']>, width: number, height: number) {
  const half = Math.floor(width / 2)
  return { x: layout === 'right' ? half : 0, y: 0,
    w: layout === 'maximized' ? width : layout === 'left' ? half : width - half, h: height }
}

export function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'open': {
      const z = s.topZ + 1
      return { topZ: z, wins: [...s.wins, { ...a.win, z, minimized: false, maximized: false }] }
    }
    case 'close':
      return { ...s, wins: s.wins.filter(w => w.id !== a.id) }
    case 'focus': {
      const w = s.wins.find(x => x.id === a.id)
      if (!w || w.z === s.topZ) return w?.minimized
        ? { ...s, wins: s.wins.map(x => x.id === a.id ? { ...x, minimized: false } : x) }
        : s
      const z = s.topZ + 1
      return { topZ: z, wins: s.wins.map(x => x.id === a.id ? { ...x, z, minimized: false } : x) }
    }
    case 'geom':
      return { ...s, wins: s.wins.map(w => w.id === a.id
        ? { ...w, x: a.x ?? w.x, y: a.y ?? w.y, w: a.w ?? w.w, h: a.h ?? w.h,
          ...(a.manual ? { layout: undefined, restore: undefined, maximized: false } : {}) } : w) }
    case 'minimize':
      return { ...s, wins: s.wins.map(w => w.id === a.id ? { ...w, minimized: true } : w) }
    case 'toggleMax':
    case 'layout':
      return { ...s, wins: s.wins.map(w => {
        if (w.id !== a.id) return w
        const layout = a.t === 'layout' ? a.layout : w.maximized ? 'restore' : 'maximized'
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
  }
}
