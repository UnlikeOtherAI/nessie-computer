# Live coding sessions: the doorbell, requests and secrets

A coding session tells Nessie within a second when it changes, and asks its
owner when it needs them: approve a command or a file change, allow a tool,
answer a question, or supply a secret. The wire contract is
`packages/protocol/src/executor-session-requests.ts`,
`executor-session-view.ts` and `executor-daemon-socket.ts`; this page says how
the executor implements it.

## The doorbell

The daemon holds one WebSocket to `/api/executor-daemon/socket`
(`src/daemon-doorbell.ts`). The upgrade carries the command poll's own proof:
`x-nessie-executor-poll` is the poll payload `{connectionEpoch, executorId,
observedAt}` as JSON, and `x-nessie-executor-signature` its `poll`-domain
signature (`nessie.executor.daemon.poll.v1`). A new connection epoch reconnects
at once under the new proof.

| Doorbell | Command poll | Session exchange |
| --- | --- | --- |
| absent, refused or closed | every 1 s | every 1 s |
| open (`ready {pollSeconds}`) | every `pollSeconds` | every `pollSeconds`, or 1 s while the last answer named view requests or actions |
| `wake {topics}` | at once (`commands`) | at once (`session_views`); `heartbeat` runs the heartbeat |

A wake or a session change that arrives while that exchange is running runs it
once more as soon as it ends (`src/daemon-cadence.ts`). A frame the daemon
cannot read changes nothing. Reconnects back off from 1 s to 60 s with ±20 %
jitter; a server that has never once said `ready` (an older Nessie without the
route) is tried at most every five minutes, and meanwhile the daemon behaves
exactly as it did before the doorbell existed.

## Reporting a change at once

Every session host replaces `coding-sessions/session-changes.json` when a
session's status or pending requests change. The daemon stats that one file
every 125 ms (`src/session-change-watch.ts`); a burst becomes one session
exchange, about 100 ms later, carrying a fresh inventory page from its first
page whatever the 15 s inventory pace says. A changed session is the newest,
so it leads that page with its `pending` summary, watched or not.

Codex threads found open on the computer are re-read every five seconds from
Codex's state database (the first page of `thread/list`, never their history).
A thread whose active flags say `waitingOnApproval` or `waitingOnUserInput`
reports `pending {kind: approval | question, answerable: false}`; a change
reports at once. Nessie cannot answer for the client that owns such a thread.

## Requests

A request lives in its session's host (`src/coding-session/session-request-book.ts`)
and on disk in `sessions/<id>/requests.json`, which only that host writes.
Conversations carry the list as `requests`: every pending request, oldest
first, then the most recent settled ones, newest last, sixteen in all. Older
settled requests age out as new ones settle. A request ends unanswered with:

| Status | Reason | When |
| --- | --- | --- |
| `cancelled` | `turn_interrupted` | the owner interrupted the turn |
| `cancelled` | `session_closed` | the session closed |
| `cancelled` | `provider_cancelled` | Claude or Codex withdrew the prompt itself |
| `expired` | `turn_ended` | a Codex turn ended with the prompt still open |
| `expired` | `provider_exited` | the provider process exited, or its host stopped serving |
| `expired` | `executor_restarted` | no host is alive to answer it (read time), or a new host found it on disk |

Time a turn spends waiting on its owner does not count against
`maxTurnMinutes`.

### Answers

An `answer` action reaches the bridge as `session_answer`
(`src/coding-session/session-answer.ts`). It is checked against the request the
host last wrote, then claimed in `sessions/<id>/answers/<requestId>.json`, so a
request is answered once whichever answer arrives first. Receipts:

| State | Code | Meaning |
| --- | --- | --- |
| `accepted` | `answer_delivered` | on its way to the provider; the host checks it once more as it delivers it |
| `accepted` | `secret_saved` | the value is in its file; the agent is told where |
| `failed` | `request_not_pending` | answered, settled or aged out; also an unknown id or a second answer |
| `failed` | `request_not_answerable` | a session found open on the computer, or a request marked unanswerable |
| `failed` | `answer_shape_mismatch` | a decision the request does not offer, a missing or unknown question, more than one value for a single choice, a value outside the options where no custom answer is allowed, or a secret for a non-secret |
| `failed` | `secret_destination_invalid` / `secret_destination_refused` | the secret's file cannot be written safely; nothing was answered, so the owner may retry |
| `failed` | `coding_session_config_changed` | the reviewed configuration changed; nothing is answered until it is reviewed again |

A retried action (the same action id) reads its first outcome. Questions and
secrets also offer `decisions: ['decline', 'cancel']`: a decline turns the
request down and the turn continues; a cancel also stops the turn. Feedback with
a decline is told to the agent (Claude's deny message; Codex's running turn via
`turn/steer`).

## Claude Code

Managed Claude runs with `--permission-prompts host --permission-prompt-tool
stdio` (verified on 2.1.319). A `can_use_tool` control request becomes a
request (`src/coding-session/claude-requests.ts`): `Bash` a `command`, `Write`,
`Edit`, `MultiEdit` and `NotebookEdit` a `file_change`, `AskUserQuestion` a
`question` (any option, or the owner's own text), anything else a
`permission`. `accept_for_session` adds Claude's own suggested rules, or a rule
for the tool, with `destination: 'session'` and never to a settings file;
`cancel` denies with `interrupt: true`. The appended system prompt no longer
says prompts are denied. `--permission-prompt-tool` is the Agent SDK's own
option and `--help` never lists it, so the capability check requires
`--permission-prompts`, which names it.

## Codex

Managed Codex runs one `codex app-server` per live host (verified on 0.166.0):
`thread/start` for the first message, `thread/resume` in a later process,
`turn/start` per message and `turn/interrupt` for interrupt. A message sent
during a turn starts the next one. The reviewed arguments become the thread's
parameters (`codexPolicy` in `src/coding-session/codex-adapter.ts`):

| Reviewed arguments | `sandbox` | `approvalPolicy` |
| --- | --- | --- |
| none | `read-only` | `on-request` |
| `--sandbox X` / `-s X` | `X` | `on-request` |
| `--full-auto` | `workspace-write` | `on-request` |
| `--approve-for-me` | `workspace-write` | `on-request`, `approvalsReviewer: auto_review` |
| `--dangerously-bypass-approvals-and-sandbox` / `--yolo` | `danger-full-access` | `never` |

`--skip-git-repo-check` means nothing to an app-server and is ignored; any
other argument refuses the start (`agent_args_unsupported`), because what a
person reviewed must be what runs. The sandbox is always the reviewed one. With
`on-request`, Codex asks before it leaves that sandbox, and an approved command
runs outside it — verified on 0.166.0 under a read-only sandbox — so an
approval is the owner's own decision to let one command past the sandbox;
nothing passes it without one, as it did not under `exec`, where every such
request was refused. Codex's requests become requests
(`src/coding-session/codex-requests.ts`): command, file-change and permissions
approvals, `item/tool/requestUserInput` (an `isSecret` question is masked), MCP
elicitations whose form fields are all choices, yes/no or free text (anything
else, and every URL elicitation, is declined without asking), and the legacy
`execCommandApproval` / `applyPatchApproval`. DeepTest inference still reads
`codex exec --json` (`codex-exec-events.ts`).

## Secrets

Every managed Claude and Codex session is given one MCP server,
`nessie_session` (`nessie-executor serve-session-secrets --session-dir <dir>`),
with one tool, `request_secret {name, reason, destination, envName?}`. The call
leaves an ask in the session's `secret-asks/`; the host opens a `secret`
request; the owner's value is written by the bridge straight into
`destination` inside the session's named folder
(`src/coding-session/secret-destination.ts`) and the waiting call is told where
— never the value. The destination must be relative, without `..` or a drive;
every directory on the way is checked as it is reached and created 0700, a link
anywhere or a hard-linked file refuses the write, and the file is replaced by a
rename from a fresh 0600 file. With `envName` one `NAME=value` line is set or
replaced and every other line kept; without it the file is the value. Claude's
prompt for this tool is allowed without asking, and a Codex elicitation from
this server is accepted, because the secret request is the owner's gate. Codex
gives the call 24 hours.

The value travels from Nessie in the answer action, through the daemon's MCP
call to the bridge, into the file — and nowhere else: not the inbox, a log, a
receipt, a request, a conversation, the inventory or an error.

## Checks

`test/daemon-doorbell.test.ts` (a real socket upgrade, an older server's
refusal, backoff, cadence and the change watcher), `test/session-view-relay.test.ts`,
`test/existing-coding-sessions.test.ts`, `test/session-request-book.test.ts`
and `test/session-requests-live.test.ts` (the real bridge and host with the
scripted agent speaking both providers' prompts: answers, stale and double
answers, interrupt and provider exit while pending, secrets and their leaks)
run in the ordinary suite and `test:live-sessions`.
