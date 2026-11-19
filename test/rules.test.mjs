import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALL_MEMBERS,
  describeRoute,
  matchRule,
  normalizeRoute,
  normalizeState,
  resolveRoute,
  routeState,
} from '../lib/rules.js'
import { readRules, writeRules } from '../lib/store.js'

test('normalizeRoute requires provider and model together', () => {
  assert.equal(normalizeRoute('deepseek-v4', 'x').route, null)
  assert.deepEqual(normalizeRoute({ provider: 'deepseek', model: 'deepseek-v4' }, 'x').route, {
    provider: 'deepseek',
    model: 'deepseek-v4',
  })
  const providerOnly = normalizeRoute({ provider: 'deepseek' }, 'x')
  assert.equal(providerOnly.route, null)
  assert.match(providerOnly.diagnostics[0], /inherit/)
})

test('normalizeState drops bad entries and keeps the rest', () => {
  const { state, diagnostics } = normalizeState({
    defaults: { provider: 'deepseek', model: 'deepseek-v4' },
    members: {
      coder: { provider: 'qwen', model: 'qwen3-coder' },
      broken: { model: 'only-a-model' },
    },
  })
  assert.deepEqual(state.defaults, { provider: 'deepseek', model: 'deepseek-v4' })
  assert.deepEqual(Object.keys(state.members), ['coder'])
  assert.equal(diagnostics.length, 1)
})

test('exact member rule wins over a wildcard', () => {
  const state = normalizeState({
    members: {
      '*': { provider: 'p', model: 'default-model' },
      coder: { provider: 'p', model: 'coder-model' },
    },
  }).state
  assert.deepEqual(matchRule(state, 'coder'), { name: 'coder', route: { provider: 'p', model: 'coder-model' } })
  assert.deepEqual(matchRule(state, 'reviewer'), { name: '*', route: { provider: 'p', model: 'default-model' } })
  assert.equal(matchRule(state, ''), null)
})

test('glob patterns match and are case-insensitive', () => {
  const state = normalizeState({ members: { 'test-*': { provider: 'p', model: 'm' } } }).state
  assert.equal(matchRule(state, 'Test-Runner').name, 'test-*')
  assert.equal(matchRule(state, 'coder'), null)
})

test('resolveRoute prefers member rule, then default, then inherit', () => {
  const state = normalizeState({
    defaults: { provider: 'p', model: 'default' },
    members: { coder: { provider: 'p', model: 'coder' } },
  }).state
  assert.deepEqual(resolveRoute(state, { name: 'coder' }), { route: { provider: 'p', model: 'coder' }, source: 'member' })
  assert.deepEqual(resolveRoute(state, { name: 'reviewer' }), { route: { provider: 'p', model: 'default' }, source: 'default' })
  const empty = normalizeState({}).state
  assert.deepEqual(resolveRoute(empty, { name: 'x' }), { route: null, source: 'inherit' })
})

test('routeState detects a snapshot that no longer matches', () => {
  const leader = { provider: 'deepseek', model: 'deepseek-v4' }
  assert.equal(routeState({ provider: 'deepseek', model: 'deepseek-v4' }, leader), 'match')
  assert.equal(routeState({ provider: 'deepseek', model: 'deepseek-v3' }, leader), 'stale')
  assert.equal(routeState({}, leader), 'unknown')
  assert.equal(routeState({ model: 'deepseek-v4' }, null), 'unknown')
})

test('describeRoute names inheritance instead of printing null', () => {
  assert.equal(describeRoute(null), 'inherit (leader route)')
  assert.equal(describeRoute({ provider: 'p', model: 'm' }), 'p/m')
})

test('rules file round-trips atomically and tolerates a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmr-'))
  const path = join(dir, 'nested', 'rules.json')
  try {
    const missing = await readRules(path)
    assert.equal(missing.existed, false)
    const state = normalizeState({ members: { coder: { provider: 'p', model: 'm' } } }).state
    await writeRules(path, state)
    const read = await readRules(path)
    assert.deepEqual(read.state, state)
    const text = await readFile(path, 'utf8')
    assert.ok(text.endsWith('\n'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ALL_MEMBERS is the documented default marker', () => {
  assert.equal(ALL_MEMBERS, '*')
})
