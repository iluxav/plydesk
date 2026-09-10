/**
 * The app was called sshdesk until September 2026. Preferences saved in
 * browser storage under the old prefix are copied to the new one once, so
 * saved machines, shortcuts, and per-machine settings survive the rename.
 * Nothing is deleted. Imported first, before any module reads storage.
 */
try {
  const moves: [string, string][] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!
    const next = key.startsWith('sshdesk:') ? 'plydesk:' + key.slice('sshdesk:'.length)
      : key === 'sshdesk.keyboard.v1' ? 'plydesk.keyboard.v1' : null
    if (next && localStorage.getItem(next) === null) moves.push([key, next])
  }
  for (const [from, to] of moves) localStorage.setItem(to, localStorage.getItem(from)!)
} catch { /* storage may be unavailable; defaults apply */ }

export {}
