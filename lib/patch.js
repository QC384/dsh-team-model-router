/**
 * Reversible method wrapping.
 *
 * Two rules keep this friendly to other plugins:
 * 1. the wrapper is installed with `Object.defineProperty` so it stays
 *    non-enumerable, like the original method;
 * 2. dispose only restores the original when the current value is still our
 *    own wrapper, so a plugin that wrapped after us is never clobbered.
 *
 * @module dsh-team-model-router/patch
 */

import { createPendingRoutes } from './pending.js'

/**
 * @param {Record<string, any>} target
 * @param {string} method
 * @param {(next: Function) => Function} wrap
 * @returns {() => void} disposer
 */
export function patchMethod(target, method, wrap) {
  const original = target[method]
  if (typeof original !== 'function') {
    throw new TypeError(`cannot patch ${method}: not a function`)
  }
  const wrapped = wrap(original)
  Object.defineProperty(target, method, {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  })
  return () => {
    if (target[method] === wrapped) {
      Object.defineProperty(target, method, {
        value: original,
        writable: true,
        configurable: true,
        enumerable: false,
      })
    }
  }
}

/**
 * Install the default-route layer: remember the route requested for a teammate
 * name, then attach it as `agentOptions` when the child is actually started.
 *
 * @param {{ subagents: any, agentTeams?: any }} services
 * @param {{ resolve: (name: string) => { provider: string, model: string } | null }} rules
 */
export function installRouteInterception(services, rules) {
  const pending = createPendingRoutes()
  const disposers = []

  const resolveName = (label) => (typeof label === 'string' ? rules.resolve(label) : null)

  // startContinuable: the real injection point (request.agentOptions).
  if (typeof services.subagents?.startContinuable === 'function') {
    disposers.push(patchMethod(services.subagents, 'startContinuable', (next) => async function patchedStartContinuable(spec, ...rest) {
      const label = spec?.label
      const handed = pending.take(spec?.request?.parent, label)
      const route = handed ?? resolveName(label)
      if (route !== null && route !== undefined) {
        spec = {
          ...spec,
          request: {
            ...spec.request,
            agentOptions: { ...(spec.request?.agentOptions ?? {}), provider: route.provider, model: route.model },
          },
        }
      }
      return next.call(this, spec, ...rest)
    }))
  }

  // start: same request shape for non-continuable children.
  if (typeof services.subagents?.start === 'function') {
    disposers.push(patchMethod(services.subagents, 'start', (next) => async function patchedStart(spec, ...rest) {
      const label = spec?.label
      const handed = pending.take(spec?.request?.parent, label)
      const route = handed ?? resolveName(label)
      if (route !== null && route !== undefined) {
        spec = {
          ...spec,
          request: {
            ...spec.request,
            agentOptions: { ...(spec.request?.agentOptions ?? {}), provider: route.provider, model: route.model },
          },
        }
      }
      return next.call(this, spec, ...rest)
    }))
  }

  // spawnTeammate: remember the route under its name so the hand-off can find it.
  if (typeof services.agentTeams?.spawnTeammate === 'function') {
    disposers.push(patchMethod(services.agentTeams, 'spawnTeammate', (next) => async function patchedSpawnTeammate(request, ...rest) {
      const name = request?.name
      const route = resolveName(name)
      if (route !== null && route !== undefined) {
        pending.put(request?.parent, request?.description, route)
      }
      try {
        return await next.call(this, request, ...rest)
      } catch (error) {
        if (name !== undefined) pending.drop(request?.parent, request?.description)
        throw error
      }
    }))
  }

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
