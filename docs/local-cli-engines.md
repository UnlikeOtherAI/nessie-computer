# Claude Code and Codex as engines (wire contract)

Contract §12 ([Nessie Computer contract](plans/2026-11-08-nessie-computer.md#12-ai-already-on-this-computer-a4--d3))
offers Claude Code and Codex, already installed and signed in on a computer, to
Nessie with one **Make available** switch per team. This page is the exact wire
contract between the computer and Nessie (tranche D3 implements Nessie against
it), and the local shapes the apps read. The schemas are in
`packages/protocol/src/local-cli-engine.ts` and
`packages/protocol/src/local-agent-inference.ts`; where this page and the
schemas differ, the schemas win.

## What runs where

- The computer runs the installed CLI headless, with **its own sign-in**:
  `claude -p … --output-format stream-json` and `codex exec --json …`, with
  native tools, MCP servers, history and telemetry switched off (the same
  restrictions DeepTest inference uses). Nessie Computer never reads, copies or
  refreshes the CLI's credentials.
- Prompts leave the computer for the provider's cloud (Anthropic or OpenAI)
  under the owner's own plan. This is **not** local-weights inference; Nessie
  must never present it as "stays on the computer".
- The agent runtime stays in Nessie: context, disclosure, tool authorization,
  usage and conversation state. The CLI only answers one model turn.

## Engines, accounts and hosts

An **engine connection** is one engine and one account on one team connection
(one executor):

| Field | Values |
|---|---|
| `engine` | `claude-code`, `codex` |
| `profileId` | `null` for the CLI's own default account; a UUID for an account added in Nessie Computer ([more accounts](#more-accounts)) |

Each engine connection the owner made available is a **local-inference host**
of role `local_cli`, one per `(executorId, engine, profileId)`. Everything after
registration is the existing local-inference host protocol, unchanged:
challenge, `claim` envelope signed with the executor's machine key, socket,
heartbeat inventory, attempt claims, `accept`, frames, `result`, `terminate`,
resource attachment.

## 1. Register (new route)

`POST /api/local-inference/daemon/executor-cli-host`

```json
{
  "connectionEpoch": "42",
  "executorId": "<uuid>",
  "observedAt": "2026-11-08T12:00:00.000Z",
  "engine": "claude-code",
  "profileId": null,
  "available": true,
  "signature": "<base64url>"
}
```

Signed with the machine key in the domain
`nessie.executor.daemon.local_inference.cli_host.v1` over the canonical JSON of
every field but `signature` (`profileId: null` is signed). Authorize exactly as
`/api/local-inference/daemon/executor-host` does (live executor connection
epoch, signature, freshness).

- `available: true`: find or create the host
  `{ executorId, role: 'local_cli', cliEngine: engine, cliProfileId: profileId }`
  with custodian `executor.pairingOwnerUserId`; clear any withdrawal; answer
  `LocalInferenceExecutorHostSchema` (`{ connectionEpoch, hostId, organizationId }`).
  A revoked host stays revoked (same rule as `executor-host`).
- `available: false`: mark the host withdrawn, advance its connection epoch so
  an open socket of the old epoch is refused, and answer `{ "withdrawn": true }`.
  Unknown host: answer `{ "withdrawn": true }` too. Nessie then shows the
  engine as **Turned off on {computer}**, distinct from offline or paused.

The daemon registers on start, after each claim of its executor connection,
when the owner flips **Make available**, and when the account list changes. An
older Nessie answers `404`: the daemon offers nothing, keeps the owner's
switch, says "Nessie doesn't offer this yet" locally, and tries again after its
next executor claim. **Ship order:** Nessie implements this route, the role and
the inventory fields before it pins a protocol revision that names them.

## 2. Inventory

The host heartbeats exactly one model (or none when the CLI is not installed):

```json
{
  "name": "cli:claude-code",
  "displayName": "Claude Code",
  "cliEngine": "claude-code",
  "cliEngineState": "ready",
  "identitySource": "owner_configuration",
  "manifestDigest": "<sha256>",
  "capabilities": ["text", "tools"],
  "numCtxCap": null,
  "remoteHost": null,
  "remoteModel": null,
  "sizeBytes": null,
  "reportedAt": "…"
}
```

- `name`: `cli:claude-code`, `cli:codex`, or for an added account
  `cli:claude-code:<profileId>` / `cli:codex:<profileId>`.
- `displayName`: `Claude Code` / `Codex`, or `Claude Code · {account name}` for
  an added account, where the name is what the owner typed. The provider
  account's email never leaves the computer.
- `cliEngineState`: `ready` (signed in), `signed_out`. Show a signed-out engine
  as "Claude Code on {computer} is signed out. Run `claude` on that computer
  to sign in." (Codex: `codex`). Attempts to it fail with `cli_signed_out`.
- `manifestDigest` changes when the CLI version, the account or this protocol
  changes; Nessie's existing model-follow rule (`followRunningLocalModels`)
  mirrors it. It is not a weights manifest.
- `numCtxCap` is `null`: the CLI does not report its window and manages its
  own context. Nessie must not ask the owner to enter one for a CLI engine;
  send the agent's ordinary budget as `numCtx`.
- `heartbeat.paused` is `true` while the computer is paused (Pause), exactly as
  for local weights.

## 3. Attempts

`LocalInferenceAttemptRequest` as today, plus one optional field:

| Field | Meaning |
|---|---|
| `sessionId` | the §11 session of the run ([sessions](sessions-and-concurrency.md)). The computer refuses an attempt whose session the owner stopped or Nessie closed, and the owner's **Stop** ends its running attempts. Absent: the attempt counts under its `runId`. |

The host refuses, with an error frame and an error receipt:

| Code | When |
|---|---|
| `cli_signed_out` | the CLI is not signed in (checked before every turn) |
| `cli_not_installed` | the CLI is gone |
| `cli_unsupported` | the CLI lacks a required restriction flag (update it) |
| `unsupported_capability` | `maxOutputTokens` present (the CLIs have no per-call cap), `inferenceSource` present, a message whose content is not text |
| `session_stopped` | the attempt's session was stopped on the computer or closed |
| `cancelled` | Nessie cancelled, the owner stopped the session, or the computer paused |
| `inference_incomplete` | the CLI ended without a complete answer |
| `model_changed` | the CLI version or account changed during the turn |

- `reasoningEffort` `low|medium|high` passes to the CLI (`--effort`,
  `model_reasoning_effort`); `thinking` is ignored (no `thinking` capability).
- **Tools.** The CLI never runs a tool. Nessie's tool descriptions travel in the
  prompt; the CLI proposes calls in a fenced block after its reply, which the
  host turns into `toolCalls` (`toolCallId` `<attemptId>:cli-<n>`, only
  supplied tool names, arguments a JSON object). Nessie executes them as for
  any model.
- **Streaming.** Reply text streams as `output_text.delta` frames while the CLI
  writes it; the tool-call block never streams.
- **Result.** `capability.provider` is `executor/claude-code` or
  `executor/codex`; `inferenceSource` is absent; `usage` is what the CLI
  reported (either may be `null`); `remoteHost`/`remoteModel` `null`.
- **Concurrency.** Each host has its own resource pool (its own resource key),
  so Claude Code work never waits behind Ollama. Nessie sets its capacity in
  the resource control as today; recommended `2`.

## 4. Funding, sharing and errors (Nessie)

- Funded by the owner's own plan through their CLI sign-in: no Ledger credits,
  no organisation budget gate (as `local_device`).
- Who may use it (only the owner, or the team) follows the existing local-model
  binding and sharing rules (`localInferenceTeamShareAllows`); a host of role
  `local_cli` qualifies like a local-weights host.
- The ChatGPT-plan terminal restriction never applies to a `local_cli` host.
- Plain words when the computer is offline, paused (**Paused on the
  computer**), turned off (**Turned off on {computer}**) or signed out.

## More accounts

Anthropic does not permit third-party OAuth for Claude plans: "Using OAuth
tokens obtained through Claude Free, Pro, or Max accounts in any other
product, tool, or service — including the Agent SDK — is not permitted"
([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
reported February 2026 by [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)).
So **Add another Claude account** runs Claude Code's own sign-in
(`claude auth login`) in a profile directory Nessie Computer owns
(`CLAUDE_CONFIG_DIR`), and the account becomes its own engine row. Codex works
the same way with `CODEX_HOME` and `codex login`. ChatGPT plans keep their own
OAuth sign-in.

Profiles are computer-wide (under `~/.nessie/cli-accounts/`, owner-only); the
**Make available** switch is per team. Removing an account signs that profile
out with the CLI's own `logout` and deletes the directory.

## Local shapes (apps and CLI)

`nessie-computer ai local list --state-dir <dir> --json`, and the bridge
command `executor_local_ai { executorId }`, answer:

```json
[{ "engine": "claude-code", "profileId": null, "name": null,
   "installed": true, "signedIn": true, "account": "person@example.com",
   "available": false, "offered": "not_yet" }]
```

`offered` is `yes` (Nessie has the host), `no` (switched off), `not_yet`
(switched on, Nessie doesn't offer this yet or the team is not connected).
`executor_set_local_ai { executorId, engine, profileId?, available }` and
`ai local on|off <engine> [--account <name>]` change the switch, which is saved
in the team's state folder (`local-cli-engines.json`) and applied live.
`executor_local_ai_add_account { engine, name }` / `ai local add <engine> <name>`
start the provider's sign-in; `executor_local_ai_remove_account { profileId }`
/ `ai local remove <name>` remove it.
