/**
 * Rules: which member gets which default route.
 *
 * DSH routing is exact-or-inherited: provider and model must be supplied
 * together, otherwise the host ignores the pair and the child inherits the
 * lead. Everything here enforces that, plus `*` / `?` wildcards.
 *
 * @module dsh-team-model-router/rules
 */

export const ALL_MEMBERS = '*'

/**
 * @param {unknown} value
 * @returns {{ provider: string, model: string } | null}
 */
export function normalizeRoute(value) {
  if (value === null || typeof value !== 'object') return null
  const provider = value.provider
  const model = value.model
  if (typeof provider !== 'string' || provider.trim() === '') return null
  if (typeof model !== 'string' || model.trim() === '') return null
  return { provider: provider.trim(), model: model.trim() }
}

/**
 * @param {unknown} value
 */
export function normalizeState(value) {
  const state = { members: {}, defaultRoute: null }
  if (value === null || typeof value !== 'object') return state
  if (value.members !== null && typeof value.members === 'object') {
    for (const [name, route] of Object.entries(value.members)) {
      if (typeof name !== 'string' || name.trim() === '') continue
      const normalized = normalizeRoute(route)
      if (normalized !== null) state.members[name.trim()] = normalized
    }
  }
  state.defaultRoute = normalizeRoute(value.defaultRoute)
  return state
}

const escapeRegExp = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/**
 * Turn `coder-*` into a matcher. Exact names always beat wildcards.
 * @param {string} pattern
 */
export function toMatcher(pattern) {
  const source = escapeRegExp(pattern).replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${source}$`, 'i')
}

/**
 * Exact match first, then the most specific wildcard.
 * @param {Record<string, {provider: string, model: string}>} members
 * @param {string} name
 */
export function matchRule(members, name) {
  if (members[name] !== undefined) return { pattern: name, route: members[name] }
  const patterns = Object.keys(members).filter((pattern) => pattern.includes('*') || pattern.includes('?')).sort((a, b) => b.length - a.length)
  for (const pattern of patterns) {
    if (toMatcher(pattern).test(name)) return { pattern, route: members[pattern] }
  }
  return null
}

/**
 * Resolution order: exact/wildcard member rule, then `*`, then the global default.
 * @param {{ members: Record<string, any>, defaultRoute: any }} state
 * @param {string} name
 */
export function resolveRoute(state, name) {
  const normalized = normalizeState(state)
  const matched = matchRule(normalized.members, name)
  if (matched !== null) return { ...matched.route, source: `rule:${matched.pattern}` }
  if (normalized.members[ALL_MEMBERS] !== undefined) return { ...normalized.members[ALL_MEMBERS], source: 'rule:*' }
  if (normalized.defaultRoute !== null) return { ...normalized.defaultRoute, source: 'default' }
  return null
}

/**
 * @param {{ provider?: string, model?: string } | null | undefined} observed
 * @param {{ provider: string, model: string } | null} expected
 */
export function routeState(observed, expected) {
  if (expected === null) return 'no-rule'
  if (observed === null || observed === undefined) return 'stale'
  const provider = observed.provider
  const model = observed.model
  if (provider === undefined || model === undefined) return 'partial'
  return provider === expected.provider && model === expected.model ? 'match' : 'stale'
}

/**
 * @param {{ provider: string, model: string, source?: string } | null} route
 */
export function describeRoute(route) {
  if (route === null) return 'inherit'
  const base = `${route.provider}/${route.model}`
  return route.source === undefined ? base : `${base} (${route.source})`
}
