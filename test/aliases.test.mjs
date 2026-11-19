import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAliases, resolveToken } from '../lib/aliases.js'

test('aliases accept "provider/model" strings and objects', () => {
  const { aliases, diagnostics } = normalizeAliases({
    V4: 'deepseek/deepseek-v4',
    coder: { provider: ' qwen ', model: ' qwen3-coder ' },
  })
  assert.deepEqual(aliases, {
    v4: { provider: 'deepseek', model: 'deepseek-v4' },
    coder: { provider: 'qwen', model: 'qwen3-coder' },
  })
  assert.deepEqual(diagnostics, [])
})

test('bad aliases are reported, never silently accepted', () => {
  const { aliases, diagnostics } = normalizeAliases({
    'bad name': 'deepseek/deepseek-v4',
    noSlash: 'deepseek',
    emptyModel: 'deepseek/',
    blank: { provider: '', model: 'm' },
    array: [],
  })
  assert.deepEqual(aliases, {})
  assert.equal(diagnostics.length, 5)
})

test('missing or non-object alias maps are tolerated', () => {
  assert.deepEqual(normalizeAliases(undefined).aliases, {})
  assert.deepEqual(normalizeAliases(null).aliases, {})
  assert.equal(normalizeAliases([1, 2]).diagnostics.length, 1)
})

test('resolveToken prefers an alias, then accepts provider/model shorthand', () => {
  const aliases = { v4: { provider: 'deepseek', model: 'deepseek-v4' } }
  assert.deepEqual(resolveToken('v4', aliases), { provider: 'deepseek', model: 'deepseek-v4' })
  assert.deepEqual(resolveToken('V4', aliases), { provider: 'deepseek', model: 'deepseek-v4' })
  assert.deepEqual(resolveToken('qwen/qwen3-coder', aliases), { provider: 'qwen', model: 'qwen3-coder' })
  assert.equal(resolveToken('mystery', aliases), null)
  assert.equal(resolveToken('', aliases), null)
  assert.equal(resolveToken('/', aliases), null)
})
