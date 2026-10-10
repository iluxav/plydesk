import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import type { Webview } from '@tauri-apps/api/webview'

/**
 * Where native child views (apps, websites, VS Code) are placed over the desktop.
 *
 * On Linux, Tauri stacks child webviews under the desktop instead of placing them, and ignores
 * their position and size. The app moves each into a layer over the desktop (src-tauri/src/views.rs)
 * and places it there through `native_view_place`; elsewhere the view's own position and size do it.
 */
export const linux = /\bLinux\b/.test(navigator.userAgent) && !/\bAndroid\b/.test(navigator.userAgent)

/** Moves a view the desktop created into the layer over it. Views made in Rust are moved there already. */
export async function adoptView(label: string) {
  if (linux) await invoke('native_view_adopt', { label })
}

/**
 * Places a view at [x, y, width, height] in desktop pixels, doing only what changed since
 * `previous`: a move alone does not resize, so an editor is not re-laid out on every pointer move.
 */
export async function placeView(view: Webview, bounds: number[], previous: number[] = []) {
  const moved = bounds[0] !== previous[0] || bounds[1] !== previous[1]
  const resized = bounds[2] !== previous[2] || bounds[3] !== previous[3]
  if (!moved && !resized) return
  if (linux) {
    await invoke('native_view_place', { label: view.label, x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] })
    return
  }
  if (moved) await view.setPosition(new LogicalPosition(bounds[0], bounds[1]))
  if (resized) await view.setSize(new LogicalSize(bounds[2], bounds[3]))
}

/**
 * Whether a window can keep its native view on screen while another window has focus. A native
 * view is drawn over all HTML, so it may stay only while nothing of the desktop is over it: no
 * window in front of it on its machine overlaps it (a tile the window manager calls exposed never
 * is). Menus, dialogs and the window switcher are checked by the caller, which hides views for them.
 */
export function unobstructed(win: HTMLElement): boolean {
  if (win.dataset.exposed === 'true') return true
  const mine = win.getBoundingClientRect(), z = Number(win.style.zIndex) || 0
  for (const other of document.querySelectorAll<HTMLElement>('[data-window]')) {
    if (other === win || other.dataset.host !== win.dataset.host || other.style.display === 'none') continue
    if ((Number(other.style.zIndex) || 0) < z) continue
    const r = other.getBoundingClientRect()
    if (r.width > 0 && r.left < mine.right && mine.left < r.right && r.top < mine.bottom && mine.top < r.bottom) return false
  }
  return true
}
