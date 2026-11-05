import { createLocalInferenceDaemonApi } from './local-inference-api.js'
import { LocalInferenceClaimScheduler } from './local-inference-claims.js'
import { LocalInferenceHostLoop, type LocalInferenceHostIdentity } from './local-inference-host.js'
import { LocalInferenceHostSocket, type LocalInferenceSocketLike } from './local-inference-socket.js'

type LoopDependencies = ConstructorParameters<typeof LocalInferenceHostLoop>[0]

export type LocalInferenceHostSession = {
  /** Settles when the socket first reaches `connected`. */
  connected: Promise<void>
  loop: LocalInferenceHostLoop
  /** The inventory report: the only thing the host sends on a timer. */
  heartbeat: () => Promise<void>
  /** Settles when the server refused this connection's authority; the owner then claims afresh. */
  refused: Promise<void>
  stop: () => Promise<void>
}

/**
 * One claimed host: its socket, the relay loop on it, and the claims the
 * socket's pushes trigger. The paired executor and Desktop's direct runtime
 * both run exactly this; neither has a poll of its own.
 */
export const startLocalInferenceHostSession = (input: Omit<LoopDependencies, 'transport' | 'identity'> & {
  apiBaseUrl: string
  identity: LocalInferenceHostIdentity
  /** Test seams: the socket and its one-use challenge. */
  open?: (url: string) => LocalInferenceSocketLike
  challenge?: () => Promise<string>
  onError?: (error: unknown) => void
}): LocalInferenceHostSession => {
  const http = createLocalInferenceDaemonApi({ apiBaseUrl: input.apiBaseUrl })
  let markRefused: () => void = () => undefined
  let markConnected: () => void = () => undefined
  const refused = new Promise<void>((resolve) => { markRefused = resolve })
  const connected = new Promise<void>((resolve) => { markConnected = resolve })
  // The loop and the scheduler are created before the socket can deliver a push.
  const holder: { loop?: LocalInferenceHostLoop; claims?: LocalInferenceClaimScheduler } = {}
  const socket = new LocalInferenceHostSocket({
    apiBaseUrl: input.apiBaseUrl,
    identity: input.identity,
    challenge: input.challenge
      ?? (async () => (await http.issueChallenge({ hostId: input.identity.hostId })).challenge),
    onPush: (message) => {
      if (message.type === 'control') holder.loop?.applyControl(message.attemptId, message.state)
      // A sibling's work is announced so it never holds the shared slot; only the addressed host claims.
      else if (message.hostId === input.identity.hostId) holder.claims?.available()
    },
    onReady: () => { markConnected(); holder.claims?.available() },
    onRefused: () => markRefused(),
    ...(input.open ? { open: input.open } : {}),
  })
  const loop = new LocalInferenceHostLoop({ ...input, transport: socket })
  const claims = new LocalInferenceClaimScheduler(loop, {
    onError: input.onError ?? ((error) => {
      console.error('[nessie-executor] local inference claim failed:', error instanceof Error ? error.message : String(error))
    }),
  })
  holder.loop = loop
  holder.claims = claims
  socket.start()
  return {
    connected,
    loop,
    heartbeat: () => loop.heartbeat(),
    refused,
    stop: async () => {
      await claims.stop()
      socket.stop()
    },
  }
}
