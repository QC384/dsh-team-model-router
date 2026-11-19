/**
 * One-shot route hand-off between the two host seams.
 *
 * `agentTeams.spawnTeammate(caller, request)` knows the member NAME but never
 * forwards a model. The inner `subagents.startContinuable(spec)` forwards
 * `agentOptions` but only sees a free-form `label` (the description). So the
 * spawn wrapper parks the resolved route under `parent + label` and the
 * subagent wrapper claims it. Entries expire, so a failed spawn cannot leak a
 * route onto an unrelated child.
 *
 * @module dsh-team-model-router/pending
 */

/**
 * @param {{ ttlMs?: number }} [options]
 */
export function createPendingRoutes({ ttlMs = 120_000 } = {}) {
  /** @type {Map<string, { route: import('./rules.js').Route, expires: number }>} */
  const entries = new Map()

  /** @param {string} parentId @param {string} label */
  const keyOf = (parentId, label) => `${parentId}::${label}`

  function sweep(now) {
    for (const [key, entry] of entries) {
      if (entry.expires <= now) entries.delete(key)
    }
  }

  return {
    /**
     * @param {string} parentId
     * @param {string} label
     * @param {import('./rules.js').Route} route
     */
    put(parentId, label, route) {
      const now = Date.now()
      sweep(now)
      entries.set(keyOf(parentId, label), { route, expires: now + ttlMs })
    },
    /**
     * @param {string} parentId
     * @param {string} label
     * @returns {import('./rules.js').Route | null}
     */
    take(parentId, label) {
      const key = keyOf(parentId, label)
      const entry = entries.get(key)
      if (entry === undefined) return null
      entries.delete(key)
      if (entry.expires <= Date.now()) return null
      return entry.route
    },
    /** @param {string} parentId @param {string} label */
    drop(parentId, label) {
      entries.delete(keyOf(parentId, label))
    },
    clear() {
      entries.clear()
    },
    /** @returns {number} */
    get size() {
      sweep(Date.now())
      return entries.size
    },
  }
}
