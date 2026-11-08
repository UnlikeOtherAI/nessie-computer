# Sessions and concurrent commands

Contract §11 ([Nessie Computer contract](plans/2026-11-08-nessie-computer.md#11-asynchronous-computer-sessions-and-concurrent-commands-wave-2-a3--d2))
made every piece of work on a computer part of a **session**, with sessions
and the commands inside them running side by side. This page is the exact wire
contract between the computer's daemon and Nessie, and the local shapes the
apps read. The schemas are in `packages/protocol/src/executor-sessions.ts` and
`packages/protocol/src/executor.ts`; where this page and the schemas differ,
the schemas win and this page is wrong.

## Opt-in and fallback

A daemon opts in on every command poll by sending `concurrency: 1`. Nessie
answers that poll in the concurrent shape below. A poll without `concurrency`
is the one-command-at-a-time poll every daemon has sent, and Nessie keeps
answering it exactly as before.

A Nessie that predates this answers a concurrent poll with
`400 VALIDATION_ERROR` naming one of the new fields, because it parses polls
strictly. The daemon then sends the old poll for the rest of that connection
epoch and tries the concurrent one again after its next claim. A `200` answer
without `commands` is read as the old shape too, and the command it carries is
run. **Ship order:** Nessie implements the concurrent answer, and verifies the
signature over the whole concurrent payload, before it pins a protocol
revision that lets daemons send it. A Nessie that pins this protocol but
verifies only the old fields refuses the poll's signature, and the daemon
cannot tell that from a real authentication failure.

## The poll request

`POST /api/executor-daemon/commands/poll`, signed in the `poll` domain
(`nessie.executor.daemon.poll.v1`) over the canonical JSON of every field but
`signature`. Optional fields join the signed payload only when present.

```json
{
  "concurrency": 1,
  "connectionEpoch": "42",
  "executorId": "<uuid>",
  "observedAt": "2026-11-08T12:00:00.000Z",
  "capacity": { "file": 16, "program": 3, "coding": 2, "browser": 1, "mcp": 8 },
  "activeCommands": [ <ExecutorCommandCancellationTarget>, … ],
  "waiting": [ { "commandId": "<uuid>", "for": "start" | "owner" }, … ],
  "stoppedSessions": [ "<session uuid>", … ],
  "signature": "<base64url>"
}
```

- `capacity`: free slots per kind when the poll was signed (0–64 each). The
  daemon counts every command it holds that is running or waiting to start; a
  command waiting for the owner holds no slot.
- `activeCommands`: every command the daemon holds without an acknowledged
  result receipt — waiting to start, waiting for the owner, running, or still
  reporting its result. Each entry is the `ExecutorCommandCancellationTarget`
  of the delivered envelope (`argumentDigest`, `bindingFence`, `bindingId`,
  `capabilityRevision`, `commandId`, `expiresAt`, `idempotencyKey`). At most 256.
- `waiting`: present only when a held command is not running. `start` waits
  for a free slot or for its resource; `owner` waits for the computer's owner
  to answer a program request. An active command not listed here is running.
- `stoppedSessions`: present only when the owner pressed **Stop** on the
  computer for sessions Nessie has not closed yet. The daemon repeats each id
  on every poll until a `sessionClose` names it.
- `activeCommand` (singular) never appears in a concurrent poll.

## The answer

```json
{
  "commands": [ <ExecutorCommandEnvelope with sessionId>, … ],
  "cancellations": [ <ExecutorCommandCancellation>, … ],
  "sessionClose": [ { "sessionId": "<uuid>", "reason": "run_ended" }, … ]
}
```

All three arrays are always present (empty when there is nothing). Nessie must:

1. **Fill capacity, not exceed it.** Count each command by
   `executorCommandCapacityKind(operationKey)`: `command.run` → `program`;
   `coding.*` → `coding`; `browser.*` → `browser`; `mcp.tools`, `mcp.call` →
   `mcp`; `file.*`, `workspace.*` → `file`; `sandbox.stop` → none, sent whatever
   is free. At most 64 commands per answer, oldest first, with per-session and
   per-person fairness as the tie-break (§11.4). Commands above capacity stay
   queued in Nessie. A daemon that is sent more than it reported free still
   takes them and runs them when slots free up, as **waiting to start**.
2. **Carry the session.** Every envelope in a concurrent answer carries
   `sessionId` (the session's UUID) and, for the owner's program requests,
   `agentName` (the agent's display name, at most 120 characters). Neither may
   appear in an answer to an old poll: older daemons parse the envelope
   strictly. Neither is inside `argumentDigest`.
3. **Re-deliver until accepted.** A command stays deliverable until its
   `accepted` receipt arrives, exactly as today; a lost answer is repaired by
   the next poll. The daemon ignores a command id it already holds, so
   re-delivering one it named in `activeCommands` is harmless but wasteful.
4. **Cancel only what was named.** Each cancellation is the active command's
   target plus `requestedAt` and must match an `activeCommands` entry field
   for field. The daemon ignores any other. A cancelled command reports
   `EXECUTOR_COMMAND_CANCELLED` through its ordinary receipts.
5. **Close sessions.** Send `{ sessionId, reason }` when the run ends, the
   owner chose Stop (reason `owner_stopped`, also for every id in
   `stoppedSessions`, including ones Nessie already closed), the lease ended,
   or the team was paused or disconnected. Known reasons: `run_ended`,
   `owner_stopped`, `lease_ended`, `team_paused`, `disconnected`; the daemon
   treats any other the same way.

## Doorbell

No new frame. While a concurrent daemon's doorbell is open, Nessie sends
`{ "type": "wake", "topics": ["commands"] }` when it queues a command for that
computer, requests a cancellation, or closes a session, so the daemon polls at
once. Polling stays the fallback: once a second without a doorbell, and while
the doorbell is open every `pollSeconds` — but at least every 5 seconds while
the daemon holds a command, and at once whenever a command starts or stops
waiting or the owner stops a session.

## Receipts

Receipts stay per command and unchanged: `accepted` when the daemon has
journaled the command, `started` when it leaves "waiting to start" and begins,
`result_acknowledged` with the result. A command waiting for the owner has
already been `started`. Results the daemon adds:

| Code | When |
|---|---|
| `EXECUTOR_COMMAND_CANCELLED` | Nessie cancelled it, or its session was closed while it was held. |
| `EXECUTOR_SESSION_STOPPED` | The owner stopped its session on the computer (`reason: "owner_stopped"`). Later commands in that session get it too until Nessie closes the session. |
| `EXECUTOR_SESSION_CLOSED` | It arrived for a session Nessie already closed. |
| `EXECUTOR_COMMAND_DENIED` + `reason: "owner_declined" \| "owner_did_not_answer"` | The owner said no to its program request, or did not answer in time. |
| `EXECUTOR_OWNER_PAUSED` | The team was paused before it started. |
| `EXECUTOR_COMMAND_EXPIRED` | Its `expiresAt` passed while it waited to start. |

## What the daemon serialises

Only work that cannot overlap waits for other work; everything else runs at
once. Commands sharing a resource run one at a time, in the order they
arrived:

| Resource | Commands |
|---|---|
| A run's command sandbox | `command.run` with the same `payload.runId` |
| A run's browser | `browser.open\|observe\|act` with the same run; separately `browser.connected.*` |
| A run's coding sandbox | `coding.launch`, `coding.observe` with the same run |
| One path | `file.write` to the same path in the same run's draft (case folded on macOS and Windows) |
| A run's workspace draft | `workspace.review`, `workspace.promote` with the same run |
| One terminal | `mcp.call` to the coding-sessions bridge naming the same terminal session |

A local app's own calls are serialised by its MCP session, one request at a
time per local app; that is the daemon's MCP manager, not this queue.
`sandbox.stop` waits for nothing.

## Capacity

The daemon's limits, per computer and per session:

| Kind | Computer | Session |
|---|---|---|
| `file` | 16 | 8 |
| `program` | 4 | 2 |
| `coding` | 2 | 1 |
| `browser` | 2 | 1 |
| `mcp` | 8 | 4 |

Guest sandboxes are further limited by the descriptor's `limits.maxSessions`,
as before. While the team is paused every free slot reads 0.

## Program requests

A launch refused only because it is not allowed holds **only its own
command**: its slot and resources are released while it waits, and it queues
for them again once the owner allows it. It waits until the owner answers, at
most 15 minutes and never past the command's `expiresAt` less 5 seconds; a
window shorter than 5 seconds is refused without asking. **Nessie sets
`expiresAt` long enough for that wait** — at least 15 minutes plus the
command's own run time — on `command.run` and on `mcp.call` that starts a
terminal session through the coding-sessions bridge (`session_start` with
`agent: "terminal"`); a shorter expiry only shortens the wait. **Allow once**
applies to that one launch; **Always allow** saves `<program> *`.

## Recovery

The daemon journals one record per command in
`<runtime>/command-recovery/<commandId>.json` (owner-only). After a crash or
restart each record resumes on its own: one not yet `accepted` or not yet
started resumes where it stopped, waiting to start again if it was; one that
had started executing reports `EXECUTOR_COMMAND_UNKNOWN_OUTCOME`, because its
side effect may have happened; one with a result sends it again. A journal
left by an older daemon (`command-recovery.json`) is taken over at start.

## Local shapes the apps read

The daemon keeps `sessions.json` in the team's state directory (owner-only)
while it runs, rewritten whenever a command arrives, starts, waits or ends,
and removed when it stops. Two plumbing verbs read and change it:

```text
nessie-executor sessions --state-dir <dir> [--json]
nessie-executor session stop --state-dir <dir> --id <sessionId> [--json]
```

`sessions --json` prints an array, empty when the team's daemon is not
running. This is the shape the console's **Now working** reads
(`packages/executor-console/README.md`, "Host commands"); the apps' bridges
add `executorId` to each session:

```json
[{
  "sessionId": "<uuid>",
  "agentName": "Sales agent",
  "startedAt": "<iso>",
  "commands": [{
    "id": "<command uuid>",
    "kind": "program" | "file" | "coding" | "browser" | "mcp",
    "status": "running" | "queued" | "waiting_for_owner",
    "program": "npm", "args": ["test"],
    "operation": "read" | "write", "path": "report.md",
    "site": "docs.example.com",
    "app": "kelpie",
    "requestId": "<program request id>"
  }]
}]
```

- `sessionId` is Nessie's session. Commands from a Nessie that sends no
  session are grouped by their run, whose id stands in; the owner can still
  stop them, and they are never named back to Nessie as `stoppedSessions`.
- `startedAt` is when the daemon first saw work for the session.
  `agentName` is the latest the session's commands carried.
- `kind` is what the work is, for the console's words, and differs from the
  capacity kind in one place: a terminal the coding-sessions bridge starts is
  `program` with its `program` and `args`, and the bridge's other calls are
  `coding` (with `program` `claude` or `codex` when a session starts).
- `program`/`args` for a program; `operation` and `path` for a file
  (`file.list` and `workspace.review` read, `file.write` and
  `workspace.promote` write); `site` is the host of the URL a browser command
  opens, or the host the run last opened; `app` is the local app's name.
  A field the daemon cannot tell is absent. `sandbox.stop` is not listed.
- `requestId` is set on a `waiting_for_owner` command and is the `id` that
  `program-requests` lists for the request it waits on (shown under Needs you).

`session stop` asks the running daemon to stop the session: every command of
it ends with `EXECUTOR_SESSION_STOPPED`, its runs' sandboxes and browsers end,
its later commands are refused, and Nessie is told on the next poll. The stop
is kept in `session-stops/<sessionId>.json` until Nessie closes the session
(at most a day), so a restart does not undo it. The verb waits up to three
seconds for the daemon to apply it and prints the list after that with
`--json`. It fails with `SESSION_ID_INVALID` for an id that is not a UUID and
`SESSION_NOT_RUNNING` when the team's list does not show that session; with
`--json` a failure prints `{ "error": { "code", "message" } }` and exits 1.

`program-requests --json` entries gain `commandId`, `sessionId` and
`agentName` when the command carried them.

A person's `nessie-computer sessions [list|stop <id>]` (Command reference,
"Now working") reads and stops the same lists across teams; with
`--state-dir` the words are the apps' plumbing verbs above.

The apps' bridges mirror the verbs: `executor_sessions { executorId? }`
answers every team's sessions (or one team's) with `executorId` added, and
`executor_stop_session { executorId, sessionId }` answers the new list.
