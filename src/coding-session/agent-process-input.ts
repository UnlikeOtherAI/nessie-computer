import type { ChildProcess } from 'node:child_process'
import { automaticProviderReply } from './effect-channel.js'
import { effectTransport } from './effect-transport.js'
import { SessionEffectRefused, type SessionEffectAuthority } from './session-effect-authority.js'
import { isT3EffectScope } from './session-effect-scope.js'

/** A write callback acknowledges the pipe, never provider consumption. No late callback revives a failed write. */
export const writeAgentPipe = (child: ChildProcess, text: string): Promise<void> => new Promise((resolve, reject) => {
  const stream = child.stdin
  if (!stream?.writable || child.exitCode !== null || child.signalCode !== null) {
    reject(new SessionEffectRefused()); return
  }
  let settled = false
  const finish = (error?: Error | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    child.off('exit', refused); child.off('error', refused)
    stream.off('error', refused); stream.off('close', refused)
    if (error) reject(error); else resolve()
  }
  const refused = (): void => finish(new SessionEffectRefused())
  const timer = setTimeout(refused, 10_000)
  child.once('exit', refused); child.once('error', refused)
  stream.once('error', refused); stream.once('close', refused)
  try { stream.write(text, finish) } catch { refused() }
})

/** One ordered input lane for automatic replies and human operations, with awaited receiver outcomes. */
export const createAgentProcessInput = (child: ChildProcess) => {
  let queue: Promise<void> = Promise.resolve()
  let failed = false
  let ended = false
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const pending = queue.then(async () => {
      if (failed || ended) throw new SessionEffectRefused()
      await operation()
    })
    // An uncertain write closes this lane. Neither another command nor a late ACK can repair it.
    queue = pending.catch(() => { failed = true })
    return pending
  }
  const send = (text: string, protocol: boolean, effect?: SessionEffectAuthority): Promise<void> => (
    enqueue(async () => {
      if (effect && isT3EffectScope(effect.scope)) throw new SessionEffectRefused()
      if (protocol && !automaticProviderReply(text)) throw new SessionEffectRefused()
      const transport = effectTransport(child)
      if (transport) return transport.broker.send(protocol ? 'reply' : 'input', text, effect)
      await effect?.consume()
      effect?.assertLive()
      await writeAgentPipe(child, text)
    })
  )
  return {
    write: (text: string, effect?: SessionEffectAuthority) => send(text, false, effect),
    writeProtocol: (text: string) => send(text, true),
    endInput: (end: () => void, effect?: SessionEffectAuthority): Promise<void> => enqueue(async () => {
      if (effect && isT3EffectScope(effect.scope)) throw new SessionEffectRefused()
      const transport = effectTransport(child)
      if (transport) await transport.broker.send('end', '', effect)
      else { await effect?.consume(); effect?.assertLive() }
      end()
      ended = true
    }),
  }
}
