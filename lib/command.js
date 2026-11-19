/**
 * Parser for the `/team-model` human command.
 *
 * The command plane only receives unstructured text (forms and completion
 * schemas are the command owner's job), so the grammar is deliberately tiny
 * and fully testable without a harness:
 *
 *   /team-model                                   status
 *   /team-model help                              usage
 *   /team-model models [provider]                 live model catalog
 *   /team-model aliases                           configured aliases
 *   /team-model log [n]                           recent audit entries
 *   /team-model health                            wiring + service health
 *   /team-model coder deepseek deepseek-v4        next task only
 *   /team-model coder v4                          alias / provider-model shorthand
 *   /team-model coder sticky qwen qwen3-coder     keep until cleared
 *   /team-model coder effort=high deepseek deepseek-v4
 *   /team-model coder clear                       drop the next-task override
 *   /team-model default coder qwen qwen3-coder    member default route
 *   /team-model default coder clear               drop the default route
 *   /team-model default all clear                 drop every rule
 *
 * @module dsh-team-model-router/command
 */

export const COMMAND_NAME = 'team-model'

const USAGE = [
  '用法：',
  '  /team-model                                    查看当前路由与 override',
  '  /team-model models [provider]                  列出宿主注册的模型（含别名提示）',
  '  /team-model aliases                            查看已配置的模型别名',
  '  /team-model log [n]                            最近 n 条变更审计（默认 20）',
  '  /team-model health                             检查各服务挂载与 STALE/持久化状态',
  '  /team-model <成员|模式> <provider> <model>     下一个任务换模型（只影响一轮）',
  '  /team-model <成员|模式> <别名|provider/model>  同上，用别名或斜杠简写',
  '  /team-model <成员|模式> sticky <provider> <model>  持续使用，直到 clear',
  '  /team-model <成员|模式> effort=<id> <provider> <model>  同时指定 reasoning effort',
  '  /team-model <成员|模式> clear                  取消下一个任务的临时模型',
  '  /team-model default <成员|模式> <provider> <model> 设置成员默认路由（需重建成员生效）',
  '  /team-model default <成员|模式> clear          清除成员默认路由',
  '  /team-model default all clear                  清除全部默认路由',
].join('\n')

/** @returns {string} */
export function renderCommandHelp() {
  return USAGE
}

/**
 * @param {string} rawInput text after the command name
 * @returns {{
 *   kind: 'status' | 'help' | 'models' | 'aliases' | 'log' | 'health' | 'set' | 'clear' | 'set-default' | 'clear-default' | 'error',
 *   member?: string,
 *   provider?: string,
 *   model?: string,
 *   token?: string,
 *   scope?: 'next-turn' | 'sticky',
 *   effort?: string,
 *   limit?: number,
 *   text?: string,
 * }}
 */
export function parseTeamCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  const tokens = text === '' ? [] : text.split(/\s+/)
  const head = tokens[0]
  if (tokens.length === 0 || head === 'status' || head === 'list') return { kind: 'status' }
  if (head === 'help' || head === '-h' || head === '--help') return { kind: 'help' }
  if (head === 'models' || head === 'model') return { kind: 'models', ...(tokens[1] === undefined ? {} : { provider: tokens[1] }) }
  if (head === 'aliases' || head === 'alias') return { kind: 'aliases' }
  if (head === 'health') return { kind: 'health' }
  if (head === 'log' || head === 'audit') {
    if (tokens[1] === undefined) return { kind: 'log', limit: 20 }
    const parsed = Number(tokens[1])
    if (!Number.isInteger(parsed) || parsed <= 0) return { kind: 'error', text: 'log 需要一个正整数条数。' }
    return { kind: 'log', limit: parsed }
  }

  if (head === 'default') {
    const member = tokens[1]
    if (member === undefined) return { kind: 'error', text: '缺少成员名。\n\n' + USAGE }
    if (tokens[2] === 'clear' && tokens.length === 3) return { kind: 'clear-default', member }
    const provider = tokens[2]
    const model = tokens[3]
    if (provider === undefined) return { kind: 'error', text: 'default 需要 provider 和 model（或一个别名）。\n\n' + USAGE }
    if (model === undefined) return { kind: 'set-default', member, token: provider }
    return { kind: 'set-default', member, provider, model }
  }

  const member = head
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
  if (rest.length === 1) {
    return { kind: 'set', member, token: rest[0], scope, ...(effort === undefined ? {} : { effort }) }
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
