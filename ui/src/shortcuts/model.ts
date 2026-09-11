export type Shortcut = { id: string; name: string; icon: string } & (
  | { kind: 'web'; url: string; allowedOrigins: string[] }
  | { kind: 'tui'; machine: string; command: string; cwd: string; closeOnCtrlC: boolean }
)
export type ShortcutKind = Shortcut['kind']
export function shortcutKind(shortcut: Shortcut) { return shortcut.kind === 'web' ? 'Web shortcut' : 'TUI shortcut' }
export function shortcutDetail(shortcut: Shortcut) { return shortcut.kind === 'web' ? shortcut.url : `${shortcut.command} · ${shortcut.machine}` }
export function availableOn(shortcut: Shortcut | undefined, host: string) { return !shortcut || shortcut.kind === 'web' || shortcut.machine === host }
export function closesOnExit(code: number | null | undefined) { return code === 0 || code === 130 }
export function newShortcut(kind: ShortcutKind, host: string): Shortcut {
  const base = { id: '', name: '', icon: kind === 'web' ? 'lucide:globe' : 'lucide:terminal' }
  return kind === 'web' ? { ...base, kind, url: '', allowedOrigins: [] }
    : { ...base, kind, machine: host, command: '', cwd: '', closeOnCtrlC: false }
}
