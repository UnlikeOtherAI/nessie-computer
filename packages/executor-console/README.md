# Nessie Computer console

The one HTML window both native apps show (macOS menu bar app, Windows
notification-area app); Linux's settings page reuses its Software updates
section. Plain scripts, no build step: `index.html` loads them in order and each
one talks to the others through `window.nc`.

Contract: `docs/plans/2026-11-08-nessie-computer.md` §3.2–3.3 (window), §5
(bridge). Vocabulary: §2.

## Files

| Owner | Files | What they do |
|---|---|---|
| shell (E1) | `index.html`, `style.css`, `native.js`, `i18n.js`, `help.js`, `main.js` | the window, tokens, host transport, translations, the "?" control, `window.nc` |
| shell (E1) | `errors*.js`, `teams*.js`, `needs*.js`, `pairing*.js`, `settings*.js`, `updates*.js` | failure translator, team state, the Needs you strip, Add another team, Settings, Software updates |
| team tabs (E2) | `access*.js`, `documents*.js`, `ai*.js`, `chatgpt*.js`, `inference-endpoints.js`, `team-drafts.js`, `autosave.js` | render into `#tab-access`, `#tab-documents`, `#tab-ai`; inject their own dialogs; `ai-connection.js` is the Windows plan-connection dialog |

`index.html` leaves the three team panels empty. Each E2 script subscribes to
`nc.view.onChange` and `nc.team.onChange` and renders when its tab and team
are current. `index.html` loads `autosave.js` and `team-drafts.js` first, then
each tab's words before its module ([the team tabs](../../docs/nessie-computer-team-tabs.md)).
Every style lives in `style.css` on the one token set; no script injects a
`<style>` block.

## `window.nc`

Built by `i18n.js`, `help.js` and `main.js`, extended by `teams.js`,
`errors.js`, `needs.js`, `pairing.js` and `updates.js`. Everything below is
available to every script that loads after `main.js`.

## Less text (contract §13)

The window shows controls, short labels and status. An explanation sits behind
**?** beside the control it explains — `nc.help(text, { describes })` — never
as a paragraph or a hint line. The only visible sentences are consequences that
change a decision ("Programs run as you.", "Agents start nothing on this
computer.", the Disconnect confirm) and status lines. No tab has a heading:
the tab and the team dropdown already name what is shown.

### Words

- `nc.locale` — one of `en-GB`, `en-US`, `cs`, `de`, `es`, `fr`, `it`, chosen
  once from `navigator.languages` (`en-US` exact, other English → `en-GB`,
  regional variants fold to their language). `<html lang>` is set from it.
- `nc.words.register(namespace, { 'en-GB': {…}, 'en-US': {…}, cs: {…}, de: {…}, es: {…}, fr: {…}, it: {…} })`
  — throws at load when a locale is missing.
- `nc.t(key, vars)` — `key` is `namespace.path`; `{name}` placeholders come from
  `vars`. A value that is an object of plural forms (`one`, `few`, `many`,
  `other`) is picked by `vars.count` with `Intl.PluralRules`. A missing key
  returns the key and warns once.

### Core

- `nc.help(text, { describes })` — the one "?" control: a `<span class="help">`
  holding a button (accessible name "What this does") and a `role=tooltip`
  tip, shown on hover and keyboard focus, pinned by a click, closed by Escape
  (focus stays on the button), read by screen readers through
  `aria-describedby` on the button and on every element in `describes`. Give
  it an `id` when a journey must find it; `set(text)` rewrites the words at a
  later render. It stays inside its dialog or `main` at 440 px.
- `nc.byId(id)`, `nc.invoke(command, args)`, `nc.listen(event, handler)`.
- `nc.attempt(fn, { target })` — runs `fn`, reports a failure beside `target`
  (an element or id: an `aria-errormessage` slot if it names one, else a
  `.field-error` inserted after the control); without a target, in the open
  dialog's `.dialog-error`, else the current tab's `.tab-error`. Never locks the
  page. `nc.reportError(error, target)` and `nc.clearError(target)` do the two
  halves.
- `nc.footer.note(text)` — the footer's one line. `nc.footer.problem(group,
  { message, retry } | null)` — an unresolved save problem that outranks later
  notes until the same `group` clears it; `nc.footer.forget(prefix)` drops a
  team's groups (`"<executorId>:"`).
- `nc.keepFocus(container, rebuild, fallback)` — rebuilds a list keeping focus
  on the row control with the same `data-key`. The window never posts an OS
  notification itself (`executor_notify` is gone, §5.1).
- `nc.dialogs.open(id)` / `nc.dialogs.close(id)` — `showModal` with errors
  cleared and focus on `[autofocus]` or the `h2`. Any `.dialog-close` button
  closes its dialog, including buttons in dialogs E2 injects.

### View

- `nc.view.current()` — `access` | `documents` | `ai` | `settings`; the tab
  last used is remembered (`localStorage` `nc.tab`) so the window reopens on it.
- `nc.view.show(tab)`, `nc.view.onChange(fn)` (`fn(tab)`), `nc.view.teamTabs`.
  One team dropdown above the tabs picks the team every tab shows; its last
  entry, **＋ Add another team**, starts pairing at once and the dropdown goes
  back to the team. `#no-team` replaces a team panel when nothing is connected,
  with that one button; Settings still shows the computer's part.

### Team

- `nc.team.current()` — selected `executorId` or `null`; `nc.team.select(id)`;
  `nc.team.onChange(fn)` (`fn(executorId)`).
- `nc.team.list()` — the latest `executor_view` rows
  (`{ executorId, daemonStatus, paused, failure?, pendingProgramRequests }`);
  `nc.team.get(id)`; `nc.team.onListChange(fn)` fires when the rows or a label
  change; `nc.team.refresh()` re-asks the host (also every 5 s).
- `nc.team.label(id)` — `{teamName} · {organizationName}`, ` ({serverHost})`
  when two are equal, “Team name not available yet” when unknown. Never an id.
  A Windows row another row names as its `chatgptConnectionId` is the team's
  **ChatGPT plan connection**: labelled as such, kept out of `nc.team.teams()`
  (the rows the dropdown, the team count and the cards use) and reported on
  the team's own card. `nc.team.isPlanConnection(id)`, `nc.team.teamOf(id)`
  (the team a connection belongs to) and `nc.team.planConnectionOf(teamId)`
  (the connection that holds the team's plans: a `service` row itself, the
  linked connection, or `null` while a Windows user row has none yet).
  `nc.team.host(id)`, `nc.team.apiBaseUrl(id)`, `nc.team.nameUnknown(id)`,
  `nc.team.ownerConfirmationRequired(id)`.
- `nc.team.status(row)` — `working` | `paused` | `needs_you` | `not_connected`;
  `nc.team.statusWord(row)` the §2 word for it.
- `nc.team.describe(id = current, { fresh })` — the team's `executor_describe`,
  loaded once per selection (§5.3) and kept until `remember` or `fresh`
  replaces it; a read that fails is not kept. `nc.team.remember(id, describe)`
  stores the describe an `executor_configure` answered with (the team tabs'
  drafts call it), so a later read follows a save without another call.
- `nc.team.setPaused(id | null, paused)` — `executor_set_paused`;
  `nc.team.applyRemedy(id, remedy)` — `executor_apply_remedy`;
  `nc.team.disconnect(id)` opens the Disconnect dialog. Settings shows the
  selected team first — its status word, **Pause**/**Resume**, **Disconnect…**
  — then the computer (open at login, restart if it stops, updates, logs).

### Failures

- `nc.failure.translate({ code?, message })` → `{ code, explanation, remedy:
  { id, label } | null, detail }`. Matched on `code`, else on the fixed
  message literals the CLI prints. Unknown failures are quoted under Details.
- `nc.failure.render(container, failure, { executorId, onRemedy })` fills the
  explanation, the one remedy button and the Details disclosure.
- Remedy ids sent to `executor_apply_remedy` (§5.1): `reProposePolicy` (send
  the current settings again as a newer revision) and `restartExecutor`
  (reconnect the team). `openNessie` is handled in the window, which calls
  `executor_open_nessie { executorId }` itself.

### Needs you and Add another team

- `needs.js` owns the strip under the team dropdown (`#needs-you-list`), on
  every tab and only while something waits: program requests with **Allow
  once** / **Always allow {program}** / **Don't allow** inline, a team that is
  not connected with its one remedy (`nc.failure.render`), a computer Nessie
  must confirm (**Open Nessie**, `executor_open_nessie { executorId, computer:
  true }`), stuck updates (**Restart updates**) and Documents waiting for a
  decision (**Open Documents**). Read every 5 s; `nc.needs.refresh()` asks
  now; `nc.needs.syncAttention(state)` is the Documents rule.
- `nc.pairing.open()` — opens Add another team and asks
  `https://api.nessie.works` for a code straight away (the dropdown's last
  entry, `tray://connect`, the menus' "Add another team…" and a new install
  with no team land here). The countdown runs to the server's `expiresAt`; an
  expired code stays visible with **Get a new code**, and a refused request
  says why with **Try again**. The server address field sits closed behind
  "Own Nessie server", its words behind "?", and is filled only when a waiting
  code belongs to such a server. **Get code** asks the host first: a refused
  address leaves a waiting code as it was, and that code is cancelled only once
  the host accepts an address for another server. The claim in Nessie closes
  the dialog, selects the team and opens its Access tab.
  `nc.pairing.restore()` reopens an attempt left waiting and answers whether it did.
- `nc.updates.onStatus(fn)` / `nc.updates.status()` — the update broker's
  latest status.

## Host commands this window calls

Contract §5.1, the Windows bridge (`tray-windows/src-tauri/README.md`) and the
macOS bridge (`menubar-macos/README.md`), plus these shapes the window relies on:

- `executor_launch_link` — asked once when the page has loaded; Windows
  answers `{ section, executorId? }`, `{ connect: true }` or `null` for the
  `nessie-computer://` link that started the app. A host without the command
  refuses it, which the window reads as no link.
- `executor_chatgpt_connection_start | _status | _cancel { executorId }` —
  Windows only: the service-owned connection a team's ChatGPT plans need
  (`ai-connection.js`). The answer is the pairing view; the claim in Nessie
  pairs it, and the next `executor_view` links the team row to it.
- `executor_pairing_start { apiBaseUrl }` — no other option.

- `executor_open_nessie { executorId?, computer? }` — the host builds the URL
  from the named team's paired server (or its own when no team is named) and
  adds `?create=1&code=<code>` itself while a pairing code is showing. With
  `computer: true` it opens that team's own computer page
  (`/admin/computers/<executorId>`), where its owner confirms this computer
  again when Nessie needs that before it names the team (the Needs you strip's
  line). The page never passes a path or URL (§5.1).
- `executor_pairing_status { executorId }` — names a paired team
  (`organizationName`, `teamName`, `apiBaseUrl`); the label comes from it.
- `executor_sync_status { executorId }` — `FolderSyncConsoleState`; Needs you
  reads it only to list Documents attention.
- Not called any more (ruling, 8 Nov): `executor_audience`, `executor_sessions`
  and `executor_stop_session` — "Who can send work here" and "Now working" left
  the app; the fake host treats a call to them as a defect.
- `executor_describe` — Access draws the Programs built-ins from
  `programDefaults` (`{ id, verifiedBy, program?, available }`) and
  `commandPolicy.trusted`; a local app's `source`
  is `unlikeotherai`, `claude-code`, `codex` or `configured` (owner-named,
  removed through `executor_configure { mcpServerRemovals: [name] }` rather
  than switched; `describe` omits each server's `env`, so the page never sends
  the server list back).

## Verification

Local headless journeys (never CI): `node tray-windows/test/renderer-harness.mjs`
runs every journey — shell, Access, Documents, AI and Software updates —
against the real `index.html`, for both hosts, seven locales, light and dark,
at 640×680 and the 440×500 minimum window, assertions only (the shell journey
also opens "?" tips with `checkHelp`). `--only=shell,access,…` narrows it;
`--updates-only` and the other update flags are documented in
`docs/automatic-updates.md`; `--before=<rev>` captures the console at an older
revision for comparison; `--output=<dir>` moves the pictures. They land in the
clone's ignored `.artifacts/executor-console/{before,after}`. `pnpm lint` in
this package lints these scripts with the repository's ESLint config.
