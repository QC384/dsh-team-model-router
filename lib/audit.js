/**
 * Append-only audit trail for every route mutation. Routing must never fail
 * because logging failed, so every operation returns a diagnostic instead of
 * throwing.
 *
 * @module dsh-team-model-router/audit
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * @param {string} file absolute JSONL path
 */
export function createAuditLog(file) {
  let reportedFailure = false
  return {
    path: file,
    /**
     * @param {{ action: string, member?: string, session?: string, actor?: string,
     *   from?: string, to?: string, scope?: string, note?: string }} entry
     * @returns {Promise<string>} empty string, or one diagnostic
     */
    async append(entry) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
      try {
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, `${line}\n`, 'utf8')
        return ''
      } catch (error) {
        const message = `audit log write failed at ${file}: ${String(error)}`
        if (reportedFailure) return ''
        reportedFailure = true
        return message
      }
    },
    /**
     * @param {number} limit
     * @returns {Promise<{ lines: string[], diagnostics: string[] }>}
     */
    async tail(limit) {
      const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20
      try {
        const text = await readFile(file, 'utf8')
        const lines = text.split('\n').filter((line) => line.trim() !== '').slice(-count)
        return { lines, diagnostics: [] }
      } catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code
        if (code === 'ENOENT') return { lines: [], diagnostics: [] }
        return { lines: [], diagnostics: [`audit log unreadable at ${file}: ${String(error)}`] }
      }
    },
  }
}
