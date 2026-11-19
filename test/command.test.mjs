import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTeamCommand, renderCommandHelp } from '../lib/command.js'

test('empty input and status words render the roster view', () => {
  assert.deepEqual(parseTeamCommand(''), { kind: 'status' })
  assert.deepEqual(parseTeamCommand('   '), { kind: 'status' })
  assert.deepEqual(parseTeamCommand('status'), { kind: 'status' })
  assert.deepEqual(parseTeamCommand('list'), { kind: 'status' })
})

test('help words return usage', () => {
  for (const word of ['help', '-h', '--help']) {
    assert.equal(parseTeamCommand(word).kind, 'help')
  }
  assert.match(renderCommandHelp(), /team-model/)
})

test('bare member route is a single-task override', () => {
  assert.deepEqual(parseTeamCommand('coder deepseek deepseek-v4'), {
    kind: 'set',
    member: 'coder',
    provider: 'deepseek',
    model: 'deepseek-v4',
    scope: 'next-turn',
  })
})

test('sticky flag keeps the override', () => {
  assert.deepEqual(parseTeamCommand(' coder   sticky  qwen   qwen3-coder '), {
    kind: 'set',
    member: 'coder',
    provider: 'qwen',
    model: 'qwen3-coder',
    scope: 'sticky',
  })
})

test('effort is parsed before provider/model', () => {
  assert.deepEqual(parseTeamCommand('coder effort=high deepseek deepseek-v4'), {
    kind: 'set',
    member: 'coder',
    provider: 'deepseek',
    model: 'deepseek-v4',
    scope: 'next-turn',
    effort: 'high',
  })
})

test('clear drops the next-task override', () => {
  assert.deepEqual(parseTeamCommand('coder clear'), { kind: 'clear', member: 'coder' })
})

test('default subcommand edits the member default route', () => {
  assert.deepEqual(parseTeamCommand('default coder qwen qwen3-coder'), {
    kind: 'set-default',
    member: 'coder',
    provider: 'qwen',
    model: 'qwen3-coder',
  })
  assert.deepEqual(parseTeamCommand('default coder clear'), { kind: 'clear-default', member: 'coder' })
  assert.deepEqual(parseTeamCommand('default all clear'), { kind: 'clear-default', member: 'all' })
})

test('malformed lines fail with a usage-bearing message', () => {
  assert.equal(parseTeamCommand('coder').kind, 'error')
  assert.equal(parseTeamCommand('coder deepseek').kind, 'error')
  assert.equal(parseTeamCommand('default coder qwen').kind, 'error')
  assert.equal(parseTeamCommand('coder a b c').kind, 'error')
  assert.match(parseTeamCommand('coder').text, /用法/)
})
