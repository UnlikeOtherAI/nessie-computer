import type { ChildProcess } from 'node:child_process'
import { Transform, Writable, type Readable } from 'node:stream'
import type { T3EffectGrantReference } from '@nessie/executor-protocol/t3-session'
import type { OwnedAgentProcess } from './agent-process.js'
import { effectTransport } from './effect-transport.js'
import { SessionEffectAuthority, SessionEffectRefused } from './session-effect-authority.js'
import { isT3EffectScope, sameT3EffectTarget } from './session-effect-scope.js'
import { AGENT_FRAME_BYTES, ProviderReplyLedger, readAgentFrame,
  type AgentFrameBytes, type ProviderRequestId } from './agent-byte-frames.js'

export class AgentSerializationAuthorityRequired extends Error {
  constructor() { super('Original operation must bind the protocol frame before SDK serialization is queued') }
}

export type AgentByteProcess = Pick<OwnedAgentProcess, 'identity' | 'exited' | 'alive' | 'confirmHostExecutionStopped'> & {
  /** Generic SDK stdin cannot associate later queued bytes with their admitted original operation. */
  stdin: Writable
  stdout: Readable
  stderr: Readable
  rawExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  closed: Promise<void>
  onError: (listener: (error: Error) => void) => () => void
  /** Exactly one logical UTF8/NDJSON frame; chunks may split code points, never operation authority. */
  write: (bytes: AgentFrameBytes, effect: SessionEffectAuthority) => Promise<void>
  replyUnsupported: (id: ProviderRequestId) => Promise<void>
  endInput: () => Promise<void>
}

type OwnedAgent = OwnedAgentProcess & { child: ChildProcess; rawExit: AgentByteProcess['rawExit']; closed: Promise<void> }

/** Called by startAgentByteProcess after the packaged creator and signed launch handshake. No spawn fallback. */
export const createAgentByteTransport = (owned: OwnedAgent, original: T3EffectGrantReference): AgentByteProcess => {
  const { child } = owned
  const transport = effectTransport(child)
  if (!transport || !child.stdout || !child.stderr) throw new SessionEffectRefused()
  const replies = new ProviderReplyLedger(original.nativeAssociation.driver)
  let failed = false, ended = false, queuedBytes = 0, queuedOperations = 0
  let queue: Promise<void> = Promise.resolve()
  const usedCommands = new Set([original.commandId])
  const fail = (): void => { failed = true; replies.close() }
  child.once('error', fail)
  child.once('exit', fail)
  child.stdout.once('error', fail)
  child.stderr.once('error', fail)
  const stdout = new Transform({ highWaterMark: 64 * 1024, transform(chunk: Buffer, _encoding, callback) {
    replies.observe(chunk)
    callback(null, chunk) // Exact bytes, with normal Readable/Writable backpressure.
  } })
  child.stdout.on('error', error => stdout.destroy(error))
  stdout.once('close', () => { if (!stdout.readableEnded) fail() })
  child.stdout.pipe(stdout)

  const enqueue = (size: number, operation: () => Promise<void>): Promise<void> => {
    if (failed || ended || queuedOperations >= 8 || queuedBytes + size > 2 * AGENT_FRAME_BYTES) {
      return Promise.reject(new SessionEffectRefused())
    }
    queuedOperations++; queuedBytes += size
    const task = queue.then(async () => {
      if (failed || ended) throw new SessionEffectRefused()
      await operation()
      if (failed) throw new SessionEffectRefused()
    }).finally(() => { queuedOperations--; queuedBytes -= size })
    queue = task.catch(fail)
    return task
  }
  const endInput = (): Promise<void> => enqueue(0, async () => {
    await transport.broker.send('end', '')
    ended = true
  })
  const stdin = new Writable({ highWaterMark: 64 * 1024,
    write(_chunk, _encoding, callback) { callback(new AgentSerializationAuthorityRequired()) },
    final(callback) { void endInput().then(() => callback(), error => callback(error as Error)) },
  })
  // Consumers receive the write callback error. Avoid an unhandled event before an SDK installs listeners.
  stdin.on('error', () => undefined)

  return {
    identity: owned.identity, exited: owned.exited, alive: owned.alive,
    confirmHostExecutionStopped: owned.confirmHostExecutionStopped,
    rawExit: owned.rawExit, closed: owned.closed, stdin, stdout, stderr: child.stderr,
    onError: listener => { child.on('error', listener); return () => { child.off('error', listener) } },
    write: async (bytes, effect) => {
      if (!(effect instanceof SessionEffectAuthority)) throw new SessionEffectRefused()
      const selected = effect.scope
      if (!isT3EffectScope(selected) || !sameT3EffectTarget(original, selected)
        || usedCommands.has(selected.commandId) || usedCommands.size >= 4096) throw new SessionEffectRefused()
      const frame = readAgentFrame(bytes)
      // This does not produce the missing original-operation/SDK-message association.
      // Its reviewed serialization owner must call this explicitly for each finite admitted frame.
      usedCommands.add(selected.commandId)
      return enqueue(Buffer.byteLength(frame.text), async () => {
        await effect.consume()
        effect.assertLive()
        replies.claimResponse(frame.value)
        await transport.broker.send('input', frame.text, effect)
      })
    },
    replyUnsupported: id => enqueue(512, async () => {
      await transport.broker.send('reply', replies.unsupported(id))
    }),
    endInput,
  }
}
