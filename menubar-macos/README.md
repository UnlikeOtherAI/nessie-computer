# Nessie Computer for macOS

The menu bar app that lets agents in a Nessie team use this Mac. It is a UI
for the bundled CLI: it reads every team through `describe`,
changes them through the CLI's own verbs, and never opens executor state files
itself. The window is the shared console in `packages/executor-console`. The
contract it implements is
[the Nessie Computer redesign](../docs/plans/2026-11-08-nessie-computer.md).

## Name and bundle

People see **Nessie Computer** in Finder, Spotlight, Launchpad, the window,
the menu, notifications, permission prompts and Login Items. The bundle on disk
stays `Nessie Executor.app`, with identifier
`com.unlikeotherai.nessie.executor.menubar`: the updater, the protected runtime
and the native custody checks verify `/Applications/Nessie Executor.app` and
`/Library/Application Support/Nessie Executor`, and state directories keep
their paths so an update strands no pairing.

The visible name comes from `LSHasLocalizedDisplayName` and
`Sources/App/Localization/<language>.lproj/InfoPlist.strings`. Finder shows a
localized name only while the bundle's file name matches the non-localized
`CFBundleDisplayName`, so `Info.plist` keeps "Nessie Executor" there. The same
files translate the folder, removable-drive, network-drive and local-network
usage strings. The DMG's volume is named "Nessie Computer"; its file name keeps
`NessieExecutor_<version>_<arch>.dmg`, which the update catalogue publishes.

Verified on an unsigned build: LaunchServices names the bundle "Nessie
Computer" and it carries all seven localizations. Login Items, notification
and permission-prompt wording are not checked on an installed, signed app.

## Menu

The menu speaks about every team at once (`ComputerMenuModel`); no team is
selected. From the top:

- a disabled status sentence ("Working for 2 teams · 1 paused", "Paused",
  "Not connected — open Nessie Computer");
- one "Needs you" line when something needs the owner, which opens its exact
  place (Overview with the team, or Documents for a documents problem);
- **Pause** / **Resume**: one line for one team; with several, a submenu with
  "All teams" and then each team's label, checked while paused;
- **Open Nessie Computer…** (the window, on Overview) and **Open Nessie** (the
  paired server's Computers page);
- **Quit Nessie Computer**, which adds "— agents stop until you open it again"
  while any team is working.

Team labels are `{team} · {organisation}`, from the CLI's pairing status and
held in memory only; two equal labels get the server's host.

The icon is idle (nothing connected, everything paused, connecting, stopping),
working, or needs you. Needs you means a program request, documents that need
the owner, a failure no automatic restart will retry, or a broken install.
Starting, stopping and connecting are never amber.

## Teams, Pause and restarts

Every paired team's daemon runs while the app does; there is no Stop. Pause
and Resume call `pause` / `resume --state-dir`, which save the owner's choice
in the team's state directory; the daemon stays connected and refuses new
work. Because the daemon enforces it, a pause survives launch, automatic
restart and the app being reopened after an update — this app never resumes a
team on its own.

A team that an earlier version had stopped (the old
`executor.connection.running.<directory>` default set to false) is paused
through the CLI before its daemon first starts; the old switch is forgotten
only once that pause is saved.

"Restart a team if it stops" (on by default) restarts a daemon that exited on
its own, and retries a start that failed for a reason that can heal (a timeout,
or a refusal this app does not recognise, such as a network not up yet at
login), from 5 seconds doubling to 5 minutes. A fenced connection, a rejected
key or a stale revision is never retried: it waits for the owner's remedy.

Each daemon's output goes to `~/Library/Logs/Nessie Computer/<team-directory>.log`
(owner-only). A log over 5 MB becomes `.previous.log` at the next start.
Settings → Help → open logs folder opens that folder.

## Bridge commands

The console calls these through `window.webkit.messageHandlers.executor`
(contract §5.1). Every team command names its team with `executorId`.

| Command | Does |
|---|---|
| `executor_view` | `{ kind: 'reachable', executors: [{ executorId, daemonStatus, paused, pendingProgramRequests, failure?: { code?, message } }] }` |
| `executor_set_paused` | `{ executorId \| null, paused }`; `null` is every team; answers the view |
| `executor_apply_remedy` | `{ executorId, remedy }` with `reProposePolicy`, `openNessie` or `restartExecutor`; answers the view |
| `executor_audience` | the CLI's `audience --json` for the team |
| `executor_program_requests` | `{ executorId? }`; `[{ executorId, id, program, args, agentName?, requestedAt, expiresAt }]` |
| `executor_answer_program_request` | `{ executorId, id, answer: once \| always \| deny }`; answers every team's open requests |
| `executor_configure` | `configure --configuration-input-stdin`, with the daemon left running; answers `describe` |
| `executor_open_logs` | opens the logs folder |
| `executor_open_nessie` | `{ executorId? }`: that team's Nessie; while a code is showing, `/admin/computers?create=1&code=<code>` on the attempt's server |
| `executor_pairing_start` | `{ apiBaseUrl? }`, defaulting to the hosted Nessie; there is no other option |

`failure.message` is the CLI's own sentence; `failure.code` is set when
`FailureClassifier` recognises it. The console translates both. Removed:
`executor_set_running`, `executor_hide_status`, `executor_reconnect` and
`executor_notify` (saves never post notifications). Section events are
`tray://section/<overview|access|documents|ai|settings>` with an optional
`{ executorId }`, and `tray://connect` opens Connect a team.

## Program requests

When a team has `pendingProgramRequests`, the app reads
`program-requests --json` and posts one notification per request with **Allow
once**, **Always allow {program}** and **Don't allow**. The actions need an
unlocked Mac. Notification permission is asked the first time a request needs
one. Answered or expired requests are withdrawn. Clicking the notification
opens Overview with the team.

## Links

`nessie-computer://open?section=<overview|access|documents|ai|settings>[&team=<executorId>]`
and `nessie-computer://connect` only navigate the window. Anything else —
another host, a path, an unknown parameter, a team that is not a UUID — is
ignored.

## Building and testing

```sh
scripts/test-app.sh             # unit tests (menu model, icon, pause, links, words)
scripts/build-app.sh            # unsigned app; the packaging pipeline signs it
```

Native strings live in `Sources/Core/Words*.swift`, one exhaustive `switch`
per language (en-GB and en-US share English, then cs, de, es, fr, it), so a new
word does not compile until every language has it. An Xcode build registers
the built app with LaunchServices; unregister a development build
(`lsregister -u <app>`) so it never becomes the `nessie-computer://` handler.
