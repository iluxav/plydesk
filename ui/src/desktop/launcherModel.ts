/**
 * The launcher's pure parts: ranking apps, merging them with file hits from
 * the native index, and turning a choice into an app to open.
 *
 * No React and no framework imports, so this runs under `node --test`.
 */
export interface AppLike { id: string; title: string; icon: string; hidden?: boolean }
export interface FileHit { path: string; name: string; dir: boolean }
export type LauncherItem = ({ kind: 'app' } & AppLike) | ({ kind: 'file' } & FileHit)

/** Tier first, then how early the match sits in the title. */
function appMatch(title: string, query: string): { tier: number; at: number } | null {
  const t = title.toLowerCase()
  if (!query) return { tier: 1, at: 0 }
  if (t === query) return { tier: 5, at: 0 }
  if (t.startsWith(query)) return { tier: 4, at: 0 }
  let offset = 0
  for (const word of t.split(/([\s\-_.]+)/)) {
    if (word.startsWith(query) && offset > 0) return { tier: 3, at: offset }
    offset += word.length
  }
  const at = t.indexOf(query)
  if (at >= 0) return { tier: 2, at }
  let i = 0
  for (const c of t) if (c === query[i]) i++
  return i === query.length ? { tier: 1, at: 0 } : null
}

export function matchApps<T extends AppLike>(apps: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  return apps
    .flatMap((app, order) => {
      if (app.hidden) return []
      const match = appMatch(app.title, q)
      return match ? [{ app, order, ...match }] : []
    })
    .sort((a, b) => b.tier - a.tier || a.at - b.at || a.order - b.order)
    .map(x => x.app)
}

/**
 * Apps stay ahead of files, but when both exist apps take at most half the
 * rows, so a common letter does not bury every file behind the dock.
 */
export function mergeResults(apps: AppLike[], files: FileHit[], limit: number): LauncherItem[] {
  const appRows = files.length ? Math.ceil(limit / 2) : limit
  const chosenApps = apps.slice(0, appRows)
  const chosenFiles = files.slice(0, limit - chosenApps.length)
  const spare = limit - chosenApps.length - chosenFiles.length
  const allApps = spare > 0 ? [...chosenApps, ...apps.slice(appRows, appRows + spare)] : chosenApps
  return [
    ...allApps.map(app => ({ kind: 'app' as const, id: app.id, title: app.title, icon: app.icon, hidden: app.hidden })),
    ...chosenFiles.map(file => ({ kind: 'file' as const, ...file })),
  ]
}

export function step(index: number, delta: number, length: number): number {
  return length ? (index + delta + length) % length : 0
}

export function parentOf(path: string): string {
  return path.replace(/\/[^/]+$/, '') || '/'
}

/** Enter opens; Command-Enter reveals a file's folder in Files. */
export function actionFor(item: LauncherItem, reveal: boolean, handler: (path: string) => string): { appId: string; props: Record<string, unknown> } {
  if (item.kind === 'app') return { appId: item.id, props: {} }
  if (reveal) return { appId: 'files', props: { path: parentOf(item.path) } }
  if (item.dir) return { appId: 'files', props: { path: item.path } }
  return { appId: handler(item.path), props: { path: item.path } }
}
