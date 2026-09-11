import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableOn, closesOnExit, newShortcut } from '../src/shortcuts/model.ts'

test('web shortcuts are shared; terminal shortcuts only launch on their assigned machine', () => {
  const tui = newShortcut('tui', 'user@one')
  assert.equal(availableOn(tui, 'user@one'), true)
  assert.equal(availableOn(tui, 'user@two'), false)
  assert.equal(availableOn(newShortcut('web', 'user@one'), 'user@two'), true)
  assert.equal(availableOn(undefined, 'user@two'), true)
})

test('successful exits and interrupted commands close; failures remain available for inspection', () => {
  for (const code of [0, 130]) assert.equal(closesOnExit(code), true)
  for (const code of [1, 2, 127, 255, null, undefined]) assert.equal(closesOnExit(code), false)
})
