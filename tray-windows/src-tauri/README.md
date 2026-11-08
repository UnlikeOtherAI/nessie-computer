# Nessie Computer for Windows

`nessie-executor-tray.exe` is Nessie Computer beside the Windows clock. It
shows the shared console in `packages/executor-console` in its window, runs
the teams connected under the person's own account, and reaches the
`NessieExecutor` service's teams through the authenticated control pipe. The
CLI owns every key and local rule. The product name is Nessie Computer; the
executable, service, pipe, install folder and state folder keep their
original identifiers so upgrades and installed scripts keep working.

## What a person sees

- **One copy per person.** A second launch, or a `nessie-computer://` link,
  shows the window of the copy already running.
- **Left-click** opens the window. **Right-click** opens the menu:

  ```text
  {Status sentence}                 Working for 2 teams · 1 paused / Paused / Not connected — open Nessie Computer
  {Needs you: {team} — {reason}}    or "Needs you: 3 things — open Nessie Computer"
  ──────────
  Pause | Resume                    several teams: All teams, then one line per team (✓ paused)
  ──────────
  Open Nessie Computer…            the window, on the tab last used
  Add another team…                 the window, straight onto a new pairing code
  Open Nessie                       the paired server's Computers page
  ──────────
  Quit Nessie Computer
  ```

  Teams read `{teamName} · {organizationName}`, with ` ({serverHost})` when
  two teams on different servers would read the same. Names come from each
  connection's pairing status and are kept in memory only; an unknown name
  reads "Team name not available yet". Pause and Resume ask nothing. The
  sentences, the Needs you rules and their translations are the macOS menu
  bar's, so both platforms say the same thing.
- **Icon:** grey when nothing is working (nothing connected, or all paused),
  green when a team is working, amber only when the owner has something to
  do, red when the service cannot be reached.
- **Program requests** arrive as a toast with **Allow once**, **Always allow
  {program}** and **Don't allow**. Clicking the toast opens the window on its
  team; the request waits in the Needs you strip. Saves never post toasts.
- The menu, toasts and dialog titles are in en-GB, en-US, cs, de, es, fr and
  it, chosen from the Windows display language (`src/words*.rs`).
- The installer adds a **Nessie Computer** Start menu shortcut. Its
  `System.AppUserModel.ID` is the app identifier, which is the identity toasts
  are shown under.

## Restarts

Both supervisors restart a team that stopped on its own, from 5 seconds
doubling to 5 minutes ("Restart a team if it stops" governs this app's own).
A recognised refusal — a fenced connection, a rejected key, a stale revision,
an unconfirmed pairing — is never retried: the team stays stopped with its
`failure` until the owner applies a remedy, as on macOS. A timeout or a
refusal this build does not recognise is retried
(`windows-common/src/failure.rs` → `retriable`).

## Pause

A team is paused by whoever runs it, through the CLI's `pause` / `resume`, so
the pause is a record (`owner-pause.json`) in the team's state directory: it
survives the app quitting, the service restarting, signing out and updates,
and the daemon enforces it. Neither supervisor stops or starts a team to pause
it. Status rows read the record directly; it holds no secret.

Pause and Resume act on teams, not connections. A team this app runs and the
service's ChatGPT plan connection to the same team pause together.

## Bridge commands (`packages/executor-console` ↔ this app)

| Command | Args | Answer |
|---|---|---|
| `executor_view` | — | `{ kind: 'reachable', executors: [Row] }` or `{ kind: 'unreachable', reason }` |
| `executor_set_paused` | `{ executorId: string \| null, paused }` | the new view; a team id pauses every connection of that team |
| `executor_apply_remedy` | `{ executorId, remedy: 'reProposePolicy' \| 'restartExecutor' \| 'openNessie' }` | the new view |
| `executor_audience` | `{ executorId }` | the CLI's `audience --json` answer |
| `executor_program_requests` | `{ executorId? }` | `[{ executorId, id, program, args, agentName?, requestedAt, expiresAt }]` |
| `executor_answer_program_request` | `{ executorId, id, answer: 'once' \| 'always' \| 'deny' }` | every team's remaining requests |
| `executor_sessions` | `{ executorId? }` | every team's (or one team's) `sessions --json` with `executorId` on each session ([sessions](../../docs/sessions-and-concurrency.md#local-shapes-the-apps-read)) |
| `executor_stop_session` | `{ executorId, sessionId }` | `session stop` for that team, then every team's sessions |
| `executor_configure` | as before | describe; applied live, never restarts the team |
| `executor_open_logs` | — | opens the service's logs folder |
| `executor_open_nessie` | `{ executorId? }` | that team's Computers page; with no team, while a pairing code is showing, `/admin/computers?create=1&code=<code>` on that attempt's server, else the first team's server. The page never passes an address or a code |
| `executor_pairing_start` | `{ apiBaseUrl? }` | the pairing view; defaults to `https://api.nessie.works` |
| `executor_pairing_status` / `executor_pairing_cancel` | `{ executorId? }` / — | as before |
| `executor_launch_link` | — | the link this copy was started with, once: `{ section, executorId? }`, `{ connect: true }` or `null` |
| `executor_chatgpt_connection_start` / `_status` / `_cancel` | `{ executorId }` | see below |

`Row` is `{ executorId, daemonStatus, paused, failure?: { code?, message },
pendingProgramRequests, workspaceConfigured, connection: 'user' | 'service',
chatgptConnectionId? }`. `failure` is present while the connection is not
running and is the last line the daemon or `connect` wrote; `code` names the
API's error code when the line is one of its fixed refusals
(`windows-common/src/failure.rs`). Removed: `executor_start`, `executor_stop`,
`executor_set_running`, `executor_reconnect`, `executor_hide_status`,
`executor_notify`, and the pairing commands' `replace` and
`personalPlanConnection` arguments. Every team command names its team with
`executorId`; `executor_set_paused` takes `null` for every team, and
`executor_program_requests` and `executor_sessions` may omit it for every team.
A service-owned team's requests and sessions are read and stopped only by the
Windows account that connected it (the service's `programRequests`,
`sessions` and `stopSession` pipe commands); other accounts' lists leave that
team out. Sessions are read through the CLI only when the daemon rewrote its
`sessions.json`, or every 30 seconds while it names work.

Section events are `tray://section/<access|documents|ai|settings>` and
`tray://open` (the window as it was) with an optional `{ executorId }`, and
`tray://connect`.

## ChatGPT plans on Windows

Only the service can hold a ChatGPT plan's sign-in in custody; the runtime
refuses a user-session connection (`requireChatgptServiceAuthority`). Connect a
team therefore offers no ChatGPT option, and the AI tab adds what a plan needs:

1. **The team's connection holds plans already** when its row has
   `connection: 'service'`, or a user row has `chatgptConnectionId`. Use that
   id for `executor_personal_chatgpt` (start, status, rename, disconnect,
   background consent) exactly as today.
2. **Otherwise** "Add a ChatGPT plan" first calls
   `executor_chatgpt_connection_start({ executorId })` with the user row's id.
   The app asks Windows (one UAC prompt) to let the service read the owner's
   `Nessie` folder, and asks the service for a pairing code on that team's own
   server. The answer is the pairing view (`code`, `expiresAt`, `status`).
   Show the code with "In Nessie, open Computers and choose **Add a
   computer**", and **Open Nessie to finish** via `executor_open_nessie({})`:
   while the code shows, the app opens that attempt's server on **Add a
   computer** with the code. Poll `executor_chatgpt_connection_status({ executorId })`;
   `executor_chatgpt_connection_cancel({ executorId })` abandons it.
3. When the status reads `paired`, the service starts that connection, the
   view's user row gains `chatgptConnectionId`, and step 1 applies. The owner
   then names the plan and signs in with ChatGPT.

The plan connection is a second computer for the same team in Nessie. The
console should label it as the team's ChatGPT plan connection rather than show
two identical team names; the menu already shows the team once.

## Deep links

`nessie-computer://open?section=<…>[&team=<executorId>]` and
`nessie-computer://connect` only navigate. Anything else, including extra
parameters, is ignored. The installer registers the scheme under
`HKCU\Software\Classes\nessie-computer`; a release build registers it on its
first run when no working registration exists.

## Verification

Run on Windows (Maxis), from a checkout of your branch:

```powershell
cargo test --manifest-path windows-common\Cargo.toml
cargo test --manifest-path service-windows\Cargo.toml
cargo test --manifest-path tray-windows\src-tauri\Cargo.toml
node --test packaging\windows\msi-plan.test.mjs
```

The tray's tests cover the menu model, labels, words in every language, pause
grouping, toast text, link parsing and the pipe answers. `installer-smoke.ps1`
(CI's Windows Native job) installs the MSI on a clean runner and checks the
service display name, the Start menu shortcut and the link registration, and
that uninstall removes them. Never launch a candidate tray on a computer with
an installed Nessie Computer: it starts that person's paired teams.

## Claude Code and Codex (`local_ai.rs`)

`executor_local_ai`, `executor_set_local_ai`, `executor_local_ai_add_account`,
`executor_local_ai_sign_in` and `executor_local_ai_remove_account` run the
CLI's `local-inference engines --operation-stdin --state-dir <dir>` for a team
connected under this Windows account. A team the background service runs
answers `{ "unavailable": "service" }`: the service account has no Claude Code
or Codex sign-in of the owner's. See
[Claude Code and Codex as engines](../../docs/local-cli-engines.md).
