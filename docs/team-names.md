# Team names on the computer

Every surface names a team `{teamName} · {organizationName}` (contract §2):
the window's team list and cards, the macOS menu, the Windows menu, toasts and
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

A Nessie without that route answers 404. Only then is each of its teams read
through the older signed `POST /api/executor-pairing/connection`; a refusal
there (some servers still require a person's session) leaves the label as it
was.

`pairing-status` for a connected team no longer calls Nessie at all: it answers
the saved label.

## Who refreshes, and when

| Who | When | How |
|---|---|---|
| macOS app | at launch, then every hour | one `team-names --state-dir …` for all its teams |
| Windows app (tray) | at launch, then every hour | one `team-names` for the teams it runs under the person's account |
| Windows service | at service start, then every hour | one `team-names` for the teams it holds |
| `nessie-computer` (`teams`, `status`, any command that lists teams) | when a label is missing, from another server, or an hour old | the same read, waiting at most 4 seconds |

`team-names --state-dir <dir> [--state-dir <dir> …] [--json]` prints
`{ "teams": [{ executorId, organizationName, teamName, apiBaseUrl }] }` with
null names for a team that has never had any.

## Verification

`test/team-names.test.ts` (two teams one call, two servers, offline/refused,
renamed, old server, damaged label, the verb), `test/pairing-code.test.ts`
(claim → label; status reads the label without a request) and the CLI suites
(`cli-user-commands`, `cli-service-teams`, `cli-sessions`) against the fake
Nessie in `test/support/fake-team-names.ts`.
