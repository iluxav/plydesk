import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, initialState } from '../src/wm/windowState.ts'
import { paneIds, tileRects, layoutRects } from '../src/wm/tiling.ts'

const HOST = 'me@box', AREA = { deskW: 1200, deskH: 800 }
const win = (id, extra = {}) => ({ id, appId: 'files', host: HOST, title: id, icon: '', x: 40, y: 30, w: 600, h: 400, ...extra })
const tiling = (state, on = true, host = HOST) => reducer(state, { t: 'tiling', host, on, gap: 8, ...AREA })
const open = (state, id, extra) => reducer(state, { t: 'open', win: win(id, extra) })
const rects = state => tileRects(state.tiles[HOST], 8)
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('a floating machine is untouched: windows open where they were asked to', () => {
  const state = open(initialState, 'a')
  assert.deepEqual(state.tiles, {})
  assert.equal(state.wins[0].tiled, false)
  assert.deepEqual([state.wins[0].x, state.wins[0].y], [40, 30])
})

test('each new window takes half of the focused one, cut across its longer side', () => {
  let state = open(open(open(tiling(initialState), 'a'), 'b'), 'c')
  const layout = state.tiles[HOST].layout
  assert.deepEqual(paneIds(layout), ['a', 'b', 'c'])
  // 1200x800 is wide, so a|b; b's half is 600x800, tall, so b over c.
  assert.equal(layout.axis, 'row')
  assert.equal(layout.second.axis, 'column')
  const r = rects(state)
  assert.deepEqual(r.a, { x: 8, y: 8, w: 588, h: 784 })
  assert.deepEqual(r.b, { x: 604, y: 8, w: 588, h: 388 })
  assert.deepEqual(r.c, { x: 604, y: 404, w: 588, h: 388 })
  // Focus decides who is split, not opening order.
  state = open(reducer(state, { t: 'focus', id: 'a' }), 'd')
  assert.deepEqual(paneIds(state.tiles[HOST].layout), ['a', 'd', 'b', 'c'])
})

test('tiles never overlap and the gap between them equals the gap at the edge', () => {
  let state = tiling(initialState)
  for (const id of ['a', 'b', 'c', 'd', 'e']) state = open(state, id)
  const all = Object.values(rects(state))
  assert.equal(all.length, 5)
  for (const a of all) for (const b of all) if (a !== b) assert.equal(overlap(a, b), false)
  for (const r of all) assert.ok(r.x >= 8 && r.y >= 8 && r.x + r.w <= 1192 && r.y + r.h <= 792)
})

test('closing a tile gives its space to its sibling, and the last one leaves an empty tree', () => {
  let state = open(open(open(tiling(initialState), 'a'), 'b'), 'c')
  state = reducer(state, { t: 'close', id: 'b' })
  assert.deepEqual(rects(state).c, { x: 604, y: 8, w: 588, h: 784 })
  state = reducer(reducer(state, { t: 'close', id: 'a' }), { t: 'close', id: 'c' })
  assert.equal(state.tiles[HOST].layout, null)
  assert.deepEqual(rects(open(state, 'z')).z, { x: 8, y: 8, w: 1184, h: 784 })
})

test('minimizing frees the space and restoring splits the focused tile again, with unique split ids', () => {
  let state = open(open(open(tiling(initialState), 'a'), 'b'), 'c')
  state = reducer(state, { t: 'minimize', id: 'b' })
  assert.deepEqual(paneIds(state.tiles[HOST].layout), ['a', 'c'])
  state = reducer(state, { t: 'focus', id: 'b' })
  assert.deepEqual(paneIds(state.tiles[HOST].layout), ['a', 'c', 'b'])
  assert.equal(state.wins.find(w => w.id === 'b').minimized, false)
  const ids = layoutRects(state.tiles[HOST].layout).dividers.map(d => d.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('float apps stay floating on a tiling machine and machines tile independently', () => {
  let state = open(open(tiling(initialState), 'a'), 'prefs', { float: true })
  assert.equal(state.wins.find(w => w.id === 'prefs').tiled, false)
  assert.deepEqual(paneIds(state.tiles[HOST].layout), ['a'])
  state = open(state, 'other', { host: 'me@elsewhere' })
  assert.equal(state.wins.find(w => w.id === 'other').tiled, false)
  assert.deepEqual(paneIds(state.tiles[HOST].layout), ['a'])
})

test('filling the pane applies to one tile at a time; snapping a tile does nothing', () => {
  let state = open(open(tiling(initialState), 'a'), 'b')
  state = reducer(state, { t: 'toggleMax', id: 'b', ...AREA })
  assert.equal(state.wins.find(w => w.id === 'b').maximized, true)
  assert.deepEqual(reducer(state, { t: 'layout', id: 'b', layout: 'left', ...AREA }), state)
  state = reducer(state, { t: 'focus', id: 'a' })
  assert.equal(state.wins.find(w => w.id === 'b').maximized, false, 'a filled tile would hide the one just focused')
  state = open(reducer(state, { t: 'toggleMax', id: 'a', ...AREA }), 'c')
  assert.equal(state.wins.some(w => w.maximized), false)
})

test('dragging a divider resizes both sides and is clamped', () => {
  let state = open(open(tiling(initialState), 'a'), 'b')
  const split = state.tiles[HOST].layout.id
  state = reducer(state, { t: 'tileResize', host: HOST, split, ratio: .25 })
  assert.equal(rects(state).a.w + rects(state).b.w, 1176)
  assert.ok(rects(state).a.w < rects(state).b.w)
  assert.equal(reducer(state, { t: 'tileResize', host: HOST, split, ratio: 0 }).tiles[HOST].layout.ratio, .12)
})

test('switching modes keeps every window where it was', () => {
  let state = open(open(open(initialState, 'a'), 'b'), 'prefs', { float: true })
  state = tiling(reducer(state, { t: 'focus', id: 'a' }))
  // Oldest first, so the focused window lands in the last split.
  assert.deepEqual(paneIds(state.tiles[HOST].layout), ['b', 'a'])
  assert.equal(state.wins.find(w => w.id === 'prefs').tiled, false)
  const before = rects(state)
  assert.equal(tiling(state), state, 'reporting the same area again changes nothing')
  assert.deepEqual(tiling({ ...state }, true).tiles, state.tiles)
  state = tiling(state, false)
  assert.equal(state.tiles[HOST], undefined)
  for (const id of ['a', 'b']) {
    const w = state.wins.find(x => x.id === id)
    assert.equal(w.tiled, false)
    assert.deepEqual({ x: w.x, y: w.y, w: w.w, h: w.h }, before[id])
  }
})

test('a pane resize re-flows tiles without touching the tree', () => {
  let state = open(open(tiling(initialState), 'a'), 'b')
  const layout = state.tiles[HOST].layout
  state = reducer(state, { t: 'tiling', host: HOST, on: true, gap: 8, deskW: 800, deskH: 600 })
  assert.equal(state.tiles[HOST].layout, layout)
  assert.deepEqual(rects(state).b, { x: 404, y: 8, w: 388, h: 584 })
})
