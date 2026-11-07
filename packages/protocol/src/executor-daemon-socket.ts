import { z } from 'zod'

/**
 * The daemon's doorbell. An executor holds one WebSocket to Nessie at
 * `/api/executor-daemon/socket`, authenticated exactly as its
 * `POST /api/executor-daemon/commands/poll` is. Nothing of substance travels
 * on it: a frame only says which signed HTTP exchange to run now, so every
 * payload keeps the one verified path it already has. While the socket is
 * open the daemon's polls fall back to `pollSeconds`; when it drops they
 * return to their one-second cadence until it reconnects.
 *
 * The other direction needs no frame: when a session changes on the computer
 * — a turn ends, a request opens or settles — the daemon runs its session
 * exchange at once, so Nessie hears within a second whether or not anybody
 * is watching.
 */
export const ExecutorDaemonWakeTopicSchema = z.enum(['commands', 'session_views', 'heartbeat'])
export type ExecutorDaemonWakeTopic = z.infer<typeof ExecutorDaemonWakeTopicSchema>

export const ExecutorDaemonSocketServerFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    /** How often to poll while this socket stays open. */
    pollSeconds: z.number().int().min(5).max(60),
  }).strict(),
  z.object({
    type: z.literal('wake'),
    topics: z.array(ExecutorDaemonWakeTopicSchema).min(1).max(3),
  }).strict(),
])
export type ExecutorDaemonSocketServerFrame = z.infer<typeof ExecutorDaemonSocketServerFrameSchema>

export const EXECUTOR_DAEMON_SOCKET_PATH = '/api/executor-daemon/socket'

/**
 * The upgrade request carries the command poll's own signed proof, as headers
 * because a WebSocket handshake has no body: the poll's payload
 * `{connectionEpoch, executorId, observedAt}` as JSON in
 * `x-nessie-executor-poll`, and its `poll`-domain signature
 * (`nessie.executor.daemon.poll.v1`) in `x-nessie-executor-signature`. The
 * server verifies them exactly as it verifies a poll, including the
 * `observedAt` freshness window, before it accepts the upgrade.
 */
export const EXECUTOR_DAEMON_SOCKET_POLL_HEADER = 'x-nessie-executor-poll'
export const EXECUTOR_DAEMON_SOCKET_SIGNATURE_HEADER = 'x-nessie-executor-signature'
