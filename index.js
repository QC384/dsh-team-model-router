/**
 * dsh-team-model-router
 *
 * Three surfaces over one routing core:
 *
 * 1. **Per-member default route** at spawn time. `spawn_teammate` carries no
 *    model, but `ctx.subagents.startContinuable` accepts `agentOptions`; the
 *    route is handed over from `agentTeams.spawnTeammate` by member name.
 * 2. **Per-task route for a live member**. The host exports
 *    `installModelSelection(agentCtx, ref)` from `@deepseek-ai/dsh-agent`:
 *    prompt assembly snapshots `ref.current`, so setting it before the member's
 *    next turn changes that one task's model without re-creating the member.
 *    The ref is cleared again at that turn's `turn/end`.
 * 3. **Human surfaces**: a `/team-model` command rendered by the UI command
 *    plane (never enters model history) and a `team-model-router` settings
 *    namespace rendered as a configuration card.
 *
 * @module dsh-team-model-router
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { COMMAND_NAME, parseTeamCommand, renderCommandHelp } from './lib/command.js'
import { createOverrideBook } from './lib/overrides.js'
import { createPendingRoutes } from './lib/pending.js'
import { installRouteInterception } from './lib/patch.js'
import {
  ALL_MEMBERS,
  describeRoute,
  matchRule,
  normalizeRoute,
  normalizeState,
  resolveRoute,
  routeState,
} from './lib/rules.js'
import { readRules, rulesPath, writeRules } from './lib/store.js'

export const name = 'dsh-team-model-router'

/** `subagents` is hard; `agentTeams` / `agents` / `commands` / `settings` are probed. */
export const inject = ['tools', 'subagents']

export const Config = z.object({
  rulesFile: z.string(),
  defaultProvider: z.string(),
  defaultModel: z.string(),
  members: z.dict(z.object({ provider: z.string().required(), model: z.string().required() })),
})

/** Shape rendered by the settings surface; every field is optional. */
const SettingsSchema = z.object({
  defaults: z.object({ provider: z.string(), model: z.string() }),
  members: z.dict(z.object({ provider: z.string(), model: z.string() })),
})

export const SETTINGS_NAMESPACE = 'team-model-router'

/**
 * @param {string | undefined} provider
 * @param {string | undefined} model
 * @returns {{ provider: string, model: string } | null}
 */
function currentRoute(provider, model) {
  const modelId = typeof model === 'string' ? model.trim() : ''
  if (modelId === '') return null
  return { provider: typeof provider === 'string' ? provider.trim() : '', model: modelId }
}

/**
 * @param {any} agent
 */
function leaderRouteOf(agent) {
  return currentRoute(agent?.options?.provider, agent?.options?.model)
}

/**
 * @param {any} agent
 * @param {any} teams
 */
function isLead(agent, teams) {
  const membership = typeof teams?.tryMembership === 'function' ? teams.tryMembership(agent) : undefined
  return membership === undefined || membership === null || membership.role === 'lead'
}

/**
 * @param {any} exec
 * @param {any} teams
 */
function requireLead(exec, teams) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) throw new Error('this tool must be called by a live agent')
  if (!isLead(agent, teams)) throw new Error('only the Team Lead can change member model routes')
  return agent
}

/**
 * @param {Record<string, unknown>} config
 */
function configBaseOf(config) {
  /** @type {Record<string, unknown>} */
  const base = {}
  if (typeof config.defaultProvider === 'string' && typeof config.defaultModel === 'string') {
    base.defaults = { provider: config.defaultProvider, model: config.defaultModel }
  }
  const members = /** @type {Record<string, { provider: string, model: string }> | undefined} */ (config.members)
  if (members !== undefined && members !== null) {
    base.members = Object.fromEntries(Object.entries(members).map(([member, value]) => [member, { provider: value.provider, model: value.model }]))
  }
  return base
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} path
 */
async function loadState(config, path) {
  const loaded = await readRules(path)
  const diagnostics = [...loaded.diagnostics]
  const state = loaded.state
  if (typeof config.defaultProvider === 'string' && typeof config.defaultModel === 'string') {
    const normalized = normalizeRoute({ provider: config.defaultProvider, model: config.defaultModel }, 'config')
    diagnostics.push(...normalized.diagnostics)
    if (state.defaults === null && normalized.route !== null) state.defaults = normalized.route
  }
  const configuredMembers = /** @type {Record<string, { provider: string, model: string }> | undefined} */ (config.members)
  if (configuredMembers !== undefined) {
    for (const [member, value] of Object.entries(configuredMembers)) {
      if (!Object.hasOwn(state.members, member)) state.members[member] = { provider: value.provider.trim(), model: value.model.trim() }
    }
  }
  return { state, diagnostics }
}

/**
 * @param {any} teams
 * @param {any} leader
 * @param {string} name
 */
function findMemberRow(teams, leader, name) {
  if (typeof teams?.listMembers !== 'function') return null
  const rows = teams.listMembers(leader)
  const row = rows.find((candidate) => candidate.role !== 'lead' && candidate.name === name)
  return row === undefined ? null : { id: String(row.id), name: row.name, status: String(row.status) }
}

/**
 * @param {any} override
 */
function describeOverride(override) {
  if (override === undefined || override === null) return ''
  const effort = override.selection.reasoningEffort === undefined ? '' : ` effort=${override.selection.reasoningEffort}`
  const phase = 'applied' in override ? (override.applied ? 'active' : 'queued') : 'queued-for-resume'
  return ` override=${override.selection.provider}/${override.selection.model}${effort} (${override.scope}, ${phase})`
}

/**
 * @param {import('./lib/rules.js').RuleState} state
 */
function sectionOf(state) {
  return {
    ...(state.defaults === null ? {} : { defaults: { ...state.defaults } }),
    members: Object.fromEntries(Object.entries(state.members).map(([member, route]) => [member, { ...route }])),
  }
}

/**
 * @param {any} agent
 * @param {any} teams
 * @param {import('./lib/rules.js').RuleState} state
 * @param {string} path
 * @param {string[]} diagnostics
 * @param {{ book: ReturnType<typeof createOverrideBook>, pendingByName: Map<string, any> }} runtime
 */
function renderRoster(agent, teams, state, path, diagnostics, runtime) {
  const leader = leaderRouteOf(agent)
  const lines = [
    `rules file: ${path}`,
    `leader route: ${describeRoute(leader)}`,
    `default route: ${describeRoute(state.defaults)}`,
  ]
  const rules = Object.entries(state.members)
  lines.push(`member rules: ${rules.length === 0 ? '(none)' : rules.map(([member, route]) => `${member} => ${route.provider}/${route.model}`).join(', ')}`)

  const members = typeof teams?.listMembers === 'function' ? teams.listMembers(agent) : []
  if (members.length === 0) {
    lines.push('roster: unavailable (Agent Teams service is not installed, or no team is attached)')
  } else {
    lines.push('roster:')
    for (const member of members) {
      if (member.role === 'lead') continue
      const matched = matchRule(state, member.name)
      const expected = matched?.route ?? state.defaults ?? leader
      const observed = currentRoute(member.provider, member.model)
      const status = routeState(member, expected)
      const override = runtime.book.get(String(member.id)) ?? runtime.pendingByName.get(member.name)
      lines.push(
        `- ${member.name} [${member.status}] observed=${observed === null ? 'unknown' : `${observed.provider}/${observed.model}`}`
        + ` expected=${describeRoute(expected)} source=${matched !== null ? `rule:${matched.name}` : state.defaults !== null ? 'default' : 'inherit'}`
        + ` ${status === 'stale' ? 'STALE' : status}`
        + describeOverride(override),
      )
    }
    if (runtime.book.size() > 0 || runtime.pendingByName.size > 0) {
      lines.push('note: a next-task override is separate from the member snapshot; it is consumed by one turn (or kept when scope=sticky).')
    }
  }
  if (diagnostics.length > 0) {
    lines.push('diagnostics:')
    for (const diagnostic of diagnostics) lines.push(`- ${diagnostic}`)
  }
  return lines.join('\n')
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 */
export async function apply(ctx, config = {}) {
  const path = rulesPath(/** @type {string | undefined} */ (config.rulesFile))
  const teams = ctx.get('agentTeams')
  const pending = createPendingRoutes({})
  const book = createOverrideBook()
  /** @type {Map<string, { agent: any, ref: { current: any, assembled: any }, dispose: () => void }>} */
  const slots = new Map()
  /** @type {Map<string, { selection: any, scope: 'next-turn' | 'sticky' }>} */
  const pendingByName = new Map()
  const diagnostics = []

  let state
  let settingsScope = null

  const loaded = await loadState(config, path)
  state = loaded.state
  diagnostics.push(...loaded.diagnostics)

  // Settings are the canonical long-term store when the host mounts them;
  // rules.json stays the fallback and is imported once.
  const settings = ctx.get('settings')
  if (typeof settings?.register === 'function') {
    try {
      settingsScope = settings.register(SETTINGS_NAMESPACE, SettingsSchema, {
        base: configBaseOf(config),
        applies: 'live',
      })
      const resolved = normalizeState(settingsScope.get())
      const emptySettings = resolved.state.defaults === null && Object.keys(resolved.state.members).length === 0
      const fileHasRules = state.defaults !== null || Object.keys(state.members).length > 0
      diagnostics.push(...resolved.diagnostics)
      if (emptySettings && fileHasRules) {
        await settingsScope.replace(sectionOf(state))
      } else {
        state = resolved.state
      }
      ctx.effect(() => settingsScope.watch((next) => {
        const normalized = normalizeState(next)
        state = normalized.state
      }), 'team-model-router: settings')
    } catch (error) {
      settingsScope = null
      diagnostics.push(`settings namespace "${SETTINGS_NAMESPACE}" unavailable: ${String(error)}`)
    }
  }

  async function persist() {
    if (settingsScope !== null) {
      await settingsScope.replace(sectionOf(state))
      return
    }
    await writeRules(path, state)
  }

  async function reloadState() {
    if (settingsScope !== null) {
      const normalized = normalizeState(settingsScope.get())
      state = normalized.state
      return normalized.diagnostics
    }
    const reloaded = await loadState(config, path)
    state = reloaded.state
    return reloaded.diagnostics
  }

  const resolve = (/** @type {{ parentId: string, label: string, name: string }} */ target) => {
    const byName = target.name === '' ? null : resolveRoute(state, { name: target.name }).route
    if (byName !== null) return byName
    return resolveRoute(state, { name: target.label }).route
  }

  if (settingsScope === null && (state.defaults !== null || Object.keys(state.members).length > 0)) {
    await writeRules(path, state)
  }

  const disposeInterception = installRouteInterception({
    subagents: ctx.subagents,
    teams,
    pending,
    resolve,
    onDiagnostic: (message) => {
      diagnostics.push(message)
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(`[team-model-router] ${message}`)
    },
  })

  /**
   * Install (once) the mutable selection ref on a live member.
   * @param {any} agent
   */
  function ensureSlot(agent) {
    const existing = slots.get(String(agent.id))
    if (existing !== undefined && existing.agent === agent) return existing
    if (existing !== undefined) existing.dispose()
    if (typeof installModelSelection !== 'function') {
      throw new Error('this DSH build does not export installModelSelection; per-task model switching is unavailable')
    }
    const ref = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(agent.ctx, ref)
    const slot = { agent, ref, dispose }
    slots.set(String(agent.id), slot)
    return slot
  }

  /**
   * @param {string} id
   * @param {any} selection
   */
  function applySelection(id, selection) {
    const agents = ctx.get('agents')
    const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined
    if (agent === undefined || agent === null) return false
    ensureSlot(agent).ref.current = selection
    return true
  }

  ctx.effect(() => ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
    const id = String(session?.id ?? '')
    if (id === '' || !book.has(id)) return
    if (event?.type === 'turn/start') {
      const selection = book.onTurnStart(id)
      if (selection !== null) applySelection(id, selection)
      return
    }
    if (event?.type === 'turn/end') {
      if (book.onTurnEnd(id)) applySelection(id, undefined)
    }
  }), 'team-model-router: turn-scoped selection')

  ctx.effect(() => ctx.on('agent/created', (/** @type {any} */ payload) => {
    const agent = payload?.agent
    const membership = typeof teams?.tryMembership === 'function' ? teams.tryMembership(agent) : undefined
    if (membership === undefined || membership === null || membership.role !== 'teammate') return
    const queued = pendingByName.get(membership.name)
    if (queued === undefined) return
    pendingByName.delete(membership.name)
    book.request(String(agent.id), queued.selection, queued.scope)
  }), 'team-model-router: resume hand-off')

  /**
   * @param {any} leader
   * @param {string} member
   * @param {{ provider: string, model: string, reasoningEffort?: string }} selection
   * @param {'next-turn' | 'sticky'} scope
   */
  async function setNextModel(leader, member, selection, scope) {
    if (member === '') throw new Error('member is required')
    const row = findMemberRow(teams, leader, member)
    if (row === null) {
      if (teams === undefined || teams === null) {
        pendingByName.set(member, { selection, scope })
        return `Agent Teams unavailable; queued ${selection.provider}/${selection.model} for "${member}".`
      }
      throw new Error(`unknown teammate "${member}"; call team_model_list for the exact roster names`)
    }
    const agents = ctx.get('agents')
    const live = typeof agents?.get === 'function' ? agents.get(row.id) : undefined
    if (live === undefined || live === null) {
      pendingByName.set(member, { selection, scope })
      return `"${member}" is ${row.status}; queued ${selection.provider}/${selection.model} for its next activation.`
    }
    book.request(row.id, selection, scope)
    ensureSlot(live)
    const running = String(live.status) === 'running'
    return [
      `"${member}" next task -> ${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` (effort ${selection.reasoningEffort})`}`,
      `scope=${scope}; ${running ? 'member is running, so the switch lands on the following turn' : 'applies when the next turn starts'}`,
      'a one-task override reverts to the member\'s own route at that turn\'s end',
    ].join('\n')
  }

  /**
   * @param {any} leader
   * @param {string} member
   */
  function clearNextModel(leader, member) {
    if (member === '') throw new Error('member is required')
    pendingByName.delete(member)
    const row = findMemberRow(teams, leader, member)
    if (row !== null) {
      book.clear(row.id)
      applySelection(row.id, undefined)
    }
    return `cleared next-task override for "${member}"`
  }

  /**
   * @param {string} member
   * @param {{ provider: string, model: string }} route
   */
  async function setDefaultRoute(member, route) {
    if (member === ALL_MEMBERS) state.defaults = route
    else state.members[member] = route
    await persist()
  }

  /**
   * @param {string} member
   */
  async function clearDefaultRoute(member) {
    if (member === 'all') {
      state = { version: state.version, defaults: null, members: {} }
    } else if (member === ALL_MEMBERS) {
      state.defaults = null
    } else {
      delete state.members[member]
    }
    await persist()
  }

  /** @type {Array<() => void>} */
  const toolDisposers = []
  const register = (/** @type {any} */ spec) => {
    const dispose = ctx.tools.register(defineTool(spec))
    if (typeof dispose === 'function') toolDisposers.push(dispose)
  }

  register({
    name: 'team_model_set',
    description:
      'Give one Agent Team member its own default LLM route, or set the default route for unlisted members ("*"). '
      + 'Both provider and model are required. This is the member creation route: existing members must be released '
      + 'and re-spawned before they pick it up. For a model change on the NEXT task in the same conversation, use team_next_model. Team Lead only.',
    parameters: {
      member: { type: 'string', required: true, description: 'Member name (exact, or a * / ? pattern). Use "*" for the default route.' },
      provider: { type: 'string', required: true, description: 'LLM provider id registered in DSH, e.g. "deepseek".' },
      model: { type: 'string', required: true, description: 'Model id used verbatim by that provider. Do not pass "provider/model".' },
    },
    output: { schema: { type: 'string' } },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      const agent = requireLead(exec, teams)
      const member = String(args.member ?? '').trim()
      const normalized = normalizeRoute({ provider: args.provider, model: args.model }, 'arguments')
      if (normalized.route === null) throw new Error(`invalid route: ${normalized.diagnostics.join('; ') || 'provider and model are required'}`)
      await setDefaultRoute(member, normalized.route)
      return [
        `${member === ALL_MEMBERS ? 'default route' : `member "${member}"`}: ${normalized.route.provider}/${normalized.route.model} saved`,
        `leader route: ${describeRoute(leaderRouteOf(agent))}`,
        'applies to newly created members only; for the next task of a live member use team_next_model',
      ].join('\n')
    },
  })

  register({
    name: 'team_next_model',
    description:
      'Run ONE member\'s next task on a different provider/model inside the same conversation, without re-creating the member. '
      + 'The route is installed on the live Agent and consumed by exactly one turn (scope="next-turn"), or kept until cleared '
      + '(scope="sticky"). If that member is currently running, the switch waits for its NEXT turn so the running task is '
      + 'never rewritten mid-flight. If the member is inactive, the route is queued and applied when it cold-resumes. Team Lead only.',
    parameters: {
      member: { type: 'string', required: true, description: 'Teammate name, exactly as listed by team_model_list.' },
      provider: { type: 'string', required: true, description: 'LLM provider id for this task, e.g. "deepseek".' },
      model: { type: 'string', required: true, description: 'Model id for this task, used verbatim.' },
      reasoning_effort: { type: 'string', description: 'Optional effort id supported by that model; omit for the model default.' },
      scope: {
        type: 'string',
        enum: ['next-turn', 'sticky'],
        description: 'next-turn applies to one task then reverts to the member route; sticky keeps it until team_next_model_clear.',
      },
    },
    output: { schema: { type: 'string' } },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      const leader = requireLead(exec, teams)
      const member = String(args.member ?? '').trim()
      const normalized = normalizeRoute({ provider: args.provider, model: args.model }, 'arguments')
      if (normalized.route === null) throw new Error(`invalid route: ${normalized.diagnostics.join('; ') || 'provider and model are required'}`)
      const scope = args.scope === 'sticky' ? 'sticky' : 'next-turn'
      const selection = {
        provider: normalized.route.provider,
        model: normalized.route.model,
        ...(typeof args.reasoning_effort === 'string' && args.reasoning_effort.trim() !== ''
          ? { reasoningEffort: args.reasoning_effort.trim() }
          : {}),
      }
      return setNextModel(leader, member, selection, scope)
    },
  })

  register({
    name: 'team_next_model_clear',
    description: 'Cancel a queued or sticky next-task override for one member and restore its own route immediately. Team Lead only.',
    parameters: {
      member: { type: 'string', required: true, description: 'Teammate name whose override should be dropped.' },
    },
    output: { schema: { type: 'string' } },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      const leader = requireLead(exec, teams)
      return clearNextModel(leader, String(args.member ?? '').trim())
    },
  })

  register({
    name: 'team_model_clear',
    description: 'Remove one member default route, or all of them, so the member falls back to the default route or the leader route. Team Lead only.',
    parameters: {
      member: { type: 'string', required: true, description: 'Member name or pattern to clear. Use "*" to clear the default route; use "all" to clear every member rule.' },
    },
    output: { schema: { type: 'string' } },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      const agent = requireLead(exec, teams)
      const member = String(args.member ?? '').trim()
      await clearDefaultRoute(member)
      return `cleared ${member}; leader route stays ${describeRoute(leaderRouteOf(agent))}`
    },
  })

  register({
    name: 'team_model_list',
    description:
      'Show the leader route, saved member default routes, each live member\'s observed route, and any queued next-task override. '
      + 'A member marked STALE snapshotted an older default route and will not change until it is released and re-spawned; an override is separate and applies to the next turn only.',
    parameters: {},
    output: { schema: { type: 'string' } },
    async execute(/** @type {any} */ _args, /** @type {any} */ exec) {
      const agent = requireLead(exec, teams)
      const reloaded = await reloadState()
      return renderRoster(agent, teams, state, path, [...reloaded, ...diagnostics], { book, pendingByName })
    },
  })

  register({
    name: 'team_model_reload',
    description: 'Re-read the rules file after editing it by hand, then report the roster.',
    parameters: {},
    output: { schema: { type: 'string' } },
    async execute(/** @type {any} */ _args, /** @type {any} */ exec) {
      const agent = requireLead(exec, teams)
      const reloaded = await reloadState()
      return renderRoster(agent, teams, state, path, [...reloaded, ...diagnostics], { book, pendingByName })
    },
  })

  // --- human command plane ------------------------------------------------
  const commands = ctx.get('commands')
  if (typeof commands?.register === 'function') {
    ctx.effect(() => commands.register({
      name: COMMAND_NAME,
      description: 'Set one teammate\'s model for its next task in this conversation, or manage member default routes.',
      input: { hint: 'coder deepseek deepseek-v4 | coder sticky qwen qwen3-coder | coder clear | status' },
      handler: async (/** @type {any} */ invocation) => {
        const agent = invocation.agent
        if (!isLead(agent, teams)) {
          return { kind: 'error', text: '只有 Team Lead 可以修改成员模型路由' }
        }
        const parsed = parseTeamCommand(invocation.rawInput)
        try {
          switch (parsed.kind) {
            case 'status':
              return { kind: 'success', text: renderRoster(agent, teams, state, path, diagnostics, { book, pendingByName }) }
            case 'help':
              return { kind: 'success', text: renderCommandHelp() }
            case 'set': {
              const normalized = normalizeRoute({ provider: parsed.provider, model: parsed.model }, 'command')
              if (normalized.route === null) throw new Error(normalized.diagnostics.join('; ') || 'provider and model are required')
              const selection = {
                ...normalized.route,
                ...(parsed.effort === undefined ? {} : { reasoningEffort: parsed.effort }),
              }
              return { kind: 'success', text: await setNextModel(agent, parsed.member, selection, parsed.scope) }
            }
            case 'clear':
              return { kind: 'success', text: clearNextModel(agent, parsed.member) }
            case 'set-default': {
              const normalized = normalizeRoute({ provider: parsed.provider, model: parsed.model }, 'command')
              if (normalized.route === null) throw new Error(normalized.diagnostics.join('; ') || 'provider and model are required')
              await setDefaultRoute(parsed.member, normalized.route)
              return { kind: 'success', text: `默认路由已保存：${parsed.member} => ${normalized.route.provider}/${normalized.route.model}（需重建成员生效）` }
            }
            case 'clear-default':
              await clearDefaultRoute(parsed.member)
              return { kind: 'success', text: `已清除默认路由：${parsed.member}` }
            default:
              return { kind: 'error', text: parsed.text ?? '无法解析该命令' }
          }
        } catch (error) {
          return { kind: 'error', text: String(/** @type {any} */ (error)?.message ?? error) }
        }
      },
    }), 'team-model-router: command')
  }

  ctx.effect(() => () => {
    for (const dispose of toolDisposers.splice(0)) dispose()
    for (const slot of slots.values()) slot.dispose()
    slots.clear()
    book.clear()
    pendingByName.clear()
    pending.clear()
    disposeInterception()
  }, 'team-model-router: tools')

  for (const diagnostic of diagnostics) {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`[team-model-router] ${diagnostic}`)
  }
}
