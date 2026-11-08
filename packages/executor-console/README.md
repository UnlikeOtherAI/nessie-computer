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
| shell (E1) | `index.html`, `style.css`, `native.js`, `i18n.js`, `main.js` | the window, tokens, host transport, translations, `window.nc` |
| shell (E1) | `errors*.js`, `teams*.js`, `overview*.js`, `pairing*.js`, `settings*.js`, `updates*.js` | failure translator, team state, Overview, Connect a team, Settings, Software updates |
| team tabs (E2) | `access*.js`, `documents*.js`, `ai*.js`, `chatgpt*.js`, `inference-endpoints.js`, `team-drafts.js`, `autosave.js` | render into `#tab-access`, `#tab-documents`, `#tab-ai`; inject their own dialogs |

`index.html` leaves the three team panels empty. Each E2 script subscribes to
`nc.view.onChange` and `nc.team.onChange` and renders when its tab and team
are current.

## `window.nc`

Built by `i18n.js` and `main.js`, extended by `teams.js`, `errors.js`,
`overview*.js`, `pairing.js` and `updates.js`. Everything below is available to
every script that loads after `main.js`.

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
- `nc.notify(title, body)` — `executor_notify`; with notifications off, the
  footer says it instead. Saves never call it (§3.3.4).
- `nc.keepFocus(container, rebuild, fallback)` — rebuilds a list keeping focus
  on the row control with the same `data-key`.
- `nc.dialogs.open(id)` / `nc.dialogs.close(id)` — `showModal` with errors
  cleared and focus on `[autofocus]` or the `h2`. Any `.dialog-close` button
  closes its dialog, including buttons in dialogs E2 injects.

### View

- `nc.view.current()` — `overview` | `access` | `documents` | `ai` | `settings`.
- `nc.view.show(tab)`, `nc.view.onChange(fn)` (`fn(tab)`), `nc.view.teamTabs`.
  The team row shows on team tabs only; `#no-team` replaces a team panel when
  nothing is connected.

### Team

- `nc.team.current()` — selected `executorId` or `null`; `nc.team.select(id)`;
  `nc.team.onChange(fn)` (`fn(executorId)`).
- `nc.team.list()` — the latest `executor_view` rows
  (`{ executorId, daemonStatus, paused, failure?, pendingProgramRequests }`);
  `nc.team.get(id)`; `nc.team.onListChange(fn)` fires when the rows or a label
  change; `nc.team.refresh()` re-asks the host (also every 5 s).
- `nc.team.label(id)` — `{teamName} · {organizationName}`, ` ({serverHost})`
  when two are equal, “Team name not available yet” when unknown. Never an id.
  `nc.team.host(id)`, `nc.team.apiBaseUrl(id)`, `nc.team.nameUnknown(id)`,
  `nc.team.ownerConfirmationRequired(id)`.
- `nc.team.status(row)` — `working` | `paused` | `needs_you` | `not_connected`;
  `nc.team.statusWord(row)` the §2 word for it.
- `nc.team.describe(id = current, { fresh })` — the team's `executor_describe`,
  loaded once per team and cached; `fresh` re-asks. `nc.team.remember(id,
  describe)` stores the describe a `executor_configure` answered with, so the
  Overview summary follows a save without another call.
- `nc.team.setPaused(id | null, paused)` — `executor_set_paused`;
  `nc.team.applyRemedy(id, remedy)` — `executor_apply_remedy`;
  `nc.team.disconnect(id)` opens the Disconnect dialog.

### Failures

- `nc.failure.translate({ code?, message })` → `{ code, explanation, remedy:
  { id, label } | null, detail }`. Matched on `code`, else on the fixed
  message literals the CLI prints. Unknown failures are quoted under Details.
- `nc.failure.render(container, failure, { executorId, onRemedy })` fills the
  explanation, the one remedy button and the Details disclosure.
- Remedy ids sent to `executor_apply_remedy`: `re-propose-policy` (send the
  current settings again as a newer revision), `restart` (reconnect the team).
  `open-nessie` is handled in the window and never sent.

### Overview and Connect a team

- `nc.overview.connected(executorId)` — shows the connected card for a team
  that just paired (Connect a team calls it).
- `nc.pairing.open()` — opens Connect a team and asks for a code straight away;
  `nc.pairing.restore()` reopens an attempt left waiting.
- `nc.updates.onStatus(fn)` / `nc.updates.status()` — the update broker's
  latest status (Help shows the version from it).

## Host commands this window calls

Contract §5.1, plus these shapes the window relies on:

- `executor_open_nessie { apiBaseUrl, path? }` — `path` is an absolute path on
  the paired server's console, used by Connect a team for
  `/admin/computers?create=1&code=<code>`. Without `path` the host opens
  `/admin/computers`.
- `executor_pairing_status { executorId }` — names a paired team
  (`organizationName`, `teamName`, `apiBaseUrl`); the label comes from it.
- `executor_sync_status { executorId }` — `FolderSyncConsoleState`; the
  Overview reads it only to list Documents attention under Needs you.
- `executor_describe` — the Overview summary reads `reach.folders`,
  `reach.allowedOrigins`, `commandPolicy` (with `trusted`), `mcpPolicy`,
  `localApps` (falling back to `mcpServers` keys on an older runtime).

## Verification

Local headless journeys (never CI): `node tray-windows/test/renderer-harness.mjs`
runs the shell journeys for both hosts; `--shell-only` serves the E2 files
empty, for use before the team tabs land; `--updates-only` and the other
update flags are documented in `docs/automatic-updates.md`;
`--before=<rev>` captures the console at an older revision for comparison.
Screenshots land in the clone's ignored `.artifacts/executor-console/`.
