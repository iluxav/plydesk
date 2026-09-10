/**
 * Column sorting for the file manager. Pure, so it runs under `node --test`.
 *
 * Folders always come first, as the SFTP listing already delivers them: a
 * sort by size or date that scattered folders among files would make the
 * directory harder to read, not easier.
 */
import type { Entry } from '../fw/types'

export type SortKey = 'name' | 'size' | 'mtime' | 'mode'
export interface SortState { key: SortKey; dir: 'asc' | 'desc' }
export const DEFAULT_SORT: SortState = { key: 'name', dir: 'asc' }
const KEYS: SortKey[] = ['name', 'size', 'mtime', 'mode']

// Natural order: file2 before file10, and case does not split the list.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byName = (a: Entry, b: Entry) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function compare(a: Entry, b: Entry, key: SortKey): number {
  switch (key) {
    case 'size': return a.size - b.size
    case 'mtime': return a.mtime - b.mtime
    case 'mode': return a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0
    default: return byName(a, b)
  }
}

export function sortEntries(entries: Entry[], sort: SortState): Entry[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    const da = a.kind === 'dir', db = b.kind === 'dir'
    if (da !== db) return da ? -1 : 1
    // A folder's size is its block allocation, which says nothing useful.
    if (da && sort.key === 'size') return byName(a, b)
    return sign * compare(a, b, sort.key) || byName(a, b)
  })
}

/** Same column flips; a new column starts the way people expect to read it. */
export function toggleSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'size' || key === 'mtime' ? 'desc' : 'asc' }
}

export function parseSort(raw: unknown): SortState {
  const value = raw as Partial<SortState> | null
  if (value && KEYS.includes(value.key as SortKey) && (value.dir === 'asc' || value.dir === 'desc')) return { key: value.key as SortKey, dir: value.dir }
  return DEFAULT_SORT
}
