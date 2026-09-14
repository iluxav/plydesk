import { META, SHIFT, CTRL, modifiers } from '../../keyboard/shortcuts.ts'

export const TERMINAL_KEYS = [
  { action: 'new-tab', code: 'KeyT', modifiers: META },
  { action: 'split', code: 'KeyT', modifiers: META | SHIFT },
  { action: 'close-pane', code: 'KeyW', modifiers: META },
  { action: 'close-tab', code: 'KeyW', modifiers: META | SHIFT },
  { action: 'search', code: 'KeyF', modifiers: META },
  { action: 'clear', code: 'KeyK', modifiers: META },
  { action: 'zoom-in', code: 'Equal', modifiers: META },
  { action: 'zoom-in', code: 'Equal', modifiers: META | SHIFT },
  { action: 'zoom-out', code: 'Minus', modifiers: META },
  { action: 'zoom-reset', code: 'Digit0', modifiers: META },
  { action: 'next-tab', code: 'Tab', modifiers: CTRL },
  { action: 'previous-tab', code: 'Tab', modifiers: CTRL | SHIFT },
]
export function terminalKey(event: KeyboardEvent): string | undefined {
  if (event.isComposing) return
  const mods = modifiers(event)
  return TERMINAL_KEYS.find(binding => binding.code === event.code && binding.modifiers === mods)?.action
}
