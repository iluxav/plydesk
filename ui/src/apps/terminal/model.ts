import { leaf, paneIds, replace, remove, resize, type Axis, type Layout } from '../../wm/tiling.ts'
// The split tree is shared with the window manager's tiling mode.
export { paneIds, layoutRects, type Axis, type Layout, type Rect, type Divider } from '../../wm/tiling.ts'
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

export function initialWorkspace(tab: string, pane: Pane): Workspace {
  return { tabs: [{ id: tab, layout: leaf(pane.id), activePane: pane.id }], activeTab: tab, panes: { [pane.id]: pane } }
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
