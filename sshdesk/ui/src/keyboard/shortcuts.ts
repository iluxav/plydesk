export type Shortcut = { code: string; modifiers: number }
export const SHIFT = 1, CTRL = 2, ALT = 4, META = 8
export const ACTIONS = [
  { id: 'snap-left', label: 'Snap window left', group: 'Arrange windows', shortcut: { code: 'ArrowLeft', modifiers: ALT | META } },
  { id: 'snap-right', label: 'Snap window right', group: 'Arrange windows', shortcut: { code: 'ArrowRight', modifiers: ALT | META } },
  { id: 'maximize', label: 'Maximize window', group: 'Arrange windows', shortcut: { code: 'ArrowUp', modifiers: ALT | META } },
  { id: 'restore', label: 'Restore window size', group: 'Arrange windows', shortcut: { code: 'ArrowDown', modifiers: ALT | META } },
  { id: 'next-window', label: 'Next window', group: 'Switch windows', shortcut: { code: 'Backquote', modifiers: META } },
  { id: 'previous-window', label: 'Previous window', group: 'Switch windows', shortcut: { code: 'Backquote', modifiers: META | SHIFT } },
  { id: 'minimize', label: 'Minimize window', group: 'Switch windows', shortcut: { code: 'KeyM', modifiers: META | ALT } },
] as const
export type ActionId = typeof ACTIONS[number]['id']
export type KeyboardPreferences = { bindings: Record<ActionId, Shortcut | null>; captureSystem: boolean }

// Physical keys: Option may change event.key (for example Option+M → µ).
export const MAC_CODES: Record<string, number> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
  KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25,
  Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32,
  BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40,
  Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47,
  Tab: 48, Space: 49, Backquote: 50, Backspace: 51, Escape: 53,
  F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F10: 109,
  F12: 111, Home: 115, PageUp: 116, Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
}
export function modifiers(e: Pick<KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>) {
  return (e.shiftKey ? SHIFT : 0) | (e.ctrlKey ? CTRL : 0) | (e.altKey ? ALT : 0) | (e.metaKey ? META : 0)
}
export function defaults(): KeyboardPreferences {
  return { bindings: Object.fromEntries(ACTIONS.map(a => [a.id, { ...a.shortcut }])) as KeyboardPreferences['bindings'], captureSystem: false }
}
export function equalShortcut(a: Shortcut | null, b: Shortcut | null) {
  return a === b || !!a && !!b && a.code === b.code && a.modifiers === b.modifiers
}
export function shortcutError(value: Shortcut): string {
  if (!(value.code in MAC_CODES) || ['Escape', 'Enter', 'Backspace', 'Delete'].includes(value.code)) return 'Choose a letter, number, arrow, Tab, or function key.'
  if (!(value.modifiers & (CTRL | ALT | META)) || value.modifiers > 15 || value.modifiers < 0) return 'Include Command, Option, or Control.'
  if ((value.modifiers === META && ['KeyQ', 'KeyW', 'KeyH', 'KeyM'].includes(value.code))
    || (value.modifiers === (META | ALT) && value.code === 'KeyH')) return 'This shortcut is reserved for the macOS app controls.'
  return ''
}
export function conflict(bindings: KeyboardPreferences['bindings'], id: ActionId, value: Shortcut | null) {
  return value && ACTIONS.find(a => a.id !== id && equalShortcut(bindings[a.id], value))
}
export function parsePreferences(raw: string | null): KeyboardPreferences {
  const result = defaults()
  try {
    const saved = JSON.parse(raw || '{}')
    result.captureSystem = saved.captureSystem === true
    const used: Shortcut[] = []
    for (const action of ACTIONS) {
      const candidate = saved.bindings?.[action.id]
      let value: Shortcut | null = candidate === null ? null
        : candidate && typeof candidate.code === 'string' && Number.isInteger(candidate.modifiers) && !shortcutError(candidate)
          ? { code: candidate.code, modifiers: candidate.modifiers } : { ...action.shortcut }
      if (value && used.some(other => equalShortcut(value, other))) value = null
      result.bindings[action.id] = value
      if (value) used.push(value)
    }
  } catch { /* Use working defaults if saved preferences are malformed. */ }
  return result
}
export function formatShortcut(shortcut: Shortcut | null) {
  if (!shortcut) return 'Not set'
  const labels: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Backquote: '`', Tab: 'Tab', Space: 'Space', BracketLeft: '[', BracketRight: ']', Minus: '−', Equal: '=',
    Semicolon: ';', Quote: "'", Backslash: '\\', Slash: '/', Comma: ',', Period: '.', PageUp: 'Page Up', PageDown: 'Page Down' }
  const key = labels[shortcut.code] || shortcut.code.replace(/^Key|^Digit/, '')
  return `${shortcut.modifiers & CTRL ? '⌃' : ''}${shortcut.modifiers & ALT ? '⌥' : ''}${shortcut.modifiers & SHIFT ? '⇧' : ''}${shortcut.modifiers & META ? '⌘' : ''}${key}`
}
