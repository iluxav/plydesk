import { useSyncExternalStore } from 'react'
import { parsePreferences, type KeyboardPreferences } from './shortcuts'

const KEY = 'plydesk.keyboard.v1'
let preferences = parsePreferences(null)
try { preferences = parsePreferences(localStorage.getItem(KEY)) } catch { /* Settings reports write errors when the user saves. */ }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useKeyboardPreferences = () => useSyncExternalStore(subscribe, () => preferences)
export function saveKeyboardPreferences(next: KeyboardPreferences) {
  // Persist first; a failed write must not masquerade as a saved shortcut.
  localStorage.setItem(KEY, JSON.stringify(next))
  preferences = next
  listeners.forEach(listener => listener())
}
window.addEventListener('storage', e => {
  if (e.key !== KEY) return
  preferences = parsePreferences(e.newValue)
  listeners.forEach(listener => listener())
})
