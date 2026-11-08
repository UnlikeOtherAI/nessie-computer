import { withRetainedImportLocally, type RetainedImportLocalContext } from '../ownership/import-scope.js'

export interface HeldRetainedRuntimeSource {
  /** Exact production callback binding, including its one held database. */
  readonly local: RetainedImportLocalContext
  readonly signal: AbortSignal
  recheck(): Promise<void>
  /** Fence every dependent await; never use a result after lease loss. */
  checked<A>(operation: (signal: AbortSignal) => Promise<A>): Promise<A>
}

/**
 * Keep the real local-consent/source callback alive for its dependent graph.
 * The native reader has a 55s JS idle deadline; this 20s checked exchange keeps
 * unrelated waits from silently closing it. Consent and server lease deadlines
 * remain hard limits. This neither acquires a writer nor grants execution.
 */
export const withRetainedRuntimeSource = <A>(stateDirectory: string,
  input: { challenge: unknown; receipt: unknown },
  use: (source: HeldRetainedRuntimeSource) => Promise<A>, caller?: AbortSignal): Promise<A> => {
  caller?.throwIfAborted()
  return withRetainedImportLocally(stateDirectory, input, async local => {
    const controller = new AbortController()
    let live = true
    let failed = false
    let failure: unknown
    let checking: Promise<void> | undefined
    const refuse = (cause: unknown) => {
      if (!failed) { failed = true; failure = cause; controller.abort(cause) }
    }
    const assertLive = () => {
      if (failed) throw failure
      if (!live) throw new Error('T3_RUNTIME_SOURCE_SCOPE_CLOSED')
      caller?.throwIfAborted()
    }
    const abort = () => refuse(caller?.reason)
    caller?.addEventListener('abort', abort, { once: true })
    if (caller?.aborted) abort()
    const recheck = (): Promise<void> => {
      try { assertLive() } catch (error) { return Promise.reject(error) }
      checking ??= (async () => {
        // These are the exact callbacks issued by the actual local producer.
        // Do not reopen source paths, renew consent deadlines or replace them
        // with callback-asserted identities from a request.
        await local.physicalSourceRecheck()
        assertLive()
        await local.recheckLocalConsent()
        assertLive()
      })().catch(error => { refuse(error); throw error }).finally(() => { checking = undefined })
      return checking
    }
    const checked = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      await recheck()
      const result = await operation(controller.signal)
      await recheck()
      return result
    }
    const timer = setInterval(() => { void recheck().catch(refuse) }, 20_000)
    timer.unref()
    let result: A | undefined
    let useFailed = false
    let useFailure: unknown
    try {
      await recheck()
      // Await the callback even after revocation. Its scoped demand must drain
      // before the producer's finally releases the native source and consent.
      result = await use(Object.freeze({ local, signal: controller.signal, recheck, checked }))
      await recheck()
    } catch (error) {
      useFailed = true
      useFailure = error
    } finally {
      clearInterval(timer)
      caller?.removeEventListener('abort', abort)
      // A recheck already in flight still owns the source until it settles.
      if (checking) await checking.catch(refuse)
      live = false
      controller.abort()
    }
    if (failed && useFailed && failure !== useFailure) {
      throw new AggregateError([useFailure, failure], 'T3_RUNTIME_SOURCE_SCOPE_FAILED')
    }
    if (failed) throw failure
    if (useFailed) throw useFailure
    return result as A
  })
}
