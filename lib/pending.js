/**
 * One-shot hand-off from `agentTeams.spawnTeammate(name, ...)` to the inner
 * `subagents.startContinuable({ childId, request })` call, where a route can
 * actually be injected (`request.agentOptions`).
 *
 * The hand-off is keyed by `parent` + `label` because the official layer turns
 * the teammate name into `label: description` before starting the child. Entries
 * expire so a failed spawn cannot leak a route onto a later, unrelated child.
 *
 * @module dsh-team-model-router/pending
 */

const DEFAULT_TTL_MS = 120_000

/**
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createPendingRoutes(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? (() => Date.now())
  /** @type {Map<string, { route: object, expires: number }>} */
  const routes = new Map()

  const keyOf = (parent, label) => `${parent}\u0000${label}`

  return {
    /**
     * @param {unknown} parent
     * @param {string} label
     * @param {{ provider: string, model: string }} route
     */
    put(parent, label, route) {
      routes.set(keyOf(parent, label), { route, expires: now() + ttlMs })
    },
    /**
     * Consume the route once; returns null when absent or expired.
     * @param {unknown} parent
     * @param {string} label
     */
    take(parent, label) {
      const key = keyOf(parent, label)
      const entry = routes.get(key)
      if (entry === undefined) return null
      routes.delete(key)
      return entry.expires < now() ? null : entry.route
    },
    /** @param {unknown} parent @param {string} label */
    drop(parent, label) {
      routes.delete(keyOf(parent, label))
    },
    clear() {
      routes.clear()
    },
    size() {
      return routes.size
    },
  }
}
