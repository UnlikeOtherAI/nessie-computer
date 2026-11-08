import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { ExecutorT3Request, requestTargets } from '@nessie/executor-protocol/t3-session'
import { SessionControl, type Threads } from '@nessie/t3-session-source/engine'
import { SessionStateOwner } from './state-owner.js'
import { readConfiguredSessionProvider } from './configured-provider.js'

type LaunchRequest = Extract<ExecutorT3Request, { readonly method: 'orchestration.launchThread' }>
type Success<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never
type Instance = Success<ReturnType<typeof readConfiguredSessionProvider>>
type Target = Success<ReturnType<typeof SessionControl.prepareLaunchTarget>>

export class SessionLaunchTargetRefused extends Error {
  constructor() { super('T3_EXECUTING_LAUNCH_TARGET_REFUSED'); this.name = 'SessionLaunchTargetRefused' }
}

const instances = new WeakMap<PreparedSessionLaunchTarget, { instance: Instance; requestBytes: string }>()
const constructorToken = Object.freeze({})

/** Scoped original engine selection, NOT a graph receipt or native authority.
 * Native homes/credentials are resolved by the protected graph owner against
 * the held settings. No live provider instance or secret is opened at inspection.
 * No native/providerSession ID or process launch digest exists at this phase. */
export class PreparedSessionLaunchTarget {
  readonly request: LaunchRequest
  readonly runtimeGeneration: string
  readonly target: Target
  private constructor(token: object, request: LaunchRequest, runtimeGeneration: string,
    target: Target, instance: Instance) {
    if (token !== constructorToken) throw new SessionLaunchTargetRefused()
    this.request = request
    this.runtimeGeneration = runtimeGeneration
    this.target = target
    instances.set(this, { instance,
      requestBytes: canonicalExecutorJson(Schema.encodeSync(ExecutorT3Request)(request)) })
    Object.freeze(this)
  }

  get providerInstanceId() { return this.target.providerInstanceId }
  get driverKind() {
    const held = instances.get(this)
    if (!held) throw new SessionLaunchTargetRefused()
    return held.instance.driverKind
  }
  /** Explicit native transport mapping; the original app driver identity is retained above. */
  get driver(): 'codex' | 'claude' { return this.driverKind === 'codex' ? 'codex' : 'claude' }
  get threadId() { return this.target.threadId }

  static readonly prepare = (original: LaunchRequest, provenance: Threads.ThreadManagementProvenance) =>
    Effect.gen(function* () {
      // Decode a private copy. The backend inspection challenge binds this same
      // original request, not a payload amended with the allocated thread ID.
      const request = Schema.decodeUnknownSync(ExecutorT3Request)(
        JSON.parse(canonicalExecutorJson(Schema.encodeSync(ExecutorT3Request)(original))))
      if (request.method !== 'orchestration.launchThread') return yield* Effect.fail(new SessionLaunchTargetRefused())
      requestTargets(request) // Includes all original attachment/context/workspace targets.
      const owner = yield* SessionStateOwner
      yield* owner.assertCurrent
      if (request.runtimeGeneration !== owner.runtimeGeneration) {
        return yield* Effect.fail(new SessionLaunchTargetRefused())
      }
      const target = yield* SessionControl.prepareLaunchTarget(request.input, provenance)
      const instance = yield* readConfiguredSessionProvider(target.projectId, target.providerInstanceId)
      yield* target.assertCurrent
      yield* owner.assertCurrent
      const selection = new PreparedSessionLaunchTarget(
        constructorToken, request, owner.runtimeGeneration, target, instance)
      yield* Effect.addFinalizer(() => Effect.sync(() => { instances.delete(selection) }))
      return selection
    })
}

/** Requires the same original configured instance and writer. A cloned
 * object, escaped target, changed provider config or rewritten request refuses. */
export const recheckSessionLaunchTarget = (selection: PreparedSessionLaunchTarget, request: LaunchRequest) =>
  Effect.gen(function* () {
    const held = instances.get(selection)
    if (!held || canonicalExecutorJson(Schema.encodeSync(ExecutorT3Request)(request)) !== held.requestBytes
      || canonicalExecutorJson(Schema.encodeSync(ExecutorT3Request)(selection.request)) !== held.requestBytes) {
      return yield* Effect.fail(new SessionLaunchTargetRefused())
    }
    const owner = yield* SessionStateOwner
    yield* owner.assertCurrent
    yield* selection.target.assertCurrent
    const current = yield* readConfiguredSessionProvider(selection.target.projectId, selection.providerInstanceId)
    if (owner.runtimeGeneration !== selection.runtimeGeneration
      || current.settingsBytes !== held.instance.settingsBytes || current.driverKind !== held.instance.driverKind) {
      return yield* Effect.fail(new SessionLaunchTargetRefused())
    }
    yield* owner.assertCurrent
  })

export const prepareSessionLaunchTarget = PreparedSessionLaunchTarget.prepare
