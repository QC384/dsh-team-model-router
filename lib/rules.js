/**
 * Pure rule model for team member routes.
 *
 * DSH routing is exact-or-inherited: a child runs on its declared route only
 * when BOTH `provider` and `model` are declared and resolve against the live
 * LLM adapter. A bare model id, a `provider/model` string, or a lone provider
 * is ignored by the host, so this module refuses those shapes up front instead
 * of writing a rule that would silently do nothing.
 *
 * @module dsh-team-model-router/rules
 */

/** @typedef {{ provider: string, model: string }} Route */
/** @typedef {{ version: number, defaults: Route | null, members: Record<string, Route> }} RuleState */

export const RULE_VERSION = 1

/** Marker used by tools to address the default route for unlisted members. */
export const ALL_MEMBERS = '*'

/**
 * Turn one untrusted declared value into a Route, or a diagnostic.
 * @param {unknown} value
 * @param {string} where
 * @returns {{ route: Route | null, diagnostics: string[] }}
 */
export function normalizeRoute(value, where) {
  const diagnostics = []
  if (typeof value === 'string') {
    diagnostics.push(`${where}: ignored a bare string; declare provider and model together`)
    return { route: null, diagnostics }
  }
  if (typeof value !== 'object' || value === null) {
    diagnostics.push(`${where}: ignored a non-object route`)
    return { route: null, diagnostics }
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' && model === '') return { route: null, diagnostics }
  if (provider === '') {
    diagnostics.push(`${where}: model without provider is ignored (would inherit instead)`)
    return { route: null, diagnostics }
  }
  if (model === '') {
    diagnostics.push(`${where}: provider without model is ignored (would inherit instead)`)
    return { route: null, diagnostics }
  }
  if (model.includes('/') && !model.includes(' ')) {
    // A model id may legally contain "/", but a "provider/model" string is the
    // classic silent-no-op shape. Warn without rejecting.
    diagnostics.push(`${where}: model id "${model}" contains "/"; make sure it is a model id, not a provider/model pair`)
  }
  return { route: { provider, model }, diagnostics }
}

/**
 * Validate and detach persisted rule state.
 * @param {unknown} raw
 * @returns {{ state: RuleState, diagnostics: string[] }}
 */
export function normalizeState(raw) {
  const diagnostics = []
  /** @type {RuleState} */
  const state = { version: RULE_VERSION, defaults: null, members: {} }
  if (typeof raw !== 'object' || raw === null) {
    if (raw !== undefined) diagnostics.push('rules: root is not an object; starting empty')
    return { state, diagnostics }
  }
  const source = /** @type {Record<string, unknown>} */ (raw)
  if (source.defaults !== undefined && source.defaults !== null && source.defaults !== 'inherit') {
    const normalized = normalizeRoute(source.defaults, 'rules.defaults')
    diagnostics.push(...normalized.diagnostics)
    state.defaults = normalized.route
  }
  if (source.members !== undefined) {
    if (typeof source.members !== 'object' || source.members === null) {
      diagnostics.push('rules.members: not an object; ignored')
    } else {
      for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (source.members))) {
        if (value === null || value === undefined || value === 'inherit') continue
        const normalized = normalizeRoute(value, `rules.members.${name}`)
        diagnostics.push(...normalized.diagnostics)
        if (normalized.route !== null) state.members[name] = normalized.route
      }
    }
  }
  return { state, diagnostics }
}

/**
 * Compile a member pattern to a RegExp. Supports `*` and `?`, nothing else.
 * @param {string} pattern
 * @returns {RegExp}
 */
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\?/g, '?')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * Match one name against the rule table: exact name first, then wildcard
 * patterns, so `*` never shadows an explicit member.
 * @param {RuleState} state
 * @param {string} name
 * @returns {{ name: string, route: Route } | null}
 */
export function matchRule(state, name) {
  if (name === '') return null
  if (Object.hasOwn(state.members, name)) return { name, route: state.members[name] }
  for (const [pattern, route] of Object.entries(state.members)) {
    if (!pattern.includes('*') && !pattern.includes('?')) continue
    if (patternToRegExp(pattern).test(name)) return { name: pattern, route }
  }
  return null
}

/**
 * Resolve the route a child should start on.
 *
 * Precedence: pending hand-off from `spawnTeammate` > declared member route >
 * default route > inherit (null).
 *
 * @param {RuleState} state
 * @param {{ name?: string }} target
 * @returns {{ route: Route | null, source: 'pending' | 'member' | 'default' | 'inherit' }}
 */
export function resolveRoute(state, target) {
  const name = typeof target.name === 'string' ? target.name.trim() : ''
  if (name !== '') {
    const matched = matchRule(state, name)
    if (matched !== null) return { route: matched.route, source: 'member' }
  }
  if (state.defaults !== null) return { route: state.defaults, source: 'default' }
  return { route: null, source: 'inherit' }
}

/**
 * Human-readable route, safe for null.
 * @param {Route | null} route
 * @returns {string}
 */
export function describeRoute(route) {
  return route === null ? 'inherit (leader route)' : `${route.provider}/${route.model}`
}

/**
 * Compare a member's observed route with the route it should be running.
 * @param {{ model?: string, provider?: string }} observed
 * @param {Route | null} expected
 * @returns {'match' | 'stale' | 'unknown'}
 */
export function routeState(observed, expected) {
  const model = typeof observed.model === 'string' ? observed.model.trim() : ''
  if (model === '' || expected === null) return 'unknown'
  const provider = typeof observed.provider === 'string' ? observed.provider.trim() : ''
  const sameModel = model === expected.model
  const sameProvider = provider === '' || provider === expected.provider
  return sameModel && sameProvider ? 'match' : 'stale'
}
