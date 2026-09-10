import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchApps, mergeResults, step, actionFor } from '../src/desktop/launcherModel.ts'

const apps = [
  { id: 'files', title: 'Files', icon: '📁' },
  { id: 'editor', title: 'Editor', icon: '📝' },
  { id: 'terminal', title: 'Terminal', icon: '⌨️' },
  { id: 'image', title: 'Preview', icon: '🖼', hidden: true },
  { id: 'vscode', title: 'VS Code', icon: 'lucide:code-xml' },
]
const file = (path, dir = false) => ({ path, name: path.split('/').pop(), dir })

test('apps match by prefix, then word start, then anywhere, never hidden ones', () => {
  assert.deepEqual(matchApps(apps, '').map(a => a.id), ['files', 'editor', 'terminal', 'vscode'])
  assert.deepEqual(matchApps(apps, 'e').map(a => a.id), ['editor', 'terminal', 'files', 'vscode'])
  assert.deepEqual(matchApps(apps, 'code').map(a => a.id), ['vscode'])
  assert.deepEqual(matchApps(apps, 'prev').map(a => a.id), [])
  assert.deepEqual(matchApps(apps, 'fls').map(a => a.id), ['files'])
  assert.deepEqual(matchApps(apps, 'zzz'), [])
})

test('merged results keep apps ahead of files and respect the limit', () => {
  const hits = [file('/home/pi/notes.txt'), file('/home/pi/projects', true)]
  const merged = mergeResults(matchApps(apps, ''), [], 12)
  assert.equal(merged.length, 4)
  assert.ok(merged.every(item => item.kind === 'app'))
  const mixed = mergeResults(matchApps(apps, 'e'), hits, 3)
  assert.deepEqual(mixed.map(item => item.kind === 'app' ? item.id : item.path), ['editor', 'terminal', '/home/pi/notes.txt'])
  const filesOnly = mergeResults([], hits, 12)
  assert.deepEqual(filesOnly.map(item => item.kind), ['file', 'file'])
})

test('keyboard selection wraps and survives an empty list', () => {
  assert.equal(step(0, 1, 3), 1)
  assert.equal(step(2, 1, 3), 0)
  assert.equal(step(0, -1, 3), 2)
  assert.equal(step(0, 1, 0), 0)
})

test('choosing a result opens the right app with the right props', () => {
  const handler = path => path.endsWith('.png') ? 'image' : 'editor'
  assert.deepEqual(actionFor({ kind: 'app', id: 'terminal', title: 'Terminal', icon: '' }, false, handler), { appId: 'terminal', props: {} })
  assert.deepEqual(actionFor({ kind: 'file', ...file('/home/pi/shot.png') }, false, handler), { appId: 'image', props: { path: '/home/pi/shot.png' } })
  assert.deepEqual(actionFor({ kind: 'file', ...file('/home/pi/projects', true) }, false, handler), { appId: 'files', props: { path: '/home/pi/projects' } })
  // Reveal: the file's folder in Files, never the file itself.
  assert.deepEqual(actionFor({ kind: 'file', ...file('/home/pi/notes.txt') }, true, handler), { appId: 'files', props: { path: '/home/pi' } })
  assert.deepEqual(actionFor({ kind: 'file', ...file('/top') }, true, handler), { appId: 'files', props: { path: '/' } })
})
