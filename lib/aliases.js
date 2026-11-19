/**
 * Model aliases: short names the user actually types (`v4`, `coder`) mapped to
 * a `{provider, model}` route. Aliases are presentation sugar — they never
 * bypass route validation.
 *
 * @module dsh-team-model-router/aliases
 */

/**
 * @param {unknown} input raw alias map from settings or config
 * @returns {{ aliases: Record<string, { provider: string, model: string }>, diagnostics: string[] }}
 */
export function normalizeAliases(input) {
  /** @type {Record<string, { provider: string, model: string }>} */
  const aliases = {}
  /** @type {string[]} */
  const diagnostics = []
  if (input === undefined || input === null) return { aliases, diagnostics }
  if (typeof input !== 'object' || Array.isArray(input)) {
    diagnostics.push('aliases must be an object of name -> "provider/model" or { provider, model }')
    return { aliases, diagnostics }
  }
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      diagnostics.push(`alias "${rawName}" is not a valid alias name (letters, digits, . _ -)`)
      continue
    }
    /** @type {string} */
    let provider = ''
    /** @type {string} */
    let model = ''
    if (typeof rawValue === 'string') {
      const slash = rawValue.indexOf('/')
      if (slash < 1 || slash === rawValue.length - 1) {
        diagnostics.push(`alias "${rawName}" must be "provider/model"`)
        continue
      }
      provider = rawValue.slice(0, slash).trim()
      model = rawValue.slice(slash + 1).trim()
    } else if (typeof rawValue === 'object' && rawValue !== null) {
      const candidate = /** @type {{ provider?: unknown, model?: unknown }} */ (rawValue)
      provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
      model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
    } else {
      diagnostics.push(`alias "${rawName}" has an unsupported value type`)
      continue
    }
    if (provider === '' || model === '') {
      diagnostics.push(`alias "${rawName}" needs a non-empty provider and model`)
      continue
    }
    aliases[name] = { provider, model }
  }
  return { aliases, diagnostics }
}

/**
 * Resolve one user token into a route. Accepts an alias name, or the
 * `provider/model` shorthand, and returns `null` when neither applies.
 * @param {string} token
 * @param {Record<string, { provider: string, model: string }>} aliases
 * @returns {{ provider: string, model: string } | null}
 */
export function resolveToken(token, aliases) {
  const text = typeof token === 'string' ? token.trim() : ''
  if (text === '') return null
  const alias = aliases[text.toLowerCase()]
  if (alias !== undefined) return { ...alias }
  const slash = text.indexOf('/')
  if (slash > 0 && slash < text.length - 1) {
    const provider = text.slice(0, slash).trim()
    const model = text.slice(slash + 1).trim()
    if (provider !== '' && model !== '') return { provider, model }
  }
  return null
}
