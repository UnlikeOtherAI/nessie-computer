# Live coding sessions: the doorbell, requests and secrets

A coding session tells Nessie within a second when it changes, and asks its
owner when it needs them: approve a command or a file change, allow a tool,
answer a question, or supply a secret. The wire contract is
`packages/protocol/src/executor-session-requests.ts`,
`executor-session-view.ts` and `executor-daemon-socket.ts`; this page says how
the executor implements it.

## The doorbell

The daemon holds one WebSocket to `/api/executor-daemon/socket`
(`src/daemon-doorbell.ts`). Its first and only message, sent when the socket
opens, is the command poll's own proof — `{type: 'connect', connectionEpoch,
executorId, observedAt, signature}`, the signature in the `poll` domain
(`nessie.executor.daemon.poll.v1`) — as the local inference host socket opens.
Nessie answers `ready` or closes with 4401. A new connection epoch reconnects at
once under the new proof.

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

Once ready, Nessie sends `{type: 'beat'}` every
`EXECUTOR_DAEMON_SOCKET_BEAT_SECONDS` (20) while it has nothing else to say. A
socket that carries no frame at all for three beats is half-open — a NAT
dropped it without either end hearing — so the daemon drops it, polls every
second again and reconnects after the first backoff, rather than sitting on
its slow pace while no wake can reach it.

## What only a newer Nessie reads

A session row's `pending` summary and a conversation's `requests` are new
fields inside schemas an older Nessie parses strictly: a heartbeat or session
exchange carrying either is refused whole there, and the computer goes offline
while anything waits — a Codex thread waiting on its own client included. An
older Nessie has no doorbell either, so the doorbell is the proof: a `ready`
answered to the connect proof of the **current** connection epoch says this
Nessie reads them (`src/owner-requests-gate.ts`). Until then the daemon leaves
both fields out of the heartbeat's local-MCP report and the session exchange,
and sends everything else as before. A new epoch — a reconnect, which may meet
a different Nessie — waits for its own `ready`.

Session hosts learn the same through a lease the daemon writes into the
bridge's state directory, `coding-sessions/owner-requests.json`
(`src/coding-session/owner-requests-lease.ts`): granted for a minute when the
doorbell says ready and renewed by every successful heartbeat, ended at once by
a failed heartbeat, a reconnect, a daemon start and shutdown. It is granted
only while the reviewed facts also say the owner answers prompts
(`ownerAnswers`, below). Without it a host turns every provider prompt down at
once, exactly as before a prompt could reach the owner: Claude Code is denied
with "No person is at this terminal to approve this, so it was denied." and
its turn goes on; Codex is declined (no feedback, the turn goes on); a
`request_secret` call is refused with `owner_unreachable`. Requests already
pending stay pending across a brief loss of the lease, so a network blip does
not end them.

## Owner answers are a reviewed fact

`ownerAnswers: true` in the coding-sessions facts, inside the signed
descriptor's `localPolicyDigest`, says the owner answers Claude Code's and
Codex's own prompts from Nessie. It is set when a person applies the
coding-sessions configuration (`configure` with a `codingSessions` object) and
Claude Code or Codex is offered; the daemon's own upgrade at start
(`enableLocalSessionBridge`) carries it over as reviewed and never adds it. So
the descriptor's digest changes, and the owner reviews it, once: a machine
whose reviewed facts predate it keeps turning every prompt down. The fact
matters because of Codex: under its `on-request` policy (kept, below) the
owner's approval of one command lets that command run outside the reviewed
sandbox.

A consequence for agent-driven turns: when an agent drives a session for work
— the CTO working a ticket, say — a prompt its coding agent raises now waits
for the human owner's answer instead of being denied automatically, and Nessie
alerts the owner that a session needs them.

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
Conversations carry the list as `requests` (to a Nessie that reads them):
every pending request, oldest first, then the most recent settled ones, newest
last, sixteen in all. Older
settled requests age out as new ones settle. A request ends unanswered with:

| Status | Reason | When |
| --- | --- | --- |
| `cancelled` | `turn_interrupted` | the owner interrupted the turn |
| `cancelled` | `session_closed` | the session closed |
| `cancelled` | `provider_cancelled` | Claude or Codex withdrew the prompt itself |
| `expired` | `turn_ended` | a Codex turn ended with the prompt still open |
| `expired` | `provider_exited` | the provider process exited, or its host stopped serving |
| `expired` | `executor_restarted` | no host is alive to answer it (read time), or a new host found it on disk |
| `expired` | `answer_unreadable` | its answer reached the host sealed for another host's key |

Time a turn spends waiting on its owner does not count against
`maxTurnMinutes`.

### What an approval may reach

An approval is the owner's decision about what they were shown, so it reaches
no further (`src/coding-session/request-drafts.ts`, `approval-scope.ts`):

- A request whose command, cwd, diff, input or file list had to be cut to fit
  the protocol's bounds (a command over 16,000 characters, a diff over 32,000,
  more than 64 files), or a file change whose new content the provider did not
  give, offers only `decline` and `cancel`, and its title begins "Shown in
  part, so it can only be declined:".
- Accepting for the session never adds a bare tool, never a rule for a
  path-scoped tool, never a mode, and never a folder outside the reviewed
  roots (Claude Code and Codex below).
- Host paths outside the named folders still read `<host path>` in a command,
  as everywhere else; the owner sees that a path is hidden, not which.

### Answers

An `answer` action reaches the bridge as `session_answer`
(`src/coding-session/session-answer.ts`). It is checked against the request the
host last wrote, then claimed in `sessions/<id>/answers/<requestId>.json`, so a
request is answered once whichever answer arrives first.

The claim is first an intent (`delivering`, naming the bridge process) and
becomes `delivered` only once the answer is in the host's inbox — a secret in
its file before that — so `accepted` means the answer reached its host. A
claim whose bridge stopped mid-delivery (another process, now gone, or older
than a minute) is settled by the next answer or replay that finds it: completed
when its answer is in the inbox or the host already acted on it, released
otherwise, so the replay or the owner's next answer delivers again and the
provider never waits on an answer nobody delivered. A claim from an older
bridge, without a stage, reads as delivered. Receipts:

| State | Code | Meaning |
| --- | --- | --- |
| `accepted` | `answer_delivered` | in the host's inbox, on its way to the provider; the host checks it once more as it delivers it |
| `accepted` | `secret_saved` | the value is in its file and the host was told; the agent is told where |
| `outcome_unknown` | `answer_in_progress` | the same action is being delivered by a live bridge right now |
| `failed` | `request_not_pending` | answered, settled or aged out; also an unknown id or a second answer |
| `failed` | `request_not_answerable` | a session found open on the computer, a request marked unanswerable, or a secret question whose host is too old to receive its value sealed |
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
`permission`; every edit of a `MultiEdit` and a notebook cell's new source are
shown. `accept_for_session` is offered only with something concrete to add,
with `destination: 'session'` and never to a settings file: Claude's own
suggested `addRules` whose rules carry rule content (a bare tool, `*` or `:*`
is dropped, and so is any rule for `Read`, `Write`, `Edit`, `MultiEdit`,
`NotebookEdit`, `Glob`, `Grep` or `LS`, whose path reach one request cannot
show), its `addDirectories` that resolve inside a reviewed root, and otherwise,
for Bash, the exact command the owner read (not when it contains `*`, which
would make it a pattern). Modes, removals and replacements are never added.
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
request was refused. That is why `on-request` stays — an owner can let one
command they read past the sandbox — and why it is a reviewed fact
(`ownerAnswers`): until the facts say it, every such request is declined at
once. The owner reads the exact command Codex will run, a `sh -lc '…'` wrapper
unwrapped and never Codex's own display parse of it (`commandActions` can drop
a `cd`), and every changed file's diff. Nothing widens the sandbox for the
session: `item/permissions/requestApproval` offers `accept`, `decline` and
`cancel` and is granted for its turn only, and only when every file-system
path, glob or special location it names is inside a reviewed root (network
access may be asked for and is shown); otherwise it offers only `decline` and
`cancel` and says why. A file change that carries `grantRoot` (which would let
the agent write under that root for the session) is approved once only.
Codex's requests become requests
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
— never the value. With `envName` one `NAME=value` line is set or replaced and
every other line kept; without it the file is the value. Claude's prompt for
this tool is allowed without asking, and a Codex elicitation from this server
is accepted, because the secret request is the owner's gate. Codex gives the
call 24 hours.

**Where it may go.** The destination is one file name directly in the session
folder — no subfolder, `..`, drive, `:` stream or trailing dot. The executor
writes it unsandboxed while the agent can write in the same folder, so it
trusts nothing between a check and a use: an existing file is opened with
`O_NOFOLLOW` (Windows has none, so there the handle and the name are compared)
and proved on the handle to be one ordinary file with one link, still the file
the name points to. On POSIX the new exclusive file has mode 0600. On Windows
an empty temporary directory receives an owner-only DACL before the file is
created inside it, so the file inherits private permissions at birth. The fixed
sibling ACL helper normalizes its owner and proves the file private before any
value is written; it verifies the final renamed file too. A missing helper refuses.
The empty staging directory is removed only while its identity still matches;
uncertain or nonempty staging is retained. The
folder must be the same directory (device and inode) after the read, before
the rename and after it, with the renamed file the one this write created. Any
difference refuses the write; nothing outside the folder is read or written.

**Kept out of the conversation.** An agent can still print what it was given
(`cat .env.local`), and tool output reaches conversation snapshots that the
people a session is shared with read. So the value reaches the session host
too — sealed (below) — and joins the session projector's redactions, with its
dotenv spelling, before the agent hears it was saved: every later event and
conversation shows `<secret>`. The same holds for a value typed into a
question marked `secret`. Across a host restart nothing second holds a value:
the session records only which files hold one
(`sessions/<id>/secret-destinations/<requestId>.json`, path and variable name),
and a starting host reads each value back from its owner-only file, the same
safe way, to rebuild the redactions (`src/coding-session/secret-redactions.ts`).
A secret question's value is held nowhere, so its redaction lasts as long as
the host that received it. Values shorter than six characters are not
redacted, since they would garble ordinary text.

**Sealed hand-over.** Each host makes an X25519 key pair when it starts, keeps
the private key in memory, and publishes the public key in `requests.json`
(`answerKey`). The bridge seals a secret's value and a secret question's values
to it for the one request they answer (HKDF-SHA-256, AES-256-GCM, the request
id as additional data; `src/coding-session/answer-seal.ts`). The inbox, the
claim and anything a crash leaves behind hold only the sealed box, which no
later process can open; a host that cannot open one ends the request
`answer_unreadable` rather than leave it waiting.

The value travels from Nessie in the answer action, through the daemon's MCP
call to the bridge, into the file and sealed to the host — and nowhere else
readable: not the inbox, a log, a receipt, a request, a conversation, the
inventory or an error.

## Checks

`test/daemon-doorbell.test.ts` (a real socket upgrade, an older server's
refusal, backoff, the beat watchdog, cadence and the change watcher),
`test/owner-requests-gate.test.ts` (the epoch gate, the stripped report and the
lease), `test/session-view-relay.test.ts` (an exchange an older Nessie's strict
schema accepts while something waits), `test/existing-coding-sessions.test.ts`,
`test/session-request-book.test.ts`, `test/session-request-scope.test.ts`
(session rules, permissions within the roots, exact commands and what was not
shown whole), `test/secret-destination.test.ts` (the writer against a folder
and files swapped mid-write, and the Windows helper arm),
`test/session-answer.test.ts` (intents, stranded claims and sealing) and
`test/session-requests-live.test.ts` (the real bridge and host with the
scripted agent speaking both providers' prompts: answers, stale and double
answers, interrupt and provider exit while pending, prompts turned down while
Nessie has not shown it reads them, secrets, their leaks and their redaction
across a host restart) run in the ordinary suite and `test:live-sessions`;
`test/coding-session-daemon.test.ts` and `test/coding-session-policy.test.ts`
cover the lease's facts condition and the `ownerAnswers` fact.

The Windows DACL arm is exercised with a stand-in helper here; the real native
helper's verdict on a secret file has not been run on Windows.
