import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortEntries, toggleSort, DEFAULT_SORT, parseSort } from '../src/apps/fileSort.ts'

const e = (name, kind, size, mtime, mode) => ({ name, kind, size, mtime, mode, user: 'pi', group: 'pi' })
const listing = [
  e('notes.txt', 'file', 120, 300, '-rw-r--r--'),
  e('Videos', 'dir', 4096, 100, 'drwxr-xr-x'),
  e('archive.tar', 'file', 900000, 50, '-rw-------'),
  e('build', 'dir', 4096, 400, 'drwx------'),
  e('file10.log', 'file', 10, 200, '-rw-r--r--'),
  e('file2.log', 'file', 20, 250, '-rwxr-xr-x'),
  e('link', 'link', 5, 500, 'lrwxrwxrwx'),
]
const names = list => list.map(x => x.name)

test('folders stay grouped first and names sort naturally, case-insensitively', () => {
  assert.deepEqual(names(sortEntries(listing, { key: 'name', dir: 'asc' })), ['build', 'Videos', 'archive.tar', 'file2.log', 'file10.log', 'link', 'notes.txt'])
  assert.deepEqual(names(sortEntries(listing, { key: 'name', dir: 'desc' })), ['Videos', 'build', 'notes.txt', 'link', 'file10.log', 'file2.log', 'archive.tar'])
})

test('modified and size sort by number, with folders still grouped', () => {
  assert.deepEqual(names(sortEntries(listing, { key: 'mtime', dir: 'desc' })), ['build', 'Videos', 'link', 'notes.txt', 'file2.log', 'file10.log', 'archive.tar'])
  assert.deepEqual(names(sortEntries(listing, { key: 'size', dir: 'desc' })), ['build', 'Videos', 'archive.tar', 'notes.txt', 'file2.log', 'file10.log', 'link'])
  // Folders report a block size, which says nothing; they keep name order.
  assert.deepEqual(names(sortEntries(listing, { key: 'size', dir: 'asc' })).slice(0, 2), ['build', 'Videos'])
})

test('permissions sort as text and ties fall back to the name', () => {
  const sorted = sortEntries(listing, { key: 'mode', dir: 'asc' })
  assert.deepEqual(names(sorted).slice(2), ['archive.tar', 'file10.log', 'notes.txt', 'file2.log', 'link'])
})

test('sorting never mutates the listing it was given', () => {
  const before = names(listing)
  sortEntries(listing, { key: 'size', dir: 'desc' })
  assert.deepEqual(names(listing), before)
})

test('clicking a header toggles direction on the same key and picks a sensible start for a new one', () => {
  assert.deepEqual(DEFAULT_SORT, { key: 'name', dir: 'asc' })
  assert.deepEqual(toggleSort(DEFAULT_SORT, 'name'), { key: 'name', dir: 'desc' })
  assert.deepEqual(toggleSort(DEFAULT_SORT, 'mtime'), { key: 'mtime', dir: 'desc' })
  assert.deepEqual(toggleSort({ key: 'mtime', dir: 'desc' }, 'mtime'), { key: 'mtime', dir: 'asc' })
  assert.deepEqual(toggleSort(DEFAULT_SORT, 'size'), { key: 'size', dir: 'desc' })
  assert.deepEqual(toggleSort(DEFAULT_SORT, 'mode'), { key: 'mode', dir: 'asc' })
})

test('a saved sort is validated before use', () => {
  assert.deepEqual(parseSort({ key: 'mtime', dir: 'asc' }), { key: 'mtime', dir: 'asc' })
  assert.deepEqual(parseSort({ key: 'owner', dir: 'asc' }), DEFAULT_SORT)
  assert.deepEqual(parseSort({ key: 'size', dir: 'sideways' }), DEFAULT_SORT)
  assert.deepEqual(parseSort(null), DEFAULT_SORT)
})
