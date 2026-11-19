/**
 * Parser for the `/team-model` human command.
 *
 * The command plane only receives unstructured text (forms and completion
 * schemas are the command owner's job), so the grammar is deliberately tiny
 * and fully testable without a harness:
 *
 *   /team-model                                  status
 *   /team-model help                             usage
 *   /team-model coder deepseek deepseek-v4       next task only
 *   /team-model coder sticky qwen qwen3-coder    keep until cleared
 *   /team-model coder effort=high deepseek deepseek-v4
 *   /team-model coder clear                      drop the next-task override
 *   /team-model default coder qwen qwen3-coder   member default route
 *   /team-model default coder clear              drop the default route
 *   /team-model default all clear                drop every rule
 *
 * @module dsh-team-model-router/command
 */

export const COMMAND_NAME = 'team-model'

const USAGE = [
  '用法：',
  '  /team-model                                    查看当前路由与 override',
  '  /team-model <成员> <provider> <model>         下一个任务换模型（只影响一轮）',
  '  /team-model <成员> sticky <provider> <model>  持续使用，直到 clear',
  '  /team-model <成员> effort=<id> <provider> <model>  同时指定 reasoning effort',
  '  /team-model <成员> clear                      取消下一个任务的临时模型',
  '  /team-model default <成员> <provider> <model> 设置成员默认路由（需重建成员生效）',
  '  /team-model default <成员> clear              清除成员默认路由',
  '  /team-model default all clear                 清除全部默认路由',
].join('\n')

/** @returns {string} */
export function renderCommandHelp() {
  return USAGE
}

/**
 * @param {string} rawInput text after the command name
 * @returns {{
 *   kind: 'status' | 'help' | 'set' | 'clear' | 'set-default' | 'clear-default' | 'error',
 *   member?: string,
 *   provider?: string,
 *   model?: string,
 *   scope?: 'next-turn' | 'sticky',
 *   effort?: string,
 *   text?: string,
 * }}
 */
export function parseTeamCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  const tokens = text === '' ? [] : text.split(/\s+/)
  if (tokens.length === 0 || tokens[0] === 'status' || tokens[0] === 'list') return { kind: 'status' }
  if (tokens[0] === 'help' || tokens[0] === '-h' || tokens[0] === '--help') return { kind: 'help' }

  if (tokens[0] === 'default') {
    const member = tokens[1]
    if (member === undefined) return { kind: 'error', text: '缺少成员名。\n\n' + USAGE }
    if (tokens[2] === 'clear' && tokens.length === 3) return { kind: 'clear-default', member }
    const provider = tokens[2]
    const model = tokens[3]
    if (provider === undefined || model === undefined) {
      return { kind: 'error', text: 'default 需要 provider 和 model。\n\n' + USAGE }
    }
    return { kind: 'set-default', member, provider, model }
  }

  const member = tokens[0]
  const rest = tokens.slice(1)
  if (rest.length === 1 && rest[0] === 'clear') return { kind: 'clear', member }
  if (rest.length === 0) return { kind: 'error', text: `缺少参数。\n\n${USAGE}` }

  let scope = 'next-turn'
  if (rest[0] === 'sticky') {
    scope = 'sticky'
    rest.shift()
  }
  let effort
  if (rest[0]?.startsWith('effort=')) {
    effort = rest[0].slice('effort='.length)
    rest.shift()
    if (effort === '') return { kind: 'error', text: 'effort= 后面需要值。' }
  }
  const provider = rest[0]
  const model = rest[1]
  if (provider === undefined || model === undefined) {
    return { kind: 'error', text: `缺少 provider 或 model。\n\n${USAGE}` }
  }
  if (rest.length > 2) {
    return { kind: 'error', text: `多余的参数：${rest.slice(2).join(' ')}` }
  }
  return { kind: 'set', member, provider, model, scope, ...(effort === undefined ? {} : { effort }) }
}
