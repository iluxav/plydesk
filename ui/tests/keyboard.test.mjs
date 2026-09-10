import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, layoutRect } from '../src/wm/windowState.ts'
import { defaults, parsePreferences, conflict, shortcutError, modifiers, META, ALT, SHIFT } from '../src/keyboard/shortcuts.ts'

const win = { id: 'editor', appId: 'editor', host: 'test', title: 'Editor', icon: '', x: 70, y: 60, w: 600, h: 420, z: 1, minimized: false, maximized: false }
const initial = () => ({ wins: [{ ...win }], topZ: 1 })
const arrange = (state, layout, deskW = 1001, deskH = 700) => reducer(state, { t: 'layout', id: win.id, layout, deskW, deskH })

test('snapping across both halves and maximize preserves the original floating bounds', () => {
  let state = arrange(initial(), 'left')
  assert.deepEqual([state.wins[0].x, state.wins[0].w], [0, 500])
  state = arrange(state, 'right')
  assert.deepEqual([state.wins[0].x, state.wins[0].w], [500, 501])
  state = arrange(state, 'maximized')
  assert.equal(state.wins[0].maximized, true)
  state = arrange(state, 'restore')
  assert.deepEqual([state.wins[0].x, state.wins[0].y, state.wins[0].w, state.wins[0].h], [70, 60, 600, 420])
  assert.equal(state.wins[0].layout, undefined)
})
test('restoring after the desktop shrinks keeps the window reachable', () => {
  const state = arrange(arrange(initial(), 'maximized'), 'restore', 400, 300)
  assert.deepEqual([state.wins[0].x, state.wins[0].y, state.wins[0].w, state.wins[0].h], [0, 0, 400, 300])
})
test('resizing a snapped window clears the layout; passive refitting preserves it', () => {
  const snapped = arrange(initial(), 'left')
  assert.equal(reducer(snapped, { t: 'geom', id: win.id, w: 400 }).wins[0].layout, 'left')
  const manual = reducer(snapped, { t: 'geom', id: win.id, w: 450, manual: true }).wins[0]
  assert.equal(manual.layout, undefined)
  assert.equal(manual.restore, undefined)
})
test('layout fills the work area without an odd-width gap or overlap', () => {
  const left = layoutRect('left', 1001, 640), right = layoutRect('right', 1001, 640)
  assert.equal(left.w, right.x)
  assert.equal(right.x + right.w, 1001)
  assert.equal(right.h, 640)
})
test('custom and removed shortcuts survive serialization; malformed preferences recover', () => {
  const preferences = defaults()
  preferences.bindings['snap-left'] = { code: 'KeyH', modifiers: META | ALT | SHIFT }
  preferences.bindings.minimize = null
  preferences.captureSystem = true
  assert.deepEqual(parsePreferences(JSON.stringify(preferences)), preferences)
  assert.deepEqual(parsePreferences('{broken'), defaults())
})
test('conflicts are detected and duplicate stored shortcuts cannot trigger two actions', () => {
  const preferences = defaults()
  const shortcut = preferences.bindings['snap-left']
  assert.equal(conflict(preferences.bindings, 'snap-right', shortcut).id, 'snap-left')
  preferences.bindings['snap-right'] = shortcut
  assert.equal(parsePreferences(JSON.stringify(preferences)).bindings['snap-right'], null)
})
test('matching uses physical codes with exact modifiers; plain text and quit stay reserved', () => {
  assert.equal(modifiers({ metaKey: true, altKey: true, ctrlKey: false, shiftKey: false }), META | ALT)
  assert.notEqual(shortcutError({ code: 'KeyA', modifiers: 0 }), '')
  assert.notEqual(shortcutError({ code: 'KeyQ', modifiers: META }), '')
  assert.equal(shortcutError({ code: 'Tab', modifiers: META | SHIFT }), '')
})
