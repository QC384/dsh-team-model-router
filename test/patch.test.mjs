import test from 'node:test'
import assert from 'node:assert/strict'
import { installRouteInterception, patchMethod } from '../lib/patch.js'
import { createPendingRoutes } from '../lib/pending.js'

const PARENT = { id: 'lead-1' }

/** Minimal stand-in for the host's subagents service. */
function fakeSubagents() {
  return {
    calls: [],
    async startContinuable(spec) {
      this.calls.push(spec)
      return { childId: 'child-1', messageId: 'msg-1' }
    },
    async start(provider, request) {
      this.calls.push({ provider, request })
      return { runId: 'run-1' }
    },
  }
}

function route(provider, model) {
  return { provider, model }
}

test('injects agentOptions into startContinuable when a rule matches', async () => {
  const subagents = fakeSubagents()
  const dispose = installRouteInterception({
    subagents,
    pending: createPendingRoutes({}),
    resolve: ({ label }) => (label === 'coder' ? route('qwen', 'qwen3-coder') : null),
  })
  try {
    await subagents.startContinuable({
      provider: 'spawn',
      label: 'coder',
      request: { prompt: [], parent: PARENT },
      signal: new AbortController().signal,
    })
  } finally {
    dispose()
  }
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'qwen', model: 'qwen3-coder' })
})

test('leaves the call untouched when no rule matches', async () => {
  const subagents = fakeSubagents()
  const dispose = installRouteInterception({
    subagents,
    pending: createPendingRoutes({}),
    resolve: () => null,
  })
  const spec = { provider: 'spawn', label: 'reviewer', request: { prompt: [], parent: PARENT }, signal: new AbortController().signal }
  try {
    await subagents.startContinuable(spec)
  } finally {
    dispose()
  }
  assert.equal(subagents.calls[0], spec)
  assert.equal(spec.request.agentOptions, undefined)
})

test('never overrides an explicit route the caller already declared', async () => {
  const subagents = fakeSubagents()
  const dispose = installRouteInterception({
    subagents,
    pending: createPendingRoutes({}),
    resolve: () => route('qwen', 'qwen3-coder'),
  })
  const explicit = { provider: 'openai', model: 'gpt-5' }
  try {
    await subagents.startContinuable({
      provider: 'spawn',
      label: 'coder',
      request: { prompt: [], parent: PARENT, agentOptions: explicit },
      signal: new AbortController().signal,
    })
  } finally {
    dispose()
  }
  assert.deepEqual(subagents.calls[0].request.agentOptions, explicit)
})

test('parks the name-aware route from spawnTeammate for the inner continuable start', async () => {
  const subagents = fakeSubagents()
  const pending = createPendingRoutes({})
  const teams = {
    async spawnTeammate(caller, request) {
      await subagents.startContinuable({
        provider: 'spawn',
        label: request.description,
        request: { prompt: [], parent: caller },
        signal: new AbortController().signal,
      })
      return { member: { name: request.name } }
    },
  }
  const dispose = installRouteInterception({
    subagents,
    teams,
    pending,
    resolve: ({ name }) => (name === 'coder' ? route('qwen', 'qwen3-coder') : null),
  })
  try {
    await teams.spawnTeammate(PARENT, { name: 'coder', description: 'owns the parser', prompt: [], context: 'fresh' })
  } finally {
    dispose()
  }
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'qwen', model: 'qwen3-coder' })
  assert.equal(pending.size, 0, 'hand-off entry must not leak after the spawn settles')
})

test('a failed spawn drops the parked route instead of leaking it', async () => {
  const subagents = fakeSubagents()
  const pending = createPendingRoutes({})
  const teams = {
    async spawnTeammate() {
      throw new Error('spawn denied')
    },
  }
  const dispose = installRouteInterception({ subagents, teams, pending, resolve: () => route('p', 'm') })
  try {
    await assert.rejects(teams.spawnTeammate(PARENT, { name: 'coder', description: 'x', prompt: [], context: 'fresh' }))
  } finally {
    dispose()
  }
  assert.equal(pending.size, 0)
})

test('one-shot start also accepts an injected route', async () => {
  const subagents = fakeSubagents()
  const dispose = installRouteInterception({
    subagents,
    pending: createPendingRoutes({}),
    resolve: () => route('p', 'm'),
  })
  try {
    await subagents.start('spawn', { prompt: [], parent: PARENT })
  } finally {
    dispose()
  }
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'p', model: 'm' })
})

test('dispose restores the original method and leaves a later wrapper alone', async () => {
  const subagents = fakeSubagents()
  const original = subagents.startContinuable
  const dispose = installRouteInterception({ subagents, pending: createPendingRoutes({}), resolve: () => null })
  assert.notEqual(subagents.startContinuable, original)
  dispose()
  assert.equal(subagents.startContinuable, original)

  // A second plugin wrapping afterwards must not be reverted by our disposer.
  const later = () => {}
  const patched = patchMethod(subagents, 'startContinuable', () => later)
  dispose()
  assert.equal(subagents.startContinuable, later)
  patched()
})
