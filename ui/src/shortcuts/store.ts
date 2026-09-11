import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { APPS } from '../desktop/registry'
import { Terminal } from '../apps/Terminal'
import { WebShortcut } from './WebShortcut'
import { shortcutDetail, type Shortcut, type ShortcutKind } from './model'

let entries: Shortcut[] = [], error = '', request = 0
const listeners = new Set<(removed: string[]) => void>()
let initialized: Promise<void> | undefined
export const shortcuts = () => entries
export const shortcutsError = () => error
export function onShortcutsChanged(fn: (removed: string[]) => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export async function reloadShortcuts() {
  const id = ++request
  try {
    const next = await invoke<Shortcut[]>('shortcuts_list')
    if (id !== request) return
    entries = next; error = ''
    const removed = APPS.filter(a => a.shortcut && !next.some(s => s.id === a.id)).map(a => a.id)
    for (let i = APPS.length - 1; i >= 0; i--) if (APPS[i].shortcut) APPS.splice(i, 1)
    for (const shortcut of next) APPS.push({ id: shortcut.id, title: shortcut.name, icon: shortcut.icon, shortcut,
      component: shortcut.kind === 'web' ? WebShortcut : Terminal,
      w: shortcut.kind === 'web' ? 1080 : 840, h: shortcut.kind === 'web' ? 740 : 560,
      description: shortcutDetail(shortcut),
    })
    listeners.forEach(fn => fn(removed))
  } catch (e) { if (id === request) { error = String(e); listeners.forEach(fn => fn([])) } }
}
export function initializeShortcuts() {
  initialized ??= listen('shortcuts-changed', () => { void reloadShortcuts() }).then(() => reloadShortcuts())
    .catch(e => { error = String(e); listeners.forEach(fn => fn([])); initialized = undefined })
  return initialized
}
export async function saveShortcut(shortcut: Shortcut) {
  const saved = await invoke<Shortcut>('shortcuts_save', { shortcut })
  await reloadShortcuts()
  return saved
}
export async function removeShortcut(id: string) { await invoke('shortcuts_remove', { id }); await reloadShortcuts() }
export function editShortcut(id?: string, kind?: ShortcutKind) {
  window.dispatchEvent(new CustomEvent('plydesk:edit-shortcut', { detail: { id, kind } }))
}
