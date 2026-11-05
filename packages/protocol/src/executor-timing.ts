/**
 * The time limits of the executor's local-MCP lane, in one place.
 *
 * Two processes enforce them: the daemon bounds a session start and a tool call
 * on the machine, and the worker stamps each `mcp.tools` / `mcp.call` command
 * with an expiry. The expiry must outlast everything that can happen to the
 * command between the worker creating it and its result arriving — a cold
 * start, the call itself, its uploads, and the lane's own hops. When it did
 * not, a slow browser navigation expired its command mid-call, and an expired
 * command is an unknown outcome that aborts the run.
 */

/** A server that cannot say what it is within ten seconds is not going to. */
export const EXECUTOR_MCP_START_TIMEOUT_MS = 10_000

/**
 * One tool call, or one `tools/list` page: long enough for a real-device
 * screenshot or a navigation, short enough that a wedged server cannot hold a
 * command past its expiry.
 */
export const EXECUTOR_MCP_CALL_TIMEOUT_MS = 60_000

/**
 * Room for one result's attachment uploads — up to six images, 8 MiB — on a
 * 2 Mbit/s uplink, with Nessie's own work on each image (the daemon's
 * `executor/test/mcp-timing.test.ts` pins the sum).
 */
export const EXECUTOR_MCP_UPLOAD_BUDGET_MS = 50_000

/** Queue claim, daemon poll, three receipts, journal fsyncs. */
export const EXECUTOR_COMMAND_OVERHEAD_MS = 20_000

/** The expiry of an `mcp.tools` or `mcp.call` command: 140 s. */
export const EXECUTOR_MCP_COMMAND_TTL_MS =
  EXECUTOR_MCP_START_TIMEOUT_MS
  + EXECUTOR_MCP_CALL_TIMEOUT_MS
  + EXECUTOR_MCP_UPLOAD_BUDGET_MS
  + EXECUTOR_COMMAND_OVERHEAD_MS

/**
 * How far past its command's expiry the worker's own per-tool timeout sits, so
 * the expiry — a replay-safe unknown outcome — is what ends a slow command, and
 * the tool timeout is only the backstop behind it.
 */
export const EXECUTOR_TOOL_TIMEOUT_MARGIN_MS = 10_000
