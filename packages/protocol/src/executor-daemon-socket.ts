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
  /**
   * Sent every `EXECUTOR_DAEMON_SOCKET_BEAT_SECONDS` while nothing else is, so
   * a daemon that hears nothing for three beats knows the socket is half-open
   * (a silent NAT drop) and reconnects instead of waiting for TCP to notice.
   */
  z.object({ type: z.literal('beat') }).strict(),
])
export type ExecutorDaemonSocketServerFrame = z.infer<typeof ExecutorDaemonSocketServerFrameSchema>

export const EXECUTOR_DAEMON_SOCKET_PATH = '/api/executor-daemon/socket'
export const EXECUTOR_DAEMON_SOCKET_BEAT_SECONDS = 20

/**
 * The daemon's first and only message, sent as soon as the socket opens: the
 * body of its `POST /api/executor-daemon/commands/poll` and that body's
 * `poll`-domain signature (`nessie.executor.daemon.poll.v1`), so the server
 * admits it exactly as it admits a poll, freshness window included. The local
 * inference host socket opens the same way. The server answers `ready` or
 * closes with 4401; any later message from the daemon closes the socket.
 */
export const ExecutorDaemonSocketConnectSchema = z.object({
  type: z.literal('connect'),
  executorId: z.string().uuid(),
  connectionEpoch: z.string().regex(/^\d{1,20}$/u),
  observedAt: z.string().datetime(),
  signature: z.string().min(1).max(256),
}).strict()
export type ExecutorDaemonSocketConnect = z.infer<typeof ExecutorDaemonSocketConnectSchema>
