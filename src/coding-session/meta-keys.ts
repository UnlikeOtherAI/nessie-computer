/**
 * The reserved `_meta` keys of a call to a built-in bridge. Only the daemon
 * sets them, only on calls to the executor's own coding-sessions bridge, and
 * the model — which reaches `arguments` and nothing else — cannot:
 *
 *   nessie/owner           the owner key derived from the command's stamped owner
 *   nessie/command         the executor command id, which makes a replay a no-op
 *   nessie/daemon-control  `true` on the daemon's own teardown and report calls
 *   nessie/command-rules   this computer's command rules, which decide what a terminal session may start
 */
export const CODING_SESSION_OWNER_META = 'nessie/owner'
export const CODING_SESSION_COMMAND_META = 'nessie/command'
export const CODING_SESSION_DAEMON_CONTROL_META = 'nessie/daemon-control'
export const CODING_SESSION_COMMAND_RULES_META = 'nessie/command-rules'
export const CODING_SESSION_AUTHORITY_META = 'nessie/session-authority'
export const CODING_SESSION_PAIRING_SOURCE_META = 'nessie/session-pairing-source'
export const CODING_SESSION_CONNECTION_META = 'nessie/session-connection'
