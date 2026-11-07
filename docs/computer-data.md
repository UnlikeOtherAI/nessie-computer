# Computer readings and conversations

The paired computer reports real host readings and locally discovered provider
accounts. Nessie's Computers dashboard owns their display; its sidebar opens
each computer and its individual sessions. Older installed executors report no
readings until upgraded through the normal signed package workflow.

## Measurement and quota sources

The executor keeps a timestamped rolling minute locally, sampling every three
seconds without sending that history to Nessie. An entitled person opening the
computer monitor renews one aggregate 15-second viewing request. A database
notification wakes the computer's existing authenticated doorbell immediately;
without a doorbell, the next normal heartbeat discovers the request.

The signed heartbeat opts in with `monitorVersion: 1` and receives a bounded
`monitorRequest` deadline. The first requested upload uses the already sampled
minute, followed by snapshots every five seconds while demand remains live.
Renewals do not restart sampling or create another stream. Without a request,
heartbeats keep their normal 20-second presence cadence and omit statistics.
The executor bounds deadlines locally and clears demand on connection failure.
Closing, covering or hiding the browser monitor stops renewals; no explicit
disconnect message is needed for an abandoned view to expire.

Nessie discards unsolicited or expired monitor uploads before encrypting or
storing them, including reports from older installed executors. Older heartbeat
clients keep their original response shape. Deploy the API/migration before the
new executor packages; old servers do not accept the new signed opt-in field.
An executor that started less than a minute ago sends only readings it has
actually collected. Sleep and failed counters never produce fabricated points.

The daemon samples host CPU deltas, available RAM, home-volume capacity, uptime,
top process names/usage and available GPU counters independently of heartbeats.
Missing counters remain null. The history contains actual timestamps over the
last minute; there is no generated series. Process arguments are never reported.

Installed provider CLIs use the current configured user environment, including
CODEX_HOME and CLAUDE_CONFIG_DIR. We do not search unrelated users' profiles or
copy credentials. Codex account/read and account/rateLimits/read return account,
plan and quota windows. Claude's stream-JSON initialize and get_usage control
requests return account and quota data, with skip_behaviors enabled and no user
prompt. Probes run at most once per minute while somebody is watching,
independently from host sampling and heartbeat delivery.
The existing local coding-session discovery switch also disables account probes.

Host metadata includes hostname, first external IPv4, logical core count and
POSIX load where available. NVIDIA memory sums all readable cards while GPU
utilization uses the busiest card; missing counters remain null. These optional
fields keep older collectors readable. Never infer GPU usage from an allocation.
Linux Intel hardware can report utilization through measured RC6 idle-counter
deltas when a direct busy counter is absent. Counter resets remain unknown.

### Account identity and additional SysMon sources

Claude and Codex follow T3 Code's read-only control requests:
[Claude](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/claudeUsageLimits.ts),
[Codex](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/codexUsageLimits.ts).
Codex's workspace is the rate-limit response's `accountId`. Claude's is
`oauthAccount.organizationUuid` in the CLI-owned `.claude.json`, respecting
`CLAUDE_CONFIG_DIR`. Only that metadata field is projected from the bounded file;
no raw file, credentials or provider workspace identifier travels. Domain-separated
SHA-256 keys allow client-side pooling by provider/account/workspace. Missing
identity never means all accounts of a provider are the same account. Claude's
spend amounts are compared only with matching currency and decimal scale.

Kimi reads an existing local coding OAuth credential, configured official API key
or native configuration, then GETs only `https://api.kimi.com/coding/v1/usages`.
It never refreshes or writes credentials. Expired/unauthorized credentials remain
signed out. Native weekly `usage` is authoritative; detailed windows and legacy
short-window readings retain the stricter limit. Missing values never become
zero usage. An opaque subject or credential fingerprint supports deduplication
when no email is reported; rotating an unidentified credential can therefore
produce a separate account, rather than an unsafe guessed merge.

Grok uses an existing SysMon installation's authenticated read-only `get_accounts`
MCP call at the fixed local `127.0.0.1:7738/mcp` endpoint. Only Grok's derived
windows are projected; no cookies, browser profile, token or other SysMon machine
rows travel. SysMon owns browser sign-in. Without its local token there is no
fabricated Grok card. SysMon currently reports no stable Grok account identity,
so separate unknown installations cannot be safely merged. Kimi/Grok parsing
follows [SysMon](https://github.com/rafiki270/SysMon)'s native sources.

Provider HTTP reads have an eight-second deadline, a 256 KiB body bound and no
redirects. Kimi uses the pinned public transport; SysMon admits only its literal
loopback endpoint. Local credential/metadata reads have explicit size bounds.

The local GitHub CLI reports at most 30 open authored pull requests with failing
checks, using its existing sign-in. Incomplete/malformed searches never mean all
checks passed. Account and CI probes run at most once per minute while viewed;
transient failures retain the last valid values marked unavailable/stale. CI
summaries are pairing-owner only, just like provider quotas, because private
repository names and titles must not leak through ordinary computer access.
Deploy the updated API before collectors that send these additive signed fields.

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
A provider discovery failure leaves its batch incomplete, preserving previously
reported work until a successful inventory reconciles it.

On viewer demand, the executor projects at most 200 recent messages from a bounded
native transcript tail, including text, reasoning summaries and tool calls/results.
It confines files to the discovered provider history root, checks native IDs and
ownership where supported, and handles Windows long-path prefixes without widening
that root. Transcripts pass through the existing secret/path projection. Managed
history reads the projected log independently; it never advances the agent cursor
or starts a host. Native history remains on the computer. Conversation writers explicitly negotiate conversationVersion=1 before the API
offers human actions; older strict relays keep the original requests-only response.
Browser conversation reads opt in with view?conversation=1 and include the
receiving executor label; original view reads retain their strict screen-only
contract. Deploy the API before new executor packages.
The API holds encrypted
conversation snapshots for the existing 30-second viewer-demand lifetime.

Only the verified built-in bridge's daemon-only session_conversation response has
a separate 1 MiB transport budget. Ordinary MCP command results retain their
existing maximum and command-journal contract.

## Human input

The paired owner can send to a managed coding session, request an interrupt, or
answer what the session waits on — an approval, a question or a secret — as
[live coding sessions](live-coding-sessions.md) describes.
Native Codex supports Queue only when its experimental queue is advertised.
Native Claude supports Push only with the existing explicitly enabled channel.
Saved history without an active input capability remains readable. No operation
silently resumes or takes ownership of the original client. Shared viewers receive
no control authority. Raw terminal viewing remains read-only.

The server admits input inside the selected team against fresh session capabilities,
captures stable human-authority references, encrypts pending text and rechecks live
standing before dispatch. Requests expire after 60 seconds. UUIDs bind the same
request across network retries; local delivery journals prevent duplicate provider
writes and preserve unknown outcomes without replaying them. An unexpected
exception after native dispatch stays unknown; only definite refusals report
failure. Expiry without confirmation is not proof of non-delivery. The API clears text
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
