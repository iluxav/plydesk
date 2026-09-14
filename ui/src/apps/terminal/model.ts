export type Axis = 'row' | 'column'
export type Layout = { kind: 'pane'; id: string } | { kind: 'split'; id: string; axis: Axis; ratio: number; first: Layout; second: Layout }
export type Pane = { id: string; cwd?: string }
export type Tab = { id: string; name?: string; layout: Layout; activePane: string }
export type Workspace = { tabs: Tab[]; activeTab: string; panes: Record<string, Pane> }
export type Action =
  | { type: 'tab'; id: string; pane: Pane }
  | { type: 'split'; tab: string; pane: Pane; splitId: string; axis: Axis }
  | { type: 'focus'; tab: string; pane?: string }
  | { type: 'close-pane'; tab: string; pane: string }
  | { type: 'close-tab'; tab: string }
  | { type: 'rename'; tab: string; name: string }
  | { type: 'resize'; tab: string; split: string; ratio: number }

export const paneIds = (layout: Layout): string[] => layout.kind === 'pane' ? [layout.id] : [...paneIds(layout.first), ...paneIds(layout.second)]
const leaf = (id: string): Layout => ({ kind: 'pane', id })
export function initialWorkspace(tab: string, pane: Pane): Workspace {
  return { tabs: [{ id: tab, layout: leaf(pane.id), activePane: pane.id }], activeTab: tab, panes: { [pane.id]: pane } }
}
function replace(layout: Layout, id: string, next: Layout): Layout {
  if (layout.kind === 'pane') return layout.id === id ? next : layout
  return { ...layout, first: replace(layout.first, id, next), second: replace(layout.second, id, next) }
}
function remove(layout: Layout, id: string): Layout | null {
  if (layout.kind === 'pane') return layout.id === id ? null : layout
  const first = remove(layout.first, id), second = remove(layout.second, id)
  return first && second ? { ...layout, first, second } : first || second
}
function resize(layout: Layout, id: string, ratio: number): Layout {
  if (layout.kind === 'pane') return layout
  return layout.id === id ? { ...layout, ratio: Math.max(.12, Math.min(.88, ratio)) }
    : { ...layout, first: resize(layout.first, id, ratio), second: resize(layout.second, id, ratio) }
}
export function workspaceReducer(state: Workspace, action: Action): Workspace {
  if (action.type === 'tab') return { tabs: [...state.tabs, { id: action.id, layout: leaf(action.pane.id), activePane: action.pane.id }],
    activeTab: action.id, panes: { ...state.panes, [action.pane.id]: action.pane } }
  const tab = state.tabs.find(t => t.id === action.tab)
  if (!tab) return state
  if (action.type === 'focus') return { ...state, activeTab: tab.id,
    tabs: state.tabs.map(t => t.id === tab.id && action.pane && paneIds(t.layout).includes(action.pane) ? { ...t, activePane: action.pane } : t) }
  if (action.type === 'close-tab') {
    const index = state.tabs.indexOf(tab), tabs = state.tabs.filter(t => t.id !== tab.id), panes = { ...state.panes }
    paneIds(tab.layout).forEach(id => delete panes[id])
    return { tabs, panes, activeTab: state.activeTab === tab.id ? tabs[Math.min(index, tabs.length - 1)]?.id || '' : state.activeTab }
  }
  if (action.type === 'close-pane') {
    if (!paneIds(tab.layout).includes(action.pane)) return state
    const layout = remove(tab.layout, action.pane)
    if (!layout) return workspaceReducer(state, { type: 'close-tab', tab: tab.id })
    const panes = { ...state.panes }; delete panes[action.pane]
    return { ...state, panes, tabs: state.tabs.map(t => t.id === tab.id ? { ...t, layout,
      activePane: t.activePane === action.pane ? paneIds(layout)[0] : t.activePane } : t) }
  }
  if (action.type === 'split') return { ...state, panes: { ...state.panes, [action.pane.id]: action.pane }, tabs: state.tabs.map(t => t.id === tab.id
    ? { ...t, activePane: action.pane.id, layout: replace(t.layout, t.activePane, { kind: 'split', id: action.splitId, axis: action.axis, ratio: .5,
      first: leaf(t.activePane), second: leaf(action.pane.id) }) } : t) }
  return { ...state, tabs: state.tabs.map(t => t.id !== tab.id ? t : action.type === 'rename'
    ? { ...t, name: action.name.trim() || undefined } : { ...t, layout: resize(t.layout, action.split, action.ratio) }) }
}

export type Rect = { x: number; y: number; w: number; h: number }
export type Divider = { id: string; axis: Axis; ratio: number; rect: Rect }
export function layoutRects(layout: Layout, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): { panes: Record<string, Rect>; dividers: Divider[] } {
  if (layout.kind === 'pane') return { panes: { [layout.id]: rect }, dividers: [] }
  const { ratio, axis } = layout
  const first = axis === 'row' ? { ...rect, w: rect.w * ratio } : { ...rect, h: rect.h * ratio }
  const second = axis === 'row' ? { ...rect, x: rect.x + first.w, w: rect.w - first.w } : { ...rect, y: rect.y + first.h, h: rect.h - first.h }
  const a = layoutRects(layout.first, first), b = layoutRects(layout.second, second)
  return { panes: { ...a.panes, ...b.panes }, dividers: [{ id: layout.id, axis, ratio, rect }, ...a.dividers, ...b.dividers] }
}
export type Pin = { path: string; label: string }
export function parsePins(value: unknown): Pin[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.filter((p): p is Pin => {
    if (!p || typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.includes('\0') || typeof p.label !== 'string' || !p.label.trim() || seen.has(p.path)) return false
    seen.add(p.path); return true
  }).map(p => ({ path: p.path, label: p.label }))
}
export const folderName = (path?: string) => path ? path.split('/').filter(Boolean).at(-1) || '/' : 'Shell'
