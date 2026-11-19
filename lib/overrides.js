/**
 * Turn-scoped model overrides.
 *
 * One member's route can change for a single task without touching its
 * creation snapshot: the host exposes a mutable `ModelSelectionRef` per live
 * Agent (`installModelSelection`), applied at prompt assembly. This module is
 * the pure state machine that decides WHEN the ref is set and WHEN it is
 * cleared again, so the timing rules are testable without a harness.
 *
 * @module dsh-team-model-router/overrides
 */

/** @typedef {{ provider: string, model: string, reasoningEffort?: string }} Selection */
/** @typedef {'next-turn' | 'sticky'} OverrideScope */
/** @typedef {{ selection: Selection, scope: OverrideScope, applied: boolean, queued: { selection: Selection, scope: OverrideScope } | null }} OverrideState */

/**
 * @returns {{
 *   request: (id: string, selection: Selection, scope: OverrideScope) => OverrideState,
 *   has: (id: string) => boolean,
 *   get: (id: string) => OverrideState | undefined,
 *   onTurnStart: (id: string) => Selection | null,
 *   onTurnEnd: (id: string) => boolean,
 *   clear: (id: string) => void,
 *   entries: () => Array<[string, OverrideState]>,
 *   size: () => number,
 * }}
 */
export function createOverrideBook() {
  /** @type {Map<string, OverrideState>} */
  const states = new Map()

  return {
    /**
     * A request that arrives while a turn is already running is queued for the
     * following turn instead of rewriting the assembled one.
     */
    request(id, selection, scope) {
      const existing = states.get(id)
      if (existing !== undefined && existing.applied) {
        existing.queued = { selection, scope }
        return existing
      }
      const state = { selection, scope, applied: false, queued: null }
      states.set(id, state)
      return state
    },
    has(id) {
      return states.has(id)
    },
    get(id) {
      return states.get(id)
    },
    /**
     * Called on the member's `turn/start`. Returns the selection to install now,
     * or null when there is nothing pending.
     */
    onTurnStart(id) {
      const state = states.get(id)
      if (state === undefined) return null
      if (state.applied) {
        if (state.queued === null) return null
        state.selection = state.queued.selection
        state.scope = state.queued.scope
        state.queued = null
        return state.selection
      }
      state.applied = true
      return state.selection
    },
    /**
     * Called on the member's `turn/end`. Returns true when the caller must clear
     * the live selection (a one-task override just finished). A queued request
     * survives as the next turn's unapplied state.
     */
    onTurnEnd(id) {
      const state = states.get(id)
      if (state === undefined || !state.applied) return false
      if (state.scope === 'sticky') return false
      if (state.queued !== null) {
        states.set(id, { selection: state.queued.selection, scope: state.queued.scope, applied: false, queued: null })
      } else {
        states.delete(id)
      }
      return true
    },
    clear(id) {
      states.delete(id)
    },
    entries() {
      return [...states.entries()]
    },
    size() {
      return states.size
    },
  }
}
