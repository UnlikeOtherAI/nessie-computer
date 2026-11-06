import type { ExecutorSoftwareStatus } from '@nessie/executor-protocol'
import type { LocalInferenceHostLoop } from '../local-inference-host.js'
import { reportedSoftwareStatus } from './native-client.js'
import { executorSoftwareVersion } from './version.js'

/** Shared by the direct local host and the personal-plan credential actor.
 * A failed update check never becomes an authentication failure or abort signal.
 */
export const watchInferenceUpdateDrain = (input: {
  loop: Pick<LocalInferenceHostLoop, 'drain' | 'resume' | 'isIdle'>
  readStatus?: () => Promise<ExecutorSoftwareStatus>
  installedVersion?: string
  intervalMs?: number
}): { ready: Promise<string>; stop: () => void } => {
  let target: string | null = null
  let stopped = false
  let working: Promise<void> | undefined
  let complete!: (version: string) => void
  const ready = new Promise<string>((resolve) => { complete = resolve })
  const tick = (): void => {
    if (stopped || working) return
    working = (async () => {
      const status = await (input.readStatus ?? reportedSoftwareStatus)()
      if (stopped) return
      if (status.canInstall && typeof status.draining === 'boolean') {
        target = status.draining && status.targetVersion
          && status.targetVersion !== (input.installedVersion ?? executorSoftwareVersion())
          ? status.targetVersion : null
      }
      if (target) {
        await input.loop.drain()
        if (!stopped && input.loop.isIdle()) complete(target)
      } else input.loop.resume()
    })().catch(() => undefined).finally(() => { working = undefined })
  }
  const timer = setInterval(tick, input.intervalMs ?? 5000)
  tick()
  return { ready, stop: () => { stopped = true; clearInterval(timer) } }
}
