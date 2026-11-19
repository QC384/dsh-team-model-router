/**
 * Rule persistence under `$DSH_HOME`, never inside the harness install.
 *
 * @module dsh-team-model-router/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeState } from './rules.js'

/**
 * @param {string | undefined} configured
 * @returns {string} absolute rules file path
 */
export function rulesPath(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'team-model-router', 'rules.json')
}

/**
 * @param {string} path
 * @returns {Promise<{ state: import('./rules.js').RuleState, diagnostics: string[], existed: boolean }>}
 */
export async function readRules(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    if (code === 'ENOENT') return { state: normalizeState({}).state, diagnostics: [], existed: false }
    return { state: normalizeState({}).state, diagnostics: [`rules file unreadable at ${path}: ${String(error)}`], existed: false }
  }
  try {
    return { ...normalizeState(JSON.parse(text)), existed: true }
  } catch (error) {
    return { state: normalizeState({}).state, diagnostics: [`rules file is not valid JSON at ${path}: ${String(error)}`], existed: true }
  }
}

/**
 * Atomic write: a torn file would silently wipe member routes.
 * @param {string} path
 * @param {import('./rules.js').RuleState} state
 */
export async function writeRules(path, state) {
  return atomicWriteJson(path, state)
}

/**
 * Atomic JSON write shared by the rules file, the session store and any other
 * plugin-owned state: a torn file would silently wipe routing state.
 * @param {string} path
 * @param {unknown} value
 */
export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}
