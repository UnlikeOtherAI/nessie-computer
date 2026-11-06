# Computer readings and conversations

The paired computer reports real host readings and locally discovered Claude Code
and Codex accounts. Nessie's Computers page owns their display; its sidebar opens
each computer and its individual sessions. Older installed executors report no
readings until upgraded through the normal signed package workflow.

## Measurement and quota sources

The daemon samples host CPU deltas, available RAM, home-volume capacity, uptime,
top process names/usage and available GPU counters independently of heartbeats.
Missing counters remain null. The history contains actual timestamps over the
last minute; there is no generated series. Process arguments are never reported.

Installed provider CLIs use the current configured user environment, including
CODEX_HOME and CLAUDE_CONFIG_DIR. We do not search unrelated users' profiles or
copy credentials. Codex account/read and account/rateLimits/read return account,
plan and quota windows. Claude's stream-JSON initialize and get_usage control
requests return account and quota data, with skip_behaviors enabled and no user
prompt. Probes run at most once per minute, independently from host sampling.
The existing local coding-session discovery switch also disables account probes.

Remaining percentages come from provider utilization or remaining-percent fields;
missing, unsupported and signed-out states never become a guessed allowance.
Duration distinguishes Codex session/weekly/monthly windows; model-specific and
Claude extra-usage windows remain separate. Provider credentials and raw responses
never leave the process. Only the paired owner may see personal account summaries
in Nessie; ordinary computer access does not disclose them.

## Discovery and observation

Recent native history follows T3 Code's 30-day, 5,000-session bound. Claude saved
project transcripts join the active registry. Codex pages its native state-backed
thread list without resuming threads. Stable identities include provider profile
and native ID. Discovery does not imply a thread is running: unknown stays unknown.
The full inventory travels in stable 32-row batches. Only a completed batch can
close an absent open session; retries and late batches cannot overwrite newer ones.

On viewer demand, the executor projects at most 200 recent messages from a bounded
native transcript tail, including text, reasoning summaries and tool calls/results.
It confines files to the discovered provider history root, checks native IDs and
ownership where supported, and handles Windows long-path prefixes without widening
that root. Transcripts pass through the existing secret/path projection. Managed
history reads the projected log independently; it never advances the agent cursor
or starts a host. Native history remains on the computer. The API holds encrypted
conversation snapshots for the existing 30-second viewer-demand lifetime.

Only the verified built-in bridge's daemon-only session_conversation response has
a separate 1 MiB transport budget. Ordinary MCP command results retain their
existing maximum and command-journal contract.

## Human input

The paired owner can send to a managed coding session or request an interrupt.
Native Codex supports Queue only when its experimental queue is advertised.
Native Claude supports Push only with the existing explicitly enabled channel.
Saved history without an active input capability remains readable. No operation
silently resumes or takes ownership of the original client. Shared viewers receive
no control authority. Raw terminal viewing remains read-only.

The server admits input inside the selected team against fresh session capabilities,
captures stable human-authority references, encrypts pending text and rechecks live
standing before dispatch. Requests expire after 60 seconds. UUIDs bind the same
request across network retries; local delivery journals prevent duplicate provider
writes and preserve unknown outcomes without replaying them. The API clears text
on a receipt/expiry and retains reconciliation metadata for at most one day while
the daemon connects. Native queue/channel acceptance is not consumption. All local
permission, reviewed-configuration and personal-custody checks still apply.

## Checks

Use pnpm exec turbo run test:computer-data from Nessie with an isolated DATABASE_URL.
For the public checkout use pnpm exec turbo run //#test:computer-data
--root-turbo-json=scripts/turbo.public.json. The ordinary public suite also includes
these tests. Browser checks stay local and headless in Nessie's test:e2e:dev.

Reference behavior: pingdotgg/t3code at 6577c6b6185167c0e502fa01f9e8e8f2dee6ff25
(MIT, T3 Tools Inc.); see the third-party notice. This does not bundle the T3 app.
