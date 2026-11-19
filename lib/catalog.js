/**
 * Read-only view over the host LLM registry (`ctx.get('llm')`).
 *
 * The registry is the only honest source for "which providers and models exist
 * here". Provider membership is authoritative for routing (a missing provider
 * makes the request fail), while model catalog membership is advisory by
 * contract — the adapter may accept unlisted ids — so this module never turns
 * "not listed" into a rejection.
 *
 * @module dsh-team-model-router/catalog
 */

/**
 * @param {any} llm the LlmService, or undefined when the host does not mount it
 */
export function createCatalog(llm) {
  /** @type {Map<string, { at: number, models: Array<{ id: string, name: string }> }>} */
  const modelCache = new Map()
  const cacheTtlMs = 60_000

  function available() {
    return llm !== undefined && llm !== null && typeof llm.listProviders === 'function'
  }

  function providers() {
    if (!available()) return []
    try {
      return llm.listProviders().map((entry) => ({ id: String(entry.id), name: String(entry.name) }))
    } catch {
      return []
    }
  }

  /**
   * @param {string} provider
   * @returns {Promise<{ models: Array<{ id: string, name: string }>, diagnostic: string }>}
   */
  async function models(provider) {
    if (!available()) return { models: [], diagnostic: 'llm service is not mounted' }
    const cached = modelCache.get(provider)
    if (cached !== undefined && Date.now() - cached.at < cacheTtlMs) return { models: cached.models, diagnostic: '' }
    try {
      const list = await llm.listModels(provider)
      const models = list.map((entry) => ({ id: String(entry.id), name: String(entry.name) }))
      modelCache.set(provider, { at: Date.now(), models })
      return { models, diagnostic: '' }
    } catch (error) {
      const code = /** @type {any} */ (error)?.code
      const message = typeof code === 'string' ? `${code}: ${/** @type {any} */ (error).message}` : String(error)
      return { models: [], diagnostic: `cannot list models for "${provider}": ${message}` }
    }
  }

  /**
   * Check one candidate route without changing anything.
   * @param {{ provider: string, model: string }} route
   * @returns {Promise<{ status: 'ok' | 'unavailable' | 'unknown-provider' | 'unlisted-model', note: string }>}
   */
  async function verify(route) {
    if (!available()) return { status: 'unavailable', note: 'llm service is not mounted; route not verified' }
    const known = providers()
    if (known.length === 0) return { status: 'unavailable', note: 'llm registry reports no providers; route not verified' }
    if (!known.some((entry) => entry.id === route.provider)) {
      return { status: 'unknown-provider', note: `provider "${route.provider}" is not registered (known: ${known.map((e) => e.id).join(', ')})` }
    }
    const listed = await models(route.provider)
    if (listed.diagnostic !== '') return { status: 'unavailable', note: listed.diagnostic }
    const ids = listed.models.map((model) => model.id)
    if (ids.length === 0) return { status: 'ok', note: `provider "${route.provider}" advertises no catalog; model id is passed through` }
    if (!ids.includes(route.model)) {
      return { status: 'unlisted-model', note: `model "${route.model}" is not in the "${route.provider}" catalog (advisory only; the request may still work)` }
    }
    return { status: 'ok', note: '' }
  }

  /**
   * @returns {Promise<string>} human-readable catalog, or an explanation
   */
  async function describe() {
    if (!available()) return 'llm service is not mounted in this DSH profile; model catalog unavailable.'
    const known = providers()
    if (known.length === 0) return 'llm registry reports no registered providers.'
    /** @type {string[]} */
    const lines = []
    for (const entry of known) {
      const listed = await models(entry.id)
      lines.push(`${entry.id} (${entry.name})`)
      if (listed.diagnostic !== '') {
        lines.push(`  ! ${listed.diagnostic}`)
        continue
      }
      if (listed.models.length === 0) {
        lines.push('  (no catalog advertised; any model id is passed through)')
        continue
      }
      for (const model of listed.models) lines.push(`  - ${model.id}${model.name === model.id ? '' : `  (${model.name})`}`)
    }
    return lines.join('\n')
  }

  return { available, providers, models, verify, describe }
}
