/**
 * Per-conversation persistence for next-task overrides.
 *
 * The host offers no arbitrary session metadata slot, so this plugin keeps its
 * own file: `$DSH_HOME/team-model-router/sessions.json`. Entries are keyed by
 * the *conversation* session id (the Team Lead's session, which teammates point
 * at through `session.meta.parentSession`) and then by member name, so they
 * survive a page reload or a harness restart where agent ids are minted again.
 *
 * @module dsh-team-model-router/session-store
 */
import { readFile } from 'node:fs/promises'
import { atomicWriteJson } from './store.js'

/**
 * @typedef {{ provider: string, model: string, reasoningEffort?: string, scope: 'next-turn' | 'sticky', at: string }} PersistedOverride
 */

/**
 * @param {string} file
 */
export function createSessionStore(file) {
  /** @type {{ version: number, sessions: Record<string, Record<string, PersistedOverride>> }} */
  let data = { version: 1, sessions: {} }
  let reportOnce = false

  async function flush() {
    try {
      await atomicWriteJson(file, data)
      return ''
    } catch (error) {
      if (reportOnce) return ''
      reportOnce = true
      return `session store write failed at ${file}: ${String(error)}`
    }
  }

  return {
    path: file,
    /** @returns {Promise<string[]>} diagnostics */
    async load() {
      try {
        const text = await readFile(file, 'utf8')
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || parsed.sessions === null || typeof parsed.sessions !== 'object') {
          return [`session store has an unexpected shape at ${file}`]
        }
        /** @type {Record<string, Record<string, PersistedOverride>>} */
        const sessions = {}
        for (const [session, members] of Object.entries(parsed.sessions)) {
          if (members === null || typeof members !== 'object') continue
          /** @type {Record<string, PersistedOverride>} */
          const cleaned = {}
          for (const [member, entry] of Object.entries(members)) {
            const candidate = /** @type {any} */ (entry)
            if (typeof candidate?.provider !== 'string' || typeof candidate?.model !== 'string') continue
            cleaned[member] = {
              provider: candidate.provider,
              model: candidate.model,
              ...(typeof candidate.reasoningEffort === 'string' ? { reasoningEffort: candidate.reasoningEffort } : {}),
              scope: candidate.scope === 'sticky' ? 'sticky' : 'next-turn',
              at: typeof candidate.at === 'string' ? candidate.at : new Date().toISOString(),
            }
          }
          if (Object.keys(cleaned).length > 0) sessions[session] = cleaned
        }
        data = { version: 1, sessions }
        return []
      } catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code
        if (code === 'ENOENT') return []
        return [`session store unreadable at ${file}: ${String(error)}`]
      }
    },
    /**
     * @param {string} sessionId
     * @returns {Record<string, PersistedOverride>}
     */
    get(sessionId) {
      const members = data.sessions[sessionId]
      if (members === undefined) return {}
      return Object.fromEntries(Object.entries(members).map(([member, entry]) => [member, { ...entry }]))
    },
    /** @returns {number} */
    count() {
      return Object.values(data.sessions).reduce((total, members) => total + Object.keys(members).length, 0)
    },
    /**
     * @param {string} sessionId
     * @param {string} member
     * @param {PersistedOverride} entry
     * @returns {Promise<string>}
     */
    async set(sessionId, member, entry) {
      if (sessionId === '' || member === '') return ''
      data.sessions[sessionId] = { ...(data.sessions[sessionId] ?? {}), [member]: entry }
      return flush()
    },
    /**
     * @param {string} sessionId
     * @param {string} member
     * @returns {Promise<string>}
     */
    async remove(sessionId, member) {
      const members = data.sessions[sessionId]
      if (members === undefined || members[member] === undefined) return ''
      delete members[member]
      if (Object.keys(members).length === 0) delete data.sessions[sessionId]
      return flush()
    },
  }
}
