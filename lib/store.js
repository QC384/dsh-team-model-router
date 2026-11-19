/**
 * Rule storage under `$DSH_HOME/team-model-router/rules.json`.
 *
 * Reads never throw: a missing or corrupt file simply means "no rules".
 * Writes go through a temp file + rename so a crashed process cannot leave a
 * half-written JSON behind.
 *
 * @module dsh-team-model-router/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** @param {Record<string, string | undefined>} [env] */
export function rulesPath(env = process.env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'team-model-router', 'rules.json')
}

/** @param {string} [path] */
export async function readRules(path = rulesPath()) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param {unknown} state
 * @param {string} [path]
 */
export async function writeRules(state, path = rulesPath()) {
  const target = path
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}
