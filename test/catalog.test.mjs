import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog } from '../lib/catalog.js'

function fakeLlm(modelsByProvider) {
  return {
    listProviders: () => Object.entries(modelsByProvider).map(([id]) => ({ id, name: id.toUpperCase() })),
    listModels: async (provider) => {
      const entries = modelsByProvider[provider]
      if (entries === undefined) throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' })
      return entries.map((id) => ({ provider, id, name: id }))
    },
  }
}

test('catalog lists providers and models from the live registry', async () => {
  const catalog = createCatalog(fakeLlm({ deepseek: ['deepseek-v4', 'deepseek-v3'] }))
  assert.deepEqual(catalog.providers().map((entry) => entry.id), ['deepseek'])
  const listed = await catalog.models('deepseek')
  assert.deepEqual(listed.models.map((model) => model.id), ['deepseek-v4', 'deepseek-v3'])
  assert.match(await catalog.describe(), /deepseek-v4/)
})

test('verify treats a missing provider as hard and a missing model as advisory', async () => {
  const catalog = createCatalog(fakeLlm({ deepseek: ['deepseek-v4'] }))

  const good = await catalog.verify({ provider: 'deepseek', model: 'deepseek-v4' })
  assert.equal(good.status, 'ok')

  const unlisted = await catalog.verify({ provider: 'deepseek', model: 'brand-new' })
  assert.equal(unlisted.status, 'unlisted-model')
  assert.match(unlisted.note, /advisory only/)

  const unknown = await catalog.verify({ provider: 'ghost', model: 'm' })
  assert.equal(unknown.status, 'unknown-provider')
  assert.match(unknown.note, /not registered/)
})

test('no llm service and empty registries report unavailable instead of failing', async () => {
  assert.equal(createCatalog(undefined).available(), false)
  const missing = await createCatalog(undefined).verify({ provider: 'deepseek', model: 'm' })
  assert.equal(missing.status, 'unavailable')
  assert.match(await createCatalog(undefined).describe(), /not mounted/)

  const empty = createCatalog(fakeLlm({}))
  const verdict = await empty.verify({ provider: 'deepseek', model: 'm' })
  assert.equal(verdict.status, 'unavailable')
})

test('a provider that cannot list models degrades to unavailable, not to a rejection', async () => {
  const llm = {
    listProviders: () => [{ id: 'weird', name: 'Weird' }],
    listModels: async () => {
      throw Object.assign(new Error('boom'), { code: 'INVALID_CATALOG' })
    },
  }
  const verdict = await createCatalog(llm).verify({ provider: 'weird', model: 'm' })
  assert.equal(verdict.status, 'unavailable')
  assert.match(verdict.note, /INVALID_CATALOG/)
})
