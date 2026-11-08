# Programs, local apps and websites

This is what a team may use on a computer before the owner changes anything,
and how the computer decides each case. These rules are local: they live in
the team's owner-only state file, never in a descriptor or a server response,
and nothing Nessie grants can widen them (see [`SECURITY.md`](../SECURITY.md)).
The contract is [the Nessie Computer plan](plans/2026-11-08-nessie-computer.md)
§4.3 to §4.7 and §6.2.

## Programs

`LocalCommandPolicy` (`src/command-policy.ts`) holds the owner's rules:

- `mode`: `all` runs any program; `allowlist` runs only what the rules below admit.
- `allowlist` and `denylist`: owner patterns such as `git *` or `npm run *`.
- `trusted`: the four built-in entries in `src/program-trust.ts`.

### What a new team may start

A team connected with a pairing code, or with the older enrollment `pair`
command, starts with `mode: 'allowlist'`, no patterns, and all four built-in
entries on. Anything else waits for the owner.

| Built-in entry | Admits | Decided by |
|---|---|---|
| Apps from UnlikeOtherAI (`unlikeotherai`) | Programs whose code signature names UnlikeOtherAI | The operating system's signature check |
| Claude Code (`claudeCode`) | `claude` | The name, found through PATH |
| Codex (`codex`) | `codex` | The name, found through PATH |
| T3 Code (`t3Code`) | `t3` | The name, found through PATH |

The three named programs are the tools most people add a computer for. Each is
matched exactly like an owner's `claude *` rule: a bare name with any
arguments, compared case-insensitively and without `.exe` on macOS and
Windows. The terminal session finds it through the absolute entries of the
person's PATH when it starts. A path such as `/tmp/x/claude` is refused in
`allowlist` mode, as it is for owner rules, because a permitted tool could
leave an executable of that name anywhere.

T3 Code's command is `t3`. Its macOS app writes `~/.t3/bin/t3`, a script that
runs the app's bundled CLI, and its npm package installs the same name. The
app bundle path (`T3 Code (Beta).app` on the beta) changes between channels,
so the name is the rule.

### Apps from UnlikeOtherAI

A file name never qualifies. A program counts only when the operating system
verifies its signature and the signature names UnlikeOtherAI
(`src/program-trust-signature.ts`):

- **macOS.** `codesign --verify --strict` against a requirement for an
  Apple-anchored chain, Apple's Developer ID intermediate, a Developer ID
  Application leaf certificate, and team `23B7GTLBN7` (UnlikeOtherAI s.r.o.).
  An executable inside an app bundle is verified as that bundle, so a
  `com.unlikeotherai.*` app's own binary qualifies and the same binary copied
  out of its bundle does not. Mac App Store, Apple Development and ad-hoc
  signatures fail, from any team.
- **Windows.** Windows PowerShell's `Get-AuthenticodeSignature` must return
  `Valid` with the exact subject
  `CN=UnlikeOtherAI s.r.o., O=UnlikeOtherAI s.r.o., L=Mnichovice, S=Central Bohemia, C=CZ`.
  The path is passed in an environment variable, never inside the script.
- **Linux.** Not covered. An ordinary Linux executable has no signature the
  operating system verifies, so this entry admits nothing there and `describe`
  reports it with `available: false`. The owner adds such programs themselves.

Unsigned scripts are not covered on any platform. The signature is checked
only for a program the name rules have not already admitted, and only after
the denylist. A bare name is resolved through the absolute PATH entries first;
a symbolic link is followed once. The session then starts the exact file that
was verified, as an absolute path, rather than looking the name up again.

### How a launch is decided

1. The denylist, matched on the program's name however it is spelled. It
   always wins, over owner patterns, trusted names and signatures.
2. `mode: 'all'`: any program runs.
3. An owner allowlist pattern.
4. A trusted name (`claude`, `codex`, `t3`).
5. A verified UnlikeOtherAI signature (host terminal sessions on macOS and Windows).
6. Otherwise refused: `not_allowlisted`, or `path_needs_allow_all` for an
   absolute path. These are the refusals a program request (tranche A2) turns
   into a question for the owner; `denied` and `invalid_program` are not.

An allowlist with no patterns and nothing trusted is the enforced **No
programs** state. `configure` accepts it with `command.run` enabled: every
command is refused, or asked about once program requests exist.

`command.run` runs in the guest VM, which is Linux. There the trusted names
count as above, and the UnlikeOtherAI entry admits nothing, because the host
cannot verify a signature on a guest executable. Host terminal sessions
(`coding-session/terminal-launch.ts`) apply all five steps through
`localTerminalCommandDecision`.

### Existing teams

A team paired before these defaults keeps its saved rules. One with no saved
rules reads as `mode: 'all'` with nothing trusted, which is what it always
meant. `trusted` absent means none.

## Local apps (MCP servers)

`mcpPolicy` (`src/mcp-policy.ts`) is `{ mode: 'installed' | 'listed', disabled: string[] }`.

- **`installed`**, written for every new team: every local app installed on
  the computer, plus the owner's own entries, minus the discovered ones in
  `disabled`. The MCP operations `mcp.tools` and `mcp.call` are on exactly
  while there is an app to reach.
- **`listed`**, what a team with no saved policy reads as: only the servers the
  owner named, as before. Its reviewed set never grows by itself.

Discovery (`src/local-app-discovery.ts`) finds:

1. UnlikeOtherAI's Kelpie, as `kelpie mcp`, when `kelpie` is on PATH (on
   Windows also as npm's `kelpie.cmd`).
2. The user-scope stdio servers in Claude Code's `~/.claude.json`
   (`$CLAUDE_CONFIG_DIR/.claude.json` when set). A repository's `.mcp.json`
   and per-project entries belong to that repository, not to the person.
3. The stdio servers in Codex's `~/.codex/config.toml` (`$CODEX_HOME` when
   set), except `enabled = false` ones.

T3 Code keeps no MCP server list of its own; its agents are Claude Code and
Codex and read the two files above. Remote (`url`, `http`, `sse`) servers are
not local apps. A name is fitted to the server grammar (`node_repl` becomes
`node-repl`) or the server is left out; the first source to claim a name keeps
it, and none may take `coding-sessions`. A program found on PATH is stored as
its absolute path; one found nowhere is listed as not installed and never
started. On Windows a Store app's execution alias under `WindowsApps` counts as
installed, because CreateProcess starts it although `stat` cannot open it. At most eight servers fit a descriptor; owner entries come first and
`describe` marks the discovered apps past the limit with `reason: 'limit'`.

The launch specs, environments included, stay in the owner-only state file.
Only the names reach Nessie, in the signed descriptor. A change in the
discovered set is a new revision: `localAppsRevision` and `refreshLocalApps`
(`src/local-mcp-apps.ts`) produce and save it, and the daemon applies it live.

## Websites

`configure` takes `allowedOrigins` (HTTPS origins, `[]` for none). Once the
guest browser is set up they are stored in its configuration, exactly where
`configure-browser` stores them. Before that they are stored on the state
itself, so choosing websites never waits for the browser; `configure-browser`
then takes its own list and the earlier one goes. `describe.reach.allowedOrigins`
is the effective list and `sandbox.browserConfigured` says whether the browser
can open them yet.

The folders affect websites. A new pairing gets one folder, `nessie`, because
a guest VM mounts exactly one. Once the owner adds a second,
`describe.reach.guestSessions` is `refused_multiple_folders` and
`browser.open`, guest `command.run` and `coding.launch` refuse with
`EXECUTOR_GUEST_SINGLE_FOLDER_REQUIRED`. Host terminal sessions, local apps and
the workspace file operations are not affected.

## Who can send work here

`readAudience(stateDir)` (`src/audience.ts`) asks Nessie which agents, people
and projects the team lets reach this computer, with
`POST /api/executor-daemon/audience` signed by the machine key under
`nessie.executor.daemon.audience.v1` over `{ connectionEpoch, executorId,
observedAt }`. The answer is shown and discarded: it is never stored and never
grants or narrows access.

## What `describe` reports

- `commandPolicy`, including `trusted` when the team has it.
- `programDefaults`: the four built-in entries with `id`, `verifiedBy`
  (`name` or `signature`), `program` for the named three, and `available`.
- `mcpPolicy` and `localApps`: `{ name, source, enabled, installed, reason? }`,
  where `source` is `configured` (owner-named), `unlikeotherai`,
  `claude-code` or `codex`, and `reason` says why a discovered app is off
  (`switched_off`, `not_installed`, `limit`, `listed_only`). An owner-named app
  reads `installed: true`; whether it starts is the MCP report's answer.
- `reach.allowedOrigins` and `reach.mcpServers` (each with its `source`).

## Verification

`test/program-trust.test.ts`, `test/local-app-discovery.test.ts`,
`test/local-mcp-apps.test.ts`, `test/audience.test.ts`,
`test/executor-audience-protocol.test.ts` and `test/command-policy.test.ts`
cover these rules, including a file named like an UnlikeOtherAI program that
must not count. The signature checks are exercised with injected checkers;
the macOS requirement was checked by hand against installed apps (it accepts
the Developer ID-signed Nessie Executor app and rejects T3 Code's Developer ID
and a copied-out binary). A real Windows Authenticode check against an
UnlikeOtherAI-signed file is not part of the unit tests.
