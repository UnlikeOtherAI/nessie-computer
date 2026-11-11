import type { IMessageHeartbeat } from '../daemon-connection.js'
import type { DaemonLiveState } from '../daemon-live-state.js'
import type { ExecutorLocalState } from '../state-store.js'
import { IMessageBridge } from './imessage-bridge.js'
import { deliverIMessages } from './imessage-delivery.js'
import { ensureHostIMessageOperation } from './imessage-operation.js'

/**
 * iMessage's place in the daemon (`daemon-server.ts`): a bridge on a Mac and
 * nothing anywhere else. Delivery signs under whichever connection holds when
 * a batch goes, and a changed report rings the heartbeat; both are connected
 * once the daemon's live state and cadence exist.
 */
export const createDaemonIMessage = (
  stateDir: string, paused: () => boolean, platform: NodeJS.Platform = process.platform,
) => {
  const supported = platform === 'darwin'
  let live: DaemonLiveState | null = null
  let ring: () => void = () => undefined
  const bridge = supported
    ? new IMessageBridge({
      stateDir, supported, paused,
      deliver: (messages) => {
        if (!live) throw new Error('This team is not connected from this computer yet.')
        return deliverIMessages(live.current, messages)
      },
      onReportChanged: () => ring(),
    })
    : undefined
  return {
    bridge,
    /** Before the claim: a Mac's descriptor offers `imessage.send`, and no other computer's does. */
    prepareState: (state: ExecutorLocalState): Promise<ExecutorLocalState> =>
      ensureHostIMessageOperation(stateDir, state, supported ? 'macos' : platform === 'win32' ? 'windows' : 'linux'),
    /** What this heartbeat reports and who hears the switch in its answer; undefined off a Mac. */
    heartbeat: (): IMessageHeartbeat | undefined => bridge && {
      report: bridge.report(),
      onSwitch: (value) => bridge.applySwitch(value),
    },
    connect: (state: DaemonLiveState, onReportChanged: () => void): void => {
      live = state
      ring = onReportChanged
    },
  }
}
