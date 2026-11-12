# Team names on the computer

Every surface names a team `{teamName} · {organizationName}` (contract §2):
the window's team dropdown and Settings, the macOS menu, the Windows menu, toasts and
the command line. None of them asks anyone for it. They read the team's
**label**, a small display-only record in the team's own state folder.

## The label

`team-label.json` beside `executor-state.json` (`src/team-label.ts`), owner-only:

```json
{ "organizationName": "Acme", "teamName": "Sales", "apiBaseUrl": "https://api.nessie.works",
  "checkedAt": "2026-11-08T12:00:00.000Z" }
```

- `teamName` is null for a team connected for its whole organisation.
- It is display metadata only. It never grants, narrows or proves access, and
  nothing sends it back to Nessie. The Windows supervisors read it directly, as
  they read `owner-pause.json` (`windows-common/src/team_label.rs`).
- Written when a team connects (from the pairing claim) and from every answer
  to the batched read below. A read that fails, is refused, or leaves a team
  out writes nothing, so **a known name is never blanked**.
- "Team name not available yet" appears only for a team that has never had a
  label.

## Reading names from Nessie

`POST /api/executor-daemon/teams` (`packages/protocol/src/executor-teams.ts`):
one request per Nessie server carrying every team paired with it,

```json
{ "entries": [{ "executorId": "…", "observedAt": "<iso>", "signature": "…" }] }
```

each entry signed with that team's machine key under
`nessie.executor.daemon.teams.v1` over `{ executorId, observedAt }`. Nessie
answers `{ "teams": [{ "executorId", "organizationName", "teamName" }] }` for
the entries it verified and leaves the rest out. No person, session or daemon
connection is involved; Nessie resolves the names itself (UOA's public team
lookup for a UOA-bound team).

The batched read is always asked first. When it gives no well-formed answer —
the route is missing (404), refused (production Nessie answers an unknown
`/api` route with 401 `AUTH_REQUIRED`; also 403 and 405), failed (5xx),
unreachable, or answered with something that is not well formed — each team in
that batch is read through the older signed
`POST /api/executor-pairing/connection`, all at once. Whichever read names a
team, its label is written. A team that a well-formed answer left out is not
asked again: that Nessie has the route and did not verify it. A refusal of the
connection read (some servers still require a person's session) leaves the
label as it was.

Every failure is logged once per refresh, one line each, by server host, team
id, HTTP status and error code — never a body, a signature or a key:

```
[nessie-executor] team names: api.nessie.works did not answer the batched read (HTTP 401 AUTH_REQUIRED); asking each team.
[nessie-executor] team names: api.nessie.works did not name team 48d72fea-… (HTTP 401 UOA_SESSION_REQUIRED).
```

The CLI prints them on standard error. The Windows service writes them to
`service.log`, the Windows app to its own diagnostics, and the macOS app to the
unified log (subsystem `com.unlikeotherai.nessie.executor.menubar`, category
`team-names`); none of them drops them any more.

`pairing-status` for a connected team no longer calls Nessie at all: it answers
the saved label.

## Who refreshes, and when

| Who | When | How |
|---|---|---|
| macOS app | at launch, then every hour | one `team-names --state-dir …` for all its teams |
| Windows app (tray) | at launch, then every hour | one `team-names` for the teams it runs under the person's account |
| Windows service | at service start, then every hour | one `team-names` for the teams it holds |
| `nessie-computer` (`teams`, `status`, any command that lists teams) | when a label is missing, from another server, or an hour old | the same read, waiting at most 4 seconds a request (8 when it falls back) |

`team-names --state-dir <dir> [--state-dir <dir> …] [--json]` prints
`{ "teams": [{ executorId, organizationName, teamName, apiBaseUrl }] }` with
null names for a team that has never had any.

## Verification

`test/team-names.test.ts` (two teams one call, two servers, offline/refused,
renamed, old server; a batched read answering 404, 401 `AUTH_REQUIRED`, 500 or
something malformed falls back and writes the label, with one log line; damaged
label, the verb), `test/pairing-code.test.ts`
(claim → label; status reads the label without a request) and the CLI suites
(`cli-user-commands`, `cli-service-teams`, `cli-sessions`) against the fake
Nessie in `test/support/fake-team-names.ts`. The supervisors' line filters are
`team_names_failures` (`windows-common/src/team_label.rs`) and
`TeamNamesFailures` (`menubar-macos/Sources/Core/TeamLabel.swift`).
