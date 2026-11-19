/**
 * Host-seam patching.
 *
 * `ctx.subagents` is a live service object shared by every plugin, so a route
 * has to be injected on the method everyone calls, not on a copy. The
 * wrap-and-restore shape is reused from NanmiCoder/dsh-agent-teams
 * (`lib/harness-compat.js`, `guardSubagentCreation`): capture the property
 * descriptor, install an own wrapper, and on dispose restore only when the
 * current value is still our wrapper, so a later plugin is never clobbered.
 *
 * @module dsh-team-model-router/patch
 */

/**
 * @typedef {{ provider: string, model: string }} Route
 * @typedef {(target: object, key: string, makeWrapper: (original: Function) => Function) => () => void} PatchMethod
 */

/**
 * @param {object | undefined} target
 * @param {string} key
 * @param {(original: Function) => Function} makeWrapper
 * @returns {() => void} disposer
 */
export function patchMethod(target, key, makeWrapper) {
  if (target === undefined || target === null) return () => {}
  const original = /** @type {Record<string, unknown>} */ (target)[key]
  if (typeof original !== 'function') return () => {}
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  const wrapped = makeWrapper(original)
  Object.defineProperty(target, key, { value: wrapped, writable: true, configurable: true })
  return () => {
    if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapped) return
    if (descriptor === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, descriptor)
  }
}

/**
 * Inject a route into an `AgentOptions` bag without touching unrelated fields.
 * @param {Record<string, unknown> | undefined} agentOptions
 * @param {Route} route
 * @returns {Record<string, unknown>}
 */
function withRoute(agentOptions, route) {
  return {
    ...(agentOptions ?? {}),
    provider: route.provider,
    model: route.model,
  }
}

/**
 * @param {Record<string, unknown> | undefined} agentOptions
 * @returns {boolean} true when the caller already asked for a model
 */
function declaresRoute(agentOptions) {
  if (agentOptions === undefined || agentOptions === null) return false
  return typeof agentOptions.model === 'string' && agentOptions.model.trim() !== ''
}

/**
 * Install route interception on both seams. Every wrapped call falls through
 * to the original method unchanged when no rule applies, so the plugin is
 * invisible unless a member route was configured.
 *
 * @param {{
 *   subagents: any,
 *   teams?: any,
 *   pending: ReturnType<import('./pending.js').createPendingRoutes>,
 *   resolve: (target: { parentId: string, label: string, name: string }) => Route | null,
 *   onDiagnostic?: (message: string) => void,
 * }} input
 * @returns {() => void}
 */
export function installRouteInterception({ subagents, teams, pending, resolve, onDiagnostic }) {
  const disposers = []

  if (subagents === undefined || subagents === null) {
    onDiagnostic?.('subagents service is absent; member routes cannot be applied')
    return () => {}
  }

  const continuable = patchMethod(subagents, 'startContinuable', (original) => async (...args) => {
    const spec = args[0]
    if (typeof spec !== 'object' || spec === null) return Reflect.apply(original, subagents, args)
    const parentId = spec.request?.parent?.id
    if (typeof parentId !== 'string') return Reflect.apply(original, subagents, args)
    const label = typeof spec.label === 'string' ? spec.label : ''
    const route = pending.take(parentId, label) ?? resolve({ parentId, label, name: '' })
    if (route === null) return Reflect.apply(original, subagents, args)
    if (declaresRoute(spec.request?.agentOptions)) return Reflect.apply(original, subagents, args)
    const next = {
      ...spec,
      request: { ...spec.request, agentOptions: withRoute(spec.request?.agentOptions, route) },
    }
    onDiagnostic?.(`route applied to continuable child: ${route.provider}/${route.model}`)
    return Reflect.apply(original, subagents, [next, ...args.slice(1)])
  })
  disposers.push(continuable)

  const oneShot = patchMethod(subagents, 'start', (original) => async (...args) => {
    const request = args.length >= 2 ? args[args.length - 1] : undefined
    if (typeof request !== 'object' || request === null) return Reflect.apply(original, subagents, args)
    const parentId = request.parent?.id
    if (typeof parentId !== 'string') return Reflect.apply(original, subagents, args)
    if (declaresRoute(request.agentOptions)) return Reflect.apply(original, subagents, args)
    const label = typeof request.label === 'string' ? request.label : ''
    const route = resolve({ parentId, label, name: '' })
    if (route === null) return Reflect.apply(original, subagents, args)
    const next = { ...request, agentOptions: withRoute(request.agentOptions, route) }
    onDiagnostic?.(`route applied to one-shot child: ${route.provider}/${route.model}`)
    return Reflect.apply(original, subagents, [...args.slice(0, -1), next])
  })
  disposers.push(oneShot)

  // The name-aware seam: park the route before the host creates the child.
  const spawn = patchMethod(teams, 'spawnTeammate', (original) => async (caller, request) => {
    const name = typeof request?.name === 'string' ? request.name.trim() : ''
    const parentId = caller?.id
    if (name === '' || typeof parentId !== 'string') return Reflect.apply(original, teams, [caller, request])
    const route = resolve({ parentId, label: typeof request.description === 'string' ? request.description : '', name })
    if (route === null) return Reflect.apply(original, teams, [caller, request])
    const label = typeof request.description === 'string' ? request.description : ''
    pending.put(parentId, label, route)
    try {
      return await Reflect.apply(original, teams, [caller, request])
    } finally {
      pending.drop(parentId, label)
    }
  })
  disposers.push(spawn)

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
