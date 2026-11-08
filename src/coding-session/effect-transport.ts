import type { ChildProcess } from 'node:child_process'
import type { Duplex } from 'node:stream'
import { EffectBroker, EffectPipe } from './effect-channel.js'
import { SessionEffectAuthority, SessionEffectRefused } from './session-effect-authority.js'

type Transport = { broker: EffectBroker; ready: Promise<void> }
const transports = new WeakMap<ChildProcess, Transport>()

/** Called only by our own spawn owner, with an explicit private inherited pipe. */
export const attachEffectTransport = (
  child: ChildProcess, fd: number, reference: unknown, launch: { command: string; args: string[]; cwd: string },
): void => {
  const effect = SessionEffectAuthority.fromReference(reference)
  const stream = child.stdio[fd] as Duplex | undefined
  if (!effect || !stream) throw new SessionEffectRefused()
  const pipe = new EffectPipe(stream), broker = new EffectBroker(pipe, effect.scope)
  const ready = broker.send('launch', JSON.stringify(launch), effect)
  void ready.catch(() => undefined) // startAgentProcess awaits the exact outcome.
  transports.set(child, { broker, ready })
  child.once('exit', () => pipe.close())
  child.once('error', () => pipe.close())
}
export const effectTransport = (child: ChildProcess): Transport | undefined => transports.get(child)
