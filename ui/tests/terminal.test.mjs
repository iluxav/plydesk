import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialWorkspace, workspaceReducer as reduce, paneIds, layoutRects, parsePins } from '../src/apps/terminal/model.ts'
import { terminalKey, TERMINAL_KEYS } from '../src/apps/terminal/shortcuts.ts'
import { MAC_CODES } from '../src/keyboard/shortcuts.ts'

test('workspace shortcuts use Command while ordinary shell control keys pass through', () => {
  const key = { code: 'KeyT', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false }
  assert.equal(terminalKey(key), 'new-tab')
  assert.equal(terminalKey({ ...key, shiftKey: true }), 'split')
  assert.equal(terminalKey({ ...key, metaKey: false, ctrlKey: true }), undefined)
  assert.equal(terminalKey({ ...key, code: 'KeyC', metaKey: false, ctrlKey: true }), undefined)
  assert.equal(terminalKey({ ...key, isComposing: true }), undefined)
  for (const shortcut of TERMINAL_KEYS) assert.equal(typeof MAC_CODES[shortcut.code], 'number')
})

test('nested splits retain existing pane identities and cover the layout without overlaps', () => {
  const original = { id: 'shell-a', cwd: '/work' }
  let state = initialWorkspace('tab-a', original)
  state = reduce(state, { type: 'split', tab: 'tab-a', pane: { id: 'shell-b', cwd: '/work' }, splitId: 'split-a', axis: 'row' })
  state = reduce(state, { type: 'split', tab: 'tab-a', pane: { id: 'shell-c', cwd: '/tmp' }, splitId: 'split-b', axis: 'column' })
  assert.strictEqual(state.panes['shell-a'], original, 'splitting must not replace an existing session seed')
  assert.deepEqual(paneIds(state.tabs[0].layout), ['shell-a', 'shell-b', 'shell-c'])
  const { panes, dividers } = layoutRects(state.tabs[0].layout)
  assert.equal(dividers.length, 2)
  assert.deepEqual(panes['shell-a'], { x: 0, y: 0, w: .5, h: 1 })
  assert.deepEqual(panes['shell-c'], { x: .5, y: .5, w: .5, h: .5 })
  assert.equal(Object.values(panes).reduce((area, p) => area + p.w * p.h, 0), 1)
  state = reduce(state, { type: 'close-pane', tab: 'tab-a', pane: 'shell-c' })
  assert.deepEqual(paneIds(state.tabs[0].layout), ['shell-a', 'shell-b'])
  assert.equal(state.tabs[0].activePane, 'shell-a')
  assert.equal(state.panes['shell-c'], undefined)
  assert.strictEqual(state.panes['shell-a'], original)
})

test('switching tabs preserves sessions; closing a tab removes only its sessions', () => {
  let state = initialWorkspace('tab-a', { id: 'pane-a' })
  state = reduce(state, { type: 'tab', id: 'tab-b', pane: { id: 'pane-b', cwd: '/projects' } })
  const saved = state.panes
  state = reduce(state, { type: 'focus', tab: 'tab-a' })
  assert.strictEqual(state.panes, saved)
  state = reduce(state, { type: 'close-tab', tab: 'tab-a' })
  assert.equal(state.activeTab, 'tab-b')
  assert.deepEqual(Object.keys(state.panes), ['pane-b'])
  state = reduce(state, { type: 'close-pane', tab: 'tab-b', pane: 'pane-b' })
  assert.deepEqual(state, { tabs: [], activeTab: '', panes: {} })
})

test('resizing stays within usable ratios, and stale pane actions do nothing', () => {
  let state = initialWorkspace('tab', { id: 'a' })
  state = reduce(state, { type: 'split', tab: 'tab', pane: { id: 'b' }, splitId: 'split', axis: 'row' })
  state = reduce(state, { type: 'resize', tab: 'tab', split: 'split', ratio: 2 })
  assert.equal(state.tabs[0].layout.ratio, .88)
  assert.strictEqual(reduce(state, { type: 'close-pane', tab: 'tab', pane: 'already-closed' }), state)
})

test('pins retain literal absolute paths while malformed or duplicate preferences are excluded', () => {
  const pin = { path: "/work/it's a $project", label: 'My project' }
  assert.deepEqual(parsePins([pin, pin, null, { path: 'relative', label: 'Bad' }, { path: '/ok', label: '' }]), [pin])
  assert.deepEqual(parsePins('invalid'), [])
})
