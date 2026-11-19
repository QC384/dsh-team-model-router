import test from 'node:test'
import assert from 'node:assert/strict'
import { createOverrideBook } from '../lib/overrides.js'

const coder = { provider: 'qwen', model: 'qwen3-coder' }
const reviewer = { provider: 'deepseek', model: 'deepseek-v4' }

test('a one-task override applies on the next turn and clears at its end', () => {
  const book = createOverrideBook()
  book.request('m1', coder, 'next-turn')
  assert.equal(book.onTurnStart('m1').model, 'qwen3-coder')
  assert.equal(book.onTurnStart('m1'), null, 'must not re-apply inside the same turn')
  assert.equal(book.onTurnEnd('m1'), true, 'one-task override must ask for a revert')
  assert.equal(book.has('m1'), false)
  assert.equal(book.onTurnStart('m1'), null)
})

test('a request arriving mid-turn is queued and the running turn keeps its route', () => {
  const book = createOverrideBook()
  book.request('m1', coder, 'next-turn')
  book.onTurnStart('m1') // turn 1 assembled on coder
  book.request('m1', reviewer, 'next-turn') // arrives while turn 1 runs
  assert.equal(book.get('m1').selection.model, 'qwen3-coder', 'running turn must not be rewritten')
  assert.equal(book.get('m1').queued.selection.model, 'deepseek-v4')

  assert.equal(book.onTurnEnd('m1'), true, 'turn 1 reverts to the member route')
  assert.equal(book.has('m1'), true, 'the queued request survives for turn 2')
  assert.equal(book.get('m1').applied, false)

  assert.equal(book.onTurnStart('m1').model, 'deepseek-v4', 'turn 2 uses the queued model')
  assert.equal(book.onTurnEnd('m1'), true)
  assert.equal(book.has('m1'), false)
})

test('sticky overrides survive turn ends until cleared', () => {
  const book = createOverrideBook()
  book.request('m1', coder, 'sticky')
  book.onTurnStart('m1')
  assert.equal(book.onTurnEnd('m1'), false)
  assert.equal(book.has('m1'), true)
  book.clear('m1')
  assert.equal(book.has('m1'), false)
})

test('an override that never started a turn cannot revert anything', () => {
  const book = createOverrideBook()
  book.request('m1', coder, 'next-turn')
  assert.equal(book.onTurnEnd('m1'), false)
})

test('per-member state stays isolated', () => {
  const book = createOverrideBook()
  book.request('a', coder, 'next-turn')
  book.request('b', reviewer, 'sticky')
  assert.equal(book.entries().length, 2)
  assert.equal(book.onTurnStart('b').model, 'deepseek-v4')
  assert.equal(book.get('a').applied, false)
})

test('a sticky override can still be replaced at the next turn boundary', () => {
  const book = createOverrideBook()
  book.request('m1', coder, 'sticky')
  book.onTurnStart('m1')
  book.request('m1', reviewer, 'next-turn')
  assert.equal(book.onTurnStart('m1').model, 'deepseek-v4')
  assert.equal(book.onTurnEnd('m1'), true, 'the replacement scope is next-turn')
})
