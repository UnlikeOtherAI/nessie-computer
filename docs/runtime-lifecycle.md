# Team lifecycle on the computer: saving, pausing and program requests

These are the plumbing commands the Nessie Computer apps call for one team,
named by its state directory. Each works whether or not the team's daemon is
running, and none of them restarts it. The user-facing `nessie-computer` verbs
in tranche F map onto them.

| Command | What it does |
|---|---|
| `configure --configuration-input-stdin --state-dir <dir>` | Saves the team's access as the next revision. A running team applies it within a second. |
| `pause --state-dir <dir> [--json]` | Pauses the team on this computer until `resume`. |
| `resume --state-dir <dir> [--json]` | Ends the pause. |
| `program-requests --state-dir <dir> [--json]` | Lists the program requests waiting for an answer. |
| `program-request answer --state-dir <dir> --id <id> --answer once\|always\|deny [--json]` | Answers one request. |
| `audience --state-dir <dir> [--json]` | Asks Nessie who can send work here: agents, people and projects. Nothing is stored. |
| `describe --state-dir <dir>` | Also reports `paused`, `pendingProgramRequests` and the discovered `localApps`. |

With `--json`, a failure of `pause`, `resume`, `program-requests`,
`program-request answer` or `audience` prints one line on standard output and
exits with 1:

```json
{ "error": { "code": "PROGRAM_REQUEST_NOT_WAITING", "message": "That program request is no longer waiting: …" } }
```

| `code` | Meaning |
|---|---|
| `EXECUTOR_STATE_UNAVAILABLE` | The state directory cannot be read as a team. |
| `PROGRAM_REQUEST_ID_INVALID` | The id is not one `program-requests` lists. |
| `PROGRAM_REQUEST_NOT_WAITING` | The request was answered, expired, or its team stopped. |
| `PROGRAM_REQUEST_ALREADY_ANSWERED` | Another answer reached it first. |
| `PROGRAM_REQUEST_RULE_NOT_SAVED` | "Always" could not save the rule; the request still waits. |
| `EXECUTOR_NOT_CONNECTED` | `audience` needs a team that has connected. |
| Nessie's own code | Nessie refused the call, for example `EXECUTOR_API_TIMEOUT` or `EXECUTOR_CONNECTION_FENCED`. |
| `EXECUTOR_COMMAND_FAILED` | Anything else; the message says what. |

Without `--json`, failures are a sentence on standard error, as for every other verb.

## Saving applies live

`configure` writes the new state through the compare-and-set writer, as it
always has. The running daemon checks the identity of its saved state file
four times a second (`src/daemon-local-watch.ts`). When it changes, the daemon:

1. Reads the saved state and keeps its own connection epoch
   (`src/daemon-live-apply.ts`). From the next command on, everything is
   checked against the new policy. A narrowed rule holds before Nessie has
   heard about it.
2. Signs the new revision and submits it under its current connection epoch.
   Nessie makes it the active revision. A command Nessie signed against the
   earlier revision is refused with `EXECUTOR_DESCRIPTOR_STALE`, as after a
   restart. A failed submission is retried with every heartbeat.
3. Rebuilds its local MCP servers and the coding-sessions bridge only when their
   launch specs, the bridge's reviewed facts or the limits changed. It does so
   between two commands, so no command is using them. Browser, guest and coding
   sessions keep running. Command rules are not a reason to rebuild: the bridge
   stamps every call with the rules that hold at that moment.

The single-writer rule is unchanged. The owner's commands write the state. The
daemon writes it in two cases only: its claim records the connection epoch,
and when Nessie already holds the same revision number with different content,
the daemon saves the next revision, as a claim does.

Code proposes a revision by saving it through the same writer; the running
daemon applies it the same way. The daemon does this itself for local apps:
under the `installed` local-apps policy it runs discovery when it starts and
every two minutes after (`refreshLocalApps` in `src/local-mcp-apps.ts`). A local app installed, removed
or switched off is saved as the next revision and applied live.

`configure --configuration-input-stdin` passes `mcpPolicy` and `allowedOrigins`
to the writer with the rest of the input. A key the input leaves out keeps what
is saved. That includes `commandPolicy.trusted`: a proposal without it keeps the
saved built-in programs.

## Pause

`pause` writes `owner-pause.json` (`{ "paused": true, "since": "<iso>" }`,
owner-only) beside the team's state. `resume` removes it. Pausing a team that is
already paused keeps the original `since`.

While paused, the daemon:

- stays connected;
- refuses every new command with `EXECUTOR_OWNER_PAUSED`, except
  `sandbox.stop`, which only ends work;
- lets running work finish;
- drains the team's local model host, so it takes no new generations;
- heartbeats with `ownerPaused: true`. The heartbeat goes as soon as the pause
  is saved.

A pause file the daemon cannot read counts as paused. A daemon, `connect` or
`heartbeat` started while the team is paused comes up paused, so restarts,
automatic restarts and updates keep the pause.

An older Nessie refuses a heartbeat that carries `ownerPaused`. Its strict
parsing answers `400 VALIDATION_ERROR` naming the field. The daemon then sends
the heartbeat again without the field, keeps doing so for the rest of that
connection, and logs once that Nessie cannot show the pause. The team stays
paused on the computer.

## Program requests

When the team's rules refuse a launch only because the program is not on the
allowlist, the daemon asks the owner instead of refusing it at once. This
covers a sandboxed `command.run`, and a terminal session that the
coding-sessions bridge would start on this computer. Two refusals are asked
about: `not_allowlisted`, and for a terminal `path_needs_allow_all` (a program
named by its path while only listed programs may start). For a terminal the
daemon makes the bridge's own decision first, signature check included, so an
app signed by UnlikeOtherAI starts without a question. A launch the denylist
refuses, or one refused for any other reason, is refused without asking.

The daemon writes the request to `program-requests/<id>.json` in the team's
owner-only state directory and holds the launch. The hold lasts at most 120
seconds and always ends 5 seconds before the command's own expiry, so the result
can reach Nessie in time. When that leaves less than 5 seconds, nobody is asked
and the launch is refused as before.

The owner answers on the computer:

- `once` runs this launch and saves nothing. A program named by its path runs
  with every program not denied allowed for that one launch, because no rule can
  name a path.
- `always` first saves `<program> *` to the allowlist through the ordinary
  policy writer, which the running team applies live. Then this launch runs.
  If the save fails, the request keeps waiting for another answer. A program
  named by its path is saved by its file name (`htop *`, without `.exe` on
  Windows): later launches by name start without asking, a launch by path still
  asks.
- `deny` refuses the launch with `reason: "owner_declined"`.

No answer in time refuses it with `reason: "owner_did_not_answer"`. Both
refusals use `code: "EXECUTOR_COMMAND_DENIED"` with a message the agent can read.
Only one answer per request is accepted.

`program-requests --json` prints
`[{ "id", "program", "args", "requestedAt", "expiresAt" }]`. Here `expiresAt`
is when the daemon stops waiting. Nessie sends no agent name with a command,
so `agentName` is never present. With `--json`, `program-request answer` prints
the requests still waiting.

### What the agent sees while it waits

The agent's tool call stays open until the owner answers or the hold ends. The
daemon runs one command at a time per team, so while a request waits, every
other command for that team waits behind it. A short command can expire in that
queue: file operations have a 25-second lifetime in Nessie. Nessie is not told
that the command is waiting for the owner.

## Limits

- A launch's lent rules are safe only because the daemon runs one command at a
  time. A second loan while one is active is refused.
- When the allowlist already holds its maximum of 64 rules, nobody is asked.
- `audience` needs a connected team: it signs with the connection epoch the
  team's daemon last claimed.
