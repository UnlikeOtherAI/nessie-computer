# Nessie Computer — redesign contract (phases 1–4)

Status: in delivery, 8 November 2026. Integration branch `feat/nessie-computer`
(this repository) and `feat/nessie-computer` (Nessie). This file is the built
contract every tranche works against: **this doc wins over a brief; the code
wins over this doc — report every deviation** to the orchestrator in your final
report, with the reason. Studies behind it: Opus, Codex Astra and Fable
adversarial UX reviews of revision 30ba47d.

## 1. Product rulings (settled — do not re-litigate)

1. **Name.** The product is **Nessie Computer** ("Computers" in Nessie's
   navigation). "Executor" is the historical name and leaves every user-visible
   surface: app names, windows, menus, notifications, installers, Start menu,
   web copy, CLI help. Identifiers stay: bundle identifiers, MSI UpgradeCode,
   service names, state paths, pipe names, protocol field names, package names.
2. **The team dropdown stays.** Several teams can use one computer. Every team
   setting follows the team chosen in the dropdown. Computer-wide settings
   (open at login, restart, updates, pause all, logs) sit outside it, and the
   dropdown is hidden on computer-wide screens.
3. **Local MCP servers ("local apps"):** every one installed on the computer is
   usable by default. The owner can switch any off.
4. **Programs:** a new team may start, by default, programs published by
   UnlikeOtherAI (verified by code signature — see §6.2), plus Claude Code,
   Codex and T3 Code. Anything else needs the owner's approval. Existing
   teams keep their saved rules.
5. **ChatGPT plans:** not "personal". A plan can be personal or company; the
   owner adds as many as they want, each named and signed in with ChatGPT's own
   OAuth sign-in. Plans still fund the owner's own agents (funding unchanged).
6. **Documents (sync):** syncing means syncing all of them. The owner chooses
   the folder; there is no per-document offline/online choice and no sensitive
   or restricted exclusion. Agent-private homes are not the person's documents
   and stay out.
7. **The CLI and the apps are one product.** The apps are a UI for the CLI: same
   words, same structure, a CLI verb for every app action, help always current.

## 2. Vocabulary (user-visible; CLI help uses the same words)

| Concept | Say | Never say |
|---|---|---|
| The app / CLI | Nessie Computer / `nessie-computer` | Nessie Executor, executor, tray, daemon |
| A paired team on this computer | team | connection, executor, pairing (except "pairing code") |
| Pair (on the computer, app and CLI) | **Add this computer** (menu: "Add this computer…"; CLI `nessie-computer add`, `connect` kept as an alias) | Add this computer, Add team, Pair this Mac |
| Pair a computer (in Nessie web) | **Add a computer** | Pair a computer |
| The code | pairing code (8 digits) | invitation, enrollment |
| Unpair | **Disconnect** {team} | Remove team, sign off |
| Stop agents temporarily | **Pause** / **Resume** (stays until you resume) | Stop executor, All team connections |
| What a team may use | **Access**: Folders, Programs, Websites, Local apps, Coding assistants | Reach, Where it can reach, Tools it can run, Commands |
| Programs default list | Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code | allowlist (UI), command pattern (UI, except Advanced) |
| MCP servers | **Local apps** | MCP server (UI; CLI help may add "(MCP servers)") |
| Existing Codex/Claude conversations | Coding assistants → "Let agents read and message your Claude Code and Codex conversations" | existing sessions |
| Folder sync | **Documents** → "Keep a copy of {team}'s documents on this computer" | Sync documents, offline |
| AI accounts | **AI** → ChatGPT plans, Model servers | personal plan, custody, Strata |
| Owner answer to a program request | **Allow once / Always allow {program} / Don't allow** | approve policy |
| Who may send work | "Who can send work here" (agents, people, projects) | audience |

Team label everywhere (dropdown, Mac menu, Windows menu, CLI tables,
notifications): **`{teamName} · {organizationName}`**. Two equal labels get
` ({serverHost})`. Unknown name: "Team name not available yet". Never a UUID,
never an API URL. Status words: **Working** (connected, not paused),
**Paused**, **Not connected** (stopped/failed, with the reason), **Needs you**.

Copy rules: Unslop; sentences ≤ 20 words; no codes in body text (codes live in
a "Details" disclosure and CLI `--json`); errors say what happened, what it
means, and offer one button that fixes it.

## 3. Information architecture

### 3.1 Menu bar (macOS) / notification area (Windows) — identical items

```
{Status sentence}                          disabled, e.g. "Working for 2 teams" / "Paused" /
                                           "Not connected — open Nessie Computer" / "Needs you: …"
{Needs you: <one line>}                    only when something needs the owner; opens its exact place
──────────
Pause  |  Resume                           all teams, durable; with >1 team a submenu:
                                           "All teams", then one line per team label (✓ = paused)
──────────
Open Nessie Computer…                      the window, on Overview
Add this computer…                         the window, straight onto a new code
Open Nessie                                the paired server's Computers page
──────────
Quit Nessie Computer                       when work is running, macOS adds: " — agents stop until you open it again"
```

No Start/Stop, no Settings…/Where it can reach…/Tools it can run…, no logs,
no hidden "selected team". Windows: left-click opens the window, right-click
the menu; no confirmation dialogs for Pause/Resume. Icon states: **idle** (grey:
nothing connected, or everything paused), **working**, **needs you** (amber,
only for things that need the owner: a program request, sync attention, a
failure with a remedy, owner confirmation), **error** (Windows: the background
service cannot be reached). Starting/stopping/connecting are never amber.

### 3.2 Window ("Nessie Computer")

```
┌ Nessie Computer ─────────────────────────────────────────── [Pause all] ┐
│ Overview | Access | Documents | AI | Settings                          │
│ ─ Team: [Sales · Acme ▾]  ← only on Access, Documents, AI ──────────── │
│ <tab content>                                                          │
└────────────────────────────────────────────────────────────────────────┘
```

- **Overview** (computer-wide): status sentence; "Needs you" list (program
  requests with Allow once / Always allow / Don't allow; sync attention;
  failures with their remedy button); one card per team — label, status, a
  one-line access summary ("2 folders · UnlikeOtherAI apps, Claude Code, Codex,
  T3 Code · all local apps · no websites"), "Who can send work here" (agents,
  people, projects; from `audience`), buttons **Change access**, **Pause/Resume**,
  **Disconnect…**; **Add this computer**. First run (no team): a welcome — "Nessie
  Computer lets agents in your Nessie team use this computer. Nothing is shared
  until you connect a team." — with one button, **Add this computer**.
- **Access** (per team, dropdown): sections Folders · Programs · Websites ·
  Local apps · Coding assistants (the last collapsed under "For developers",
  holding existing-session access and the Claude Code channel recipe). Programs
  shows a list (built-ins with switches, owner-added entries with Remove, "Add
  program…"), a mode choice "Only these programs / Any program", and "Advanced:
  patterns" holding today's pattern syntax. "Currently allowed" is always the
  effective policy; an unsaved or invalid edit never looks effective. Program
  rules change via an explicit **Apply** with a before/after line; other
  switches save when pressed. The sentence "Programs run as you and can open
  any file you can" sits beside the Programs mode, not at the bottom.
- **Documents** (per team): switch "Keep a copy of {team}'s documents on this
  computer", folder row (suggested folder, **Change…**), status line, Open
  folder, Pause sync, Deleted files, files to check. One "Allow in Nessie" step
  remains when Nessie requires it, as a single deep-linked button.
- **AI** (per team): ChatGPT plans (any number; "Add a ChatGPT plan" → name
  prefilled "ChatGPT plan N", editable → "Sign in with ChatGPT"), Model servers.
  The custody restriction is explained in one plain sentence beside its
  checkbox: "While a ChatGPT plan is signed in, agents can't open terminals or
  coding tools under your account. Sign out to get them back."
- **Settings** (computer-wide): Open Nessie Computer when I log in; Restart a
  team if it stops (default on); Software updates; Notifications; Help (open
  logs folder, version, CLI pointer). The server address lives in Connect a
  team → "Use your organisation's own Nessie server".
- No in-page Close button (the window's own close hides it). Dark mode follows
  the OS. Content text is selectable; controls are not. Errors show beside the
  control that failed; the footer keeps one short status line.

### 3.3 Add this computer (pairing)

Ruling (Ondrej, 8 Nov): no address to type. Press **Add this computer** in the
app or run `nessie-computer add`, get a code, enter it within **5 minutes** in
Nessie's **Add a computer** box. The server address is optional and only for
an organisation that runs its own Nessie.


1. **Add this computer** opens the dialog and immediately requests a code for
   `https://api.nessie.works` (the advanced server link re-requests for another
   address). No URL field by default. No fingerprint. No ChatGPT checkbox.
2. Shows the 8-digit code (Copy), the countdown, and "In Nessie, open Computers
   and choose **Add a computer**." plus **Open Nessie to finish**, which opens
   `<console>/admin/computers?create=1&code=<code>` for the paired server (§5.4).
   An expired code stays visible, greyed, with **Get a new code**.
3. On success the dialog closes and Overview shows a success card: "Connected to
   {team}. Agents in this team can now use: {folders}; {programs}; {local apps}."
   with **Change access** and **Done**. If the owner didn't expect it:
   **Disconnect**.
4. Notifications are requested only when first needed (a program request).
   Saves never post OS notifications.

## 4. Runtime contract (CLI JSON the apps consume)

All existing plumbing verbs keep working (`describe`, `configure
--configuration-input-stdin`, `pair*`, `connect`, `serve`, `sync`, …); the
apps keep calling them until tranche F re-points them (§9).

### 4.1 Live apply — saving never restarts a team
`configure` while the team's daemon runs: the CLI writes state (revision + 1)
through the existing compare-and-set writer and notifies the running daemon
(doorbell or state-revision watch). The daemon reloads local state, re-signs
and submits the descriptor under its **current** `connectionEpoch`
(`POST /api/executor-daemon/descriptor` already accepts that) and keeps its
connection. In-flight commands carrying the old revision get
`EXECUTOR_DESCRIPTOR_STALE` as today. Supervisors (macOS bridge, Windows
tray/service) stop stopping/starting around `configure`.

### 4.2 Pause
- `pause --state-dir <dir>` / `resume --state-dir <dir>` persist
  `owner-pause.json` `{ "paused": true, "since": "<iso>" }` (owner-only) and
  notify the running daemon. `describe` gains `paused: boolean`.
- While paused the daemon stays connected, refuses every new command with
  `EXECUTOR_OWNER_PAUSED`, lets running work finish, and heartbeats with
  `ownerPaused: true` (protocol: `ExecutorDaemonHeartbeatRequestSchema`).
  Supervisors never treat paused as stopped, and autostart, auto-restart and
  update restarts preserve it. Pause all = pause every team.
- Older servers reject the unknown heartbeat field: the daemon then keeps the
  local pause and retries without the field (report it; never unpause).
- Nessie routes nothing to an owner-paused computer (availability reason
  `owner_paused`) and shows **Paused on the computer**, distinct from Nessie's
  own **Turned off** pause.

### 4.3 Program rules
`LocalCommandPolicy` gains built-in trusted entries:

```ts
type LocalCommandPolicy = {
  mode: 'all' | 'allowlist'
  allowlist: string[]          // owner patterns, unchanged grammar
  denylist: string[]
  trusted?: {                  // absent = none (existing teams); new pairings write all four true
    unlikeotherai: boolean     // programs signed by UnlikeOtherAI (§6.2)
    claudeCode: boolean        // `claude`
    codex: boolean             // `codex`
    t3Code: boolean            // T3 Code's CLI/app
  }
}
```

New pairings write `{ mode: 'allowlist', allowlist: [], denylist: [], trusted: all true }`.
An allowlist with no patterns and no trusted entry is a valid, enforced
**No programs** state (the console must offer it; the runtime must accept it).
Denylist still wins over everything. `describe` reports `commandPolicy`
including `trusted`, plus `programDefaults` naming the built-ins for the UI.

### 4.4 Program requests (approvals)
When a command or terminal launch is refused only because it is not allowed
(not denied), the daemon creates a pending request in the state directory
(`program-requests/`), holds the command up to its expiry (cap 120 s) and
waits for the owner. `program-requests --state-dir <dir> --json` lists
`[{ id, program, args, agentName?, requestedAt, expiresAt }]`;
`program-request answer --state-dir <dir> --id <id> --answer once|always|deny`.
`always` adds the pattern `<program> *` to the allowlist through the same
writer (live apply). No answer by expiry = refused with reason
`owner_did_not_answer`; `deny` = `owner_declined`. `describe` gains
`pendingProgramRequests: number`.

### 4.5 Local apps (MCP)
`mcpPolicy?: { mode: 'installed' | 'listed', disabled: string[] }` beside
today's `mcpServers`. New pairings write `{ mode: 'installed', disabled: [] }`:
the daemon names every installed local MCP server it discovers — known
UnlikeOtherAI servers (Kelpie, …) and stdio servers declared in the owner's
Claude Code, Codex and T3 Code configurations — minus `disabled`, and a change
in the discovered set is a live-applied revision. Launch specs stay local
exactly as today. `describe` gains `localApps: [{ name, source, enabled, installed }]`.

### 4.6 Websites
Configuration input gains `allowedOrigins?: string[]` (HTTPS origins), stored
where `configure-browser` stores them today and independent of whether the
guest browser is set up; `describe.reach.allowedOrigins` is the effective list
and `sandbox.browserConfigured` says whether it can be used yet.

### 4.7 Who can send work here
`audience --state-dir <dir> --json` makes the signed
`POST /api/executor-daemon/audience` (`ExecutorDaemonAudienceRequestSchema` →
`ExecutorDaemonAudienceResponseSchema`, `packages/protocol/src/executor-audience.ts`)
and prints the response. Nothing is persisted.

## 5. App ↔ console bridge (shared `packages/executor-console`)

Both natives implement the same commands; Linux keeps its software-section subset.

### 5.1 Changed / new commands
| Command | Args | Answer |
|---|---|---|
| `executor_view` | — | `{ kind:'reachable', executors:[{ executorId, daemonStatus, paused, failure?:{ code?, message }, pendingProgramRequests }] }` |
| `executor_set_paused` (replaces `executor_set_running`) | `{ executorId: string \| null, paused }` (`null` = all) | the new view |
| `executor_apply_remedy` | `{ executorId, remedy }` | the new view |
| `executor_audience` | `{ executorId }` | §4.7 JSON |
| `executor_program_requests` | `{ executorId? }` | `[{ executorId, id, program, args, agentName?, requestedAt, expiresAt }]` |
| `executor_answer_program_request` | `{ executorId, id, answer }` | the new list |
| `executor_configure` | as today (+ `allowedOrigins`, `commandPolicy.trusted`, `mcpPolicy`) | describe; **never restarts** |
| `executor_open_logs` | — | opens the logs folder |
| `executor_pairing_start` | `{ apiBaseUrl? }` | as today; no ChatGPT option |

Settled during delivery (both hosts implement exactly this):
- **Remedy ids** for `executor_apply_remedy`: `reProposePolicy`, `restartExecutor`,
  `openNessie`. The console may also handle "open Nessie" by calling
  `executor_open_nessie` itself.
- **`executor_open_nessie { executorId?, computer? }`** (`computer: true` opens that
  team's computer page in Nessie): the host builds the URL from its
  own paired server and adds `?create=1&code=<code>` itself while a pairing
  code is showing. The page never passes a path or URL.
- Removed: `executor_reconnect`, `executor_notify`, `executor_hide_status`.
  Every team command requires `executorId`.

`executor_hide_status` and the in-page Close go away. The console translates
failures itself (one translator, keyed by `code`, all locales); the Swift
`ExecutorFailure` table moves into the console and remedies call
`executor_apply_remedy`.

### 5.2 Section events
`tray://section/<overview|access|documents|ai|settings>` with optional
`{ executorId }`; `tray://connect` opens Add this computer.

### 5.3 Shared console API (tranche E1 provides, E2 uses)
`window.nc = { byId, invoke, listen, attempt, t, words, team, view, dialogs }`:
- `nc.t(key, vars)` / `nc.words.register(namespace, { 'en-GB': {…}, 'en-US': {…}, cs: {…}, de: {…}, es: {…}, fr: {…}, it: {…} })`; one locale resolution; `<html lang>` set from it.
- `nc.team.current()`, `nc.team.label(executorId)`, `nc.team.onChange(fn)`, `nc.team.describe()` (current team's describe, loaded once per selection).
- `nc.view.onChange(fn)`, `nc.view.current()`.
- `nc.attempt(fn, { target })` reports a failure beside `target` (or the tab's error slot).
- `nc.dialogs.open(id)` for dialogs E2 injects.
- E2 renders into `#tab-access`, `#tab-documents`, `#tab-ai` and injects its own dialogs; script files E1 includes: `access.js`, `access-words.js`, `documents.js`, `documents-words.js` (renamed from sync*), `ai.js`, `ai-words.js`, `chatgpt.js`, `chatgpt-words.js`, `inference-endpoints.js`, `team-drafts.js`, `autosave.js`.

### 5.4 Deep links
Scheme **`nessie-computer://`**: `nessie-computer://open?section=<…>[&team=<executorId>]`,
`nessie-computer://connect`. Links only navigate; they never change anything.
macOS registers `CFBundleURLTypes`; Windows registers
`HKCU\Software\Classes\nessie-computer` (installer and first run). Nessie's web
uses them where a person is sent to the computer ("Open Nessie Computer").
"Open Nessie" from the apps opens the **paired** server's console (never a
hard-coded host), at `/admin/computers` or, while pairing,
`/admin/computers?create=1&code=<code>` (a one-shot intent stripped on capture).

## 6. Security that must survive

- Local rules stay machine-owned; a server grant never widens them (`SECURITY.md`).
- 6.1 Pause is enforced by the daemon, not only by the UI.
- 6.2 "Apps from UnlikeOtherAI" is decided by verified code signature: macOS —
  a valid Developer ID signature with UnlikeOtherAI's Team ID, or an app bundle
  whose identifier starts `com.unlikeotherai.` *and* carries that signature;
  Windows — a valid Authenticode signature whose subject is `CN=UnlikeOtherAI
  s.r.o., O=UnlikeOtherAI s.r.o., …`. A file name alone never qualifies.
  Unsigned scripts are not covered (the owner adds them).
- Claude Code, Codex and T3 Code resolve by name through the owner's PATH to an
  absolute executable at launch, as other rules do.
- Pairing: Nessie shows the computer's name and OS and asks **Connect** before
  claiming; codes stay one-use, 5-minute, never persisted in history.
- Program requests can be answered only on the computer, by its owner.
- Keep custody fences, signed descriptors, revision monotonicity, LAN checks,
  update authenticity, sync conflict preservation and held-deletion approval.

## 7. Translations and visuals
Every visible string in the console and both natives in **en-GB, en-US, cs, de,
es, fr, it**; Nessie admin strings in all its locales (`pnpm lint:translations`).
Native menus use the same words as §2. Light and dark themes.

## 8. Tranches, ownership and waves

Exclusive write paths; touch nothing else (ask the orchestrator).

**Wave 1 (parallel)**
| Id | Owner | Writes |
|---|---|---|
| A1 runtime policy | Opus | `src/command-policy.ts`, `src/program-trust*.ts` (new), `src/pairing-code.ts`, `src/configuration-input.ts`, `src/describe.ts`, `src/state-store.ts` (policy fields), `src/mcp-*.ts`, `src/local-mcp-*.ts`, `src/local-app-discovery*.ts` (new), `src/existing-session/*`, `src/api-client.ts` (audience), `src/audience*.ts` (new), `packages/protocol/**`, their tests, `docs/local-programs.md` (new), `SECURITY.md` |
| A2 runtime lifecycle | Opus | `src/daemon*.ts`, `src/owner-pause*.ts` (new), `src/program-request*.ts` (new), `src/cli.ts` + `src/cli-arguments.ts` (only the new plumbing verbs `pause`, `resume`, `program-requests`, `program-request`, `audience` and live-apply `configure`), their tests |
| B macOS | Opus | `menubar-macos/**`, `packaging/macos/**` (names only) |
| C Windows | Opus | `tray-windows/src-tauri/**`, `service-windows/**`, `windows-common/**`, `packaging/windows/**` |
| D Nessie | Opus | the Nessie repository (not `executor/`) |
| E1 console shell | Fable | `packages/executor-console/{index.html,style.css,main.js,native.js,i18n.js,overview*.js,teams*.js,pairing*.js,settings*.js,updates*.js,errors*.js}`, `tray-windows/test/**`, `packaging/linux/console/**` |
| E2 console team tabs | Fable | `packages/executor-console/{access*.js,documents*.js,ai*.js,chatgpt*.js,inference-endpoints.js,team-drafts.js,autosave.js}` (old `sync*.js`, `permissions.js` move here), their renderer journeys under `tray-windows/test/` (new files only) |

**Wave 2:** F CLI parity (`nessie-computer` command, verb tree mirroring §3,
help, CLI docs, packaging aliases, re-pointing the apps at the user-facing
verbs); integration fixes.
**Wave 3:** verification (§10).

## 9. CLI parity (tranche F)
**Spec:** `docs/wiki/Command-reference.md` and `docs/wiki/Command-line.md` (the
user docs) define the commands, options, output and exit codes. Help text and
docs must match; a difference is a defect in one of them.

User documentation lives in `docs/wiki/` (published to the GitHub wiki after
the code lands) and the consumer `README.md`; developer material is in
`CONTRIBUTING.md`. Change them with behaviour.
`nessie-computer` (alias `nessie-executor`, kept because installed services,
packages and scripts call it). Verb tree mirrors the window:
`status` · `teams` · `connect` · `disconnect` · `pause` / `resume` ·
`access show|folders|programs|websites|local-apps|coding-assistants` ·
`documents on|off|folder|pause|resume|deleted|conflicts` ·
`ai plans|servers` · `settings login|auto-restart|updates` ·
`requests list|allow-once|always|deny` · `who --team`.
`--team` takes the team label or its id; every verb has `--json`. Plumbing
verbs stay, documented in a separate "For the apps and scripts" help section.
Help text uses §2 words, has examples, and a test checks every verb's help.

## 10. Verification (every tranche, then wave 3)
- Focused unit/source tests through the public Turbo graph. Heavy builds, test
  suites and typechecks run on **Maxis** (`ssh ondre@Maxis.local`, a directory of
  your own under `C:\Users\ondre\Projects\`), never on Minis; the Mac builds only
  Swift/Xcode.
- Console: local headless renderer journeys for every new or changed state, in
  light and dark, desktop size, Czech and English, before/after captures.
- Never touch the installed Nessie / Nessie Executor apps, their services or
  saved state on any machine; no pairing against production from a test.
- Report: branch, every commit hash (pushed), what ran (host, command, result),
  what did not, deviations from this doc.

## 11. Asynchronous computer: sessions and concurrent commands (wave 2, A3 + D2)

Ruling: every piece of work runs inside a **session**; sessions run in
parallel, and **commands inside a session run in parallel too**. Today the
protocol is one command at a time per team (the daemon polls; while a command
is active it polls only for its cancellation; Nessie hands out the next command
after the receipt). That ends here.

### 11.1 Session
- A session has an id, belongs to one agent run on one computer (team), and
  carries the person the run acts for and the conversation's computer lease.
  Nessie opens it when the run first needs the computer and closes it when the
  run ends, the owner chooses Stop, the lease ends, the team is paused or
  disconnected. It survives individual commands and daemon restarts.
- Existing terminal, coding and browser sessions keyed by `runId` become
  resources *inside* the session, not separate concepts.

### 11.2 Commands
- Every command carries `sessionId` and has its own id, status and events.
  Dispatch never waits for another command's result. The agent decides what to
  wait for (one, several, any); a dependent step waits for its input.
- The daemon serialises only per resource that cannot overlap: one terminal's
  input, one browser tab's actions, writes to the same path, a local app that
  declares itself single-request. Everything else runs concurrently.
- Capacity: per-session and per-computer limits by kind (file operations high;
  program/terminal launches, coding sessions and browser actions lower; guest
  sandboxes per folder). Commands above capacity wait in the daemon's queue,
  visible as "waiting to start".
- A program request holds only its own command (no 120 s team-wide block); the
  request can wait up to 15 minutes and the agent is told it is waiting for the
  owner. Allow once applies to that command; Always allow adds the rule.
- Stop cancels every command of a session; Pause refuses new commands in every
  session; an update drains all sessions.

### 11.3 Protocol (opt-in, backward compatible)
- Poll request: new daemons send `concurrency: 1` (version) with
  `capacity: { file, program, coding, browser, mcp }` (free slots) and
  `activeCommands: CancellationTarget[]`. Nessie answers `commands: Command[]`
  (≤ capacity, ordered by creation) and `cancellations: CancellationTarget[]`.
  A daemon without `concurrency` keeps today's single `command`/`activeCommand`
  shape, and Nessie keeps serving it.
- Command envelope gains `sessionId`; Nessie also sends `sessionClose` items
  (poll and doorbell) so the daemon ends a session's resources.
- Doorbell: Nessie rings the computer's existing authenticated doorbell when a
  command is queued for it, so work starts immediately; polling stays the fallback.
- Receipts stay per command. The daemon's recovery journal becomes one record
  per command id (it holds a single command today).
- Ship order: Nessie understands the new fields before any daemon sends them.

### 11.4 Nessie (D2)
- Dispatch up to the daemon's capacity, preserving creation order only as a
  tie-break; per-session and per-person fairness.
- Agent tools return a command handle immediately ("running"); a
  `computer_wait` style tool (or the existing catalogue's equivalent) waits for
  one/all/any handles with a timeout; the run parks durably and resumes when a
  receipt arrives (existing durable receipt/resume and internal events), never
  holding a provider call open.
- Conversation shows "waiting for the computer's owner to allow `docker build`"
  and the outcome; `EXECUTOR_OWNER_PAUSED`, `owner_declined`,
  `owner_did_not_answer` are shown in plain words. Commands carry the agent's
  display name for program requests.
- The computer page and Dev section list sessions and their running commands.

### 11.5 The app (console + natives)
Overview gains **Now working**: one row per session (agent · team), its running
commands beneath ("running `npm test`", "reading report.md", "waiting for you:
`docker build`", "waiting to start"), and **Stop** per session. Bridge:
`executor_sessions { executorId? }` → sessions with commands;
`executor_stop_session { executorId, sessionId }`. CLI: `nessie-computer
sessions [list|stop <id>]` (also in the wiki Command reference).

## 12. AI already on this computer (A4 + D3)

Ruling (Ondrej, 8 Nov): anything already installed and signed in on the
computer is offered with one switch, **Make available**, per connection (the
team in the dropdown). Whether the team or only the owner may use it is
Nessie's setting, not the computer's.

- **On by default (ruling, 8 Nov):** an installed, signed-in Claude Code or Codex
  is available to every connection unless the owner switches it off; an
  explicit off is stored and kept.
- **On this computer:** Claude Code and Codex, detected (installed, signed in,
  which account — the existing account probes). Each row: name, account,
  **Make available** switch. Not installed → row greyed out, "Not installed on
  this computer"; installed but signed out → "Run `claude` (or `codex`) once to
  sign in". Turning it on offers that engine to Nessie for this connection;
  agents' AI then runs through the installed CLI with its own login, like T3
  Code. Nessie Computer never reads, copies or refreshes those credentials.
  Reuse the CLI inference backends that already serve DeepTest grants and the
  local inference host contract; work runs inside sessions (§11).
- **More accounts:** OAuth. ChatGPT plans (existing OAuth, any number). Claude:
  use a provider OAuth only if Anthropic permits third-party use of Claude
  plans; otherwise "Add another Claude account" runs Claude Code's own sign-in
  in a separate profile (its own config directory), keeping the T3 model.
- The ChatGPT-plan terminal restriction applies only to Nessie-held plan
  grants, never to CLI-backed engines.
- Bridge: `executor_local_ai { executorId }` → `[{ engine: 'claude-code'|'codex',
  installed, signedIn, account?, available }]`;
  `executor_set_local_ai { executorId, engine, available }`.
  CLI: `nessie-computer ai local [list]`, `ai local on|off <claude-code|codex>`.
- Nessie (D3): show "Claude Code on {computer}" / "Codex on {computer}" as
  models wherever local computer models are offered, governed by the existing
  local-model binding and sharing rules; inference routes to the computer;
  funded by the owner's subscription, never Ledger credits; plain errors when
  the computer is offline, paused, or the CLI signs out.
