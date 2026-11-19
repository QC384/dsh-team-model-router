import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../lib/session-store.js'
import { createAuditLog } from '../lib/audit.js'

test('session store round-trips overrides and prunes empty conversations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmr-'))
  const file = join(dir, 'sessions.json')
  try {
    const store = createSessionStore(file)
    assert.deepEqual(await store.load(), [])

    const diagnostic = await store.set('sess-1', 'coder', {
      provider: 'deepseek', model: 'deepseek-v4', scope: 'next-turn', at: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(diagnostic, '')
    assert.equal(store.count(), 1)

    const reopened = createSessionStore(file)
    assert.deepEqual(await reopened.load(), [])
    const entry = reopened.get('sess-1').coder
    assert.deepEqual(entry, {
      provider: 'deepseek', model: 'deepseek-v4', scope: 'next-turn', at: '2026-01-01T00:00:00.000Z',
    })
    // Mutating a returned snapshot must not touch the store.
    entry.model = 'other'
    assert.equal(reopened.get('sess-1').coder.model, 'deepseek-v4')

    await reopened.set('sess-1', 'reviewer', {
      provider: 'qwen', model: 'qwen3-coder', scope: 'sticky', at: '2026-01-01T00:00:01.000Z',
    })
    await reopened.remove('sess-1', 'coder')
    assert.deepEqual(Object.keys(reopened.get('sess-1')), ['reviewer'])

    await reopened.remove('sess-1', 'reviewer')
    assert.equal(reopened.count(), 0)
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(raw.sessions, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('corrupt or unexpected session stores degrade to diagnostics, not crashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmr-'))
  const file = join(dir, 'sessions.json')
  try {
    await writeFile(file, 'not json at all', 'utf8')
    const store = createSessionStore(file)
    const diagnostics = await store.load()
    assert.equal(diagnostics.length, 1)
    assert.deepEqual(store.get('sess-1'), {})

    await writeFile(file, JSON.stringify({ sessions: { 'sess-1': { coder: { provider: 'deepseek' } } } }), 'utf8')
    const second = createSessionStore(file)
    assert.deepEqual(await second.load(), [])
    assert.deepEqual(second.get('sess-1'), {}, 'entries without a model are dropped')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('audit log appends one JSON line per entry and tails the last N', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmr-'))
  const file = join(dir, 'audit.jsonl')
  try {
    const audit = createAuditLog(file)
    const empty = await audit.tail(5)
    assert.deepEqual(empty.lines, [])

    for (const action of ['set', 'clear', 'default-set']) {
      assert.equal(await audit.append({ action, member: 'coder' }), '')
    }
    const { lines } = await audit.tail(2)
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[1]).action, 'default-set')
    assert.match(JSON.parse(lines[1]).at, /^\d{4}-\d{2}-\d{2}T/)

    const all = await audit.tail(99)
    assert.equal(all.lines.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('audit writes into an unwritable path report one diagnostic', async () => {
  const audit = createAuditLog('/dev/null/team-model-router/audit.jsonl')
  const first = await audit.append({ action: 'set' })
  assert.match(first, /audit log write failed/)
  assert.equal(await audit.append({ action: 'set' }), '', 'failure is reported once')
})
