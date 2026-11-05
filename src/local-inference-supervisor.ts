import { LocalInferenceApiError } from './local-inference-api.js'
import { connectExecutorLocalInference } from './local-inference-runtime.js'
import type { ExecutorLocalState } from './state-store.js'

export type ExecutorLocalInferenceSupervisor = {
  heartbeat: () => Promise<void>
  reconnect: (state: ExecutorLocalState) => Promise<ExecutorLocalState>
  stop: () => Promise<void>
}

type Connected = Awaited<ReturnType<typeof connectExecutorLocalInference>>

/** Half the challenge bucket's window: a claim refused for rate, not authority, is not retried every heartbeat. */
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000
/** How long a heartbeat waits for a freshly claimed host's socket to open before leaving it to reconnect alone. */
const SOCKET_READY_WAIT_MS = 15_000

/** Settles true when the socket opened, false when Nessie refused it, null when neither happened in time. */
const socketReady = (session: Connected['session']): Promise<boolean | null> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), SOCKET_READY_WAIT_MS)
  timer.unref()
  void session.connected.then(() => { clearTimeout(timer); resolve(true) })
  void session.refused.then(() => { clearTimeout(timer); resolve(false) })
})

/**
 * Keep the local host tied to the executor daemon lifecycle. Its socket
 * reconnects by itself and a generation in flight continues across a drop;
 * only a refusal of the host's authority starts over with a fresh claim,
 * which fences any previous process before it can receive another attempt.
 */
export const startExecutorLocalInferenceSupervisor = async (
  stateDir: string,
  state: ExecutorLocalState,
  connectLocal: typeof connectExecutorLocalInference = connectExecutorLocalInference,
): Promise<{ state: ExecutorLocalState; supervisor: ExecutorLocalInferenceSupervisor }> => {
  let desiredState = state
  let connected: Connected | null = null
  // The daemon's stderr is the only place a lost local host says why, so each
  // distinct reason is written once, not every twenty seconds; the server's
  // Offline state is what the person sees, this is what the operator reads.
  let lastFailure: string | null = null
  // A fresh claim spends two of the address's shared challenges; after Nessie
  // answers 429 the next ones wait, or the loop itself keeps the bucket empty.
  let claimNotBefore = 0
  const diagnose = (stage: 'connect' | 'heartbeat' | 'socket', error: unknown): void => {
    if (error instanceof LocalInferenceApiError && error.status === 429) {
      claimNotBefore = Date.now() + RATE_LIMIT_BACKOFF_MS
    }
    const reason = error instanceof Error ? error.message : String(error)
    if (reason === lastFailure) return
    lastFailure = reason
    console.error(`[nessie-executor] local inference ${stage} failed:`, reason)
  }
  const disconnect = async (): Promise<void> => {
    const current = connected
    connected = null
    await current?.session.stop()
  }
  const connect = async (nextState: ExecutorLocalState): Promise<ExecutorLocalState> => {
    await disconnect()
    desiredState = nextState
    const next = await connectLocal(stateDir, desiredState)
    connected = next
    desiredState = next.state
    void next.session.refused.then(async () => {
      if (connected !== next) return
      diagnose('socket', new Error('LOCAL_HOST_UNAVAILABLE'))
      await disconnect()
    })
    return desiredState
  }
  try {
    await connect(state)
  } catch (error) {
    // Local inference is an optional sibling of the paired executor. Its
    // policy/route may be unavailable while browser, command and MCP work must
    // remain live; the regular daemon heartbeat retries this bounded operation.
    diagnose('connect', error)
    connected = null
  }
  return {
    state: desiredState,
    supervisor: {
      heartbeat: async () => {
        let stage: 'connect' | 'heartbeat' = connected ? 'heartbeat' : 'connect'
        if (!connected && Date.now() < claimNotBefore) return
        try {
          if (!connected) await connect(desiredState)
          const live = connected
          if (!live) return
          // The claim answers before the socket opens, and the socket retries
          // on its own. A heartbeat sent into a socket still opening fails as
          // unreachable; counted against the claim it closed the socket, the
          // next heartbeat claimed afresh (two challenges), and the loop kept
          // the shared challenge bucket empty. So: the first heartbeat waits
          // for `connected`, and from here on a failure is the heartbeat's.
          if (stage === 'connect') {
            const ready = await socketReady(live.session)
            if (ready !== true) return
          }
          stage = 'heartbeat'
          await live.session.heartbeat()
          if (lastFailure !== null) {
            lastFailure = null
            console.error('[nessie-executor] local inference host recovered.')
          }
        } catch (error) {
          diagnose(stage, error)
          // Nessie refused the host itself: claim afresh next time. A dropped
          // socket or a busy local server is not a refusal and keeps the host.
          if (stage === 'connect' || error instanceof LocalInferenceApiError && error.status !== undefined) {
            await disconnect()
          }
        }
      },
      stop: disconnect,
      reconnect: async (nextState) => {
        try {
          return await connect(nextState)
        } catch {
          connected = null
          return nextState
        }
      },
    },
  }
}
