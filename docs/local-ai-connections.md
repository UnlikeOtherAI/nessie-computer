# Local AI connections

The shared Windows/macOS console owns AI connections in the **AI** tab, which
follows the team dropdown (see [the team tabs](nessie-computer-team-tabs.md)).
Saved connections belong to that computer and selected team.

## Claude Code and Codex on this computer

**On this computer** sits above ChatGPT plans. It lists Claude Code and Codex
with the account each is signed in to, and a **Make available** switch per
team. The wire contract, accounts, sessions and verification are in
[Claude Code and Codex as engines](local-cli-engines.md).

## ChatGPT plans

Use **Add a ChatGPT plan** for each plan, yours or your company's; the name is
prefilled "ChatGPT plan N" and editable, and **Sign in with ChatGPT** completes
the provider's own sign-in. Each plan has a stable profile ID, independent
sign-in, sign-out and background-work consent. **Manage** opens that plan;
**Save name** changes only its local display label. Adding a plan does not
resume another account or inherit another profile's provider registration.
New profiles use the public Codex personal-agent OAuth client, the same
`/oauth/authorize` and `/oauth/token` contract used by OpenClaw, with fresh
PKCE and a loopback callback at `http://localhost:1455/auth/callback`. The
computer opens the browser and owns token exchange, refresh and the selected
ChatGPT account header. It calls `chatgpt.com/backend-api/codex` directly.
There is no Codex installation prerequisite and no import of another app’s
grant. Existing SIWC registrations retain their own exact local mapping.

The server may be hosted, self-hosted or local. It schedules work and receives
inference over the existing authenticated host WebSocket, never provider
credentials. Native credential custody and per-plan funding rules still apply:
a plan funds the owner’s own agents. The Mac inventory proves Nessie Computer’s
managed processes and installation; unrelated Node programs or a separate
Nessie Desktop UI do not fail that inventory. Other owner-run applications
remain inside the ordinary OS-account trust boundary.

The dialog shows blocked sign-in and failed checks as red alerts. A failed
check keeps the name you typed and disables sign-in until **Check again**
succeeds. A successful status read does not itself grant provider access.
Server deployment restrictions, owner authority, local runtime protection and
OpenAI sign-in failures have separate messages; none falls back to team credits.
Local scope resolution failures also return these public reasons instead of
escaping the CLI before its first status frame.

## Local and network model servers

Use **Add a model server**, enter a name and API address, and choose **On this
computer** or **On my local network**. OpenAI-compatible APIs expose their
models through the server address, normally ending in /v1. The remote server
needs no executor: this connected computer sends requests to it. The server
must listen on an address this computer can reach. Local Ollama discovery is
retained; LAN servers use their OpenAI-compatible API.

Up to 32 named endpoints can be saved. Each reports its own availability and
models. A server going offline does not hide the others. Model identities are
scoped to their endpoint, so equal model names cannot cross-route. Removing an
endpoint or changing its address invalidates its selected models; requests do
not fall back to a different server. Existing singleton configuration and
automatic Ollama discovery survive the first added endpoint. Explicitly removing
all endpoints leaves an empty collection.

API keys are optional. An empty key field preserves the saved key only at the
same address; **Remove saved API key** clears it. Changing the address clears
the old key. Saved keys never return to the renderer. Save failures keep the
form's edits and offer a retry. Endpoint writes and credential preservation use
one owner-only state lock.

LAN requests resolve DNS for every request, reject public, link-local and mixed
public/private answers, pin the actual socket address, and refuse redirects.
Accepted addresses are loopback, RFC1918 IPv4 and IPv6 unique-local addresses.
Credentials travel through bounded stdin, never command arguments. Native
bridges select the connection's state path; the renderer cannot supply one.
The Windows service verifies the requesting SID owns that pairing.

## Names and selection

Team names come from each team's saved, display-only label
([team names](team-names.md)), which every `executor_view` row carries; reading
them asks nobody and depends on no person's login. Labels are not selectable;
text inputs and copyable pairing codes remain selectable.

## Verification

Claude Code and Codex have their own gate, `//#test:cli-engines`, and journey
(`ai-local-renderer.mjs`, run by `--only=ai`). Run the public Turbo task `//#test:ai-connections` with
`--root-turbo-json=scripts/turbo.public.json --concurrency=2`. On Windows, first
build `native/Cargo.toml`; the repository runner puts an unmarked Node beside
the Debug ACL helper. This verifies file protection without claiming installed
credential authority. The local headless journey is
`node tray-windows/test/renderer-harness.mjs --only=ai`, against the real console page.
Run `pnpm exec turbo run test:chatgpt-connection
--root-turbo-json=scripts/turbo.public.json --concurrency=2` for the OAuth
loopback, registration and public-failure contract (no installed native authority).
The focused `--only=chatgpt` journey covers named starts, all public refusal
messages, failed checks and recovery in seven locales at both native window sizes.

Revision c9f4016 passed build, lint, typecheck and all 42 focused tests on Maxis,
with no skips. Shared AI/ChatGPT journeys passed in seven locales at 390/1280 px
for both native-host fixtures, including failed save and retry. Windows common
tests passed (39); service/tray checks and the native helper build passed.
On dictator, SwiftLint and the Xcode app/unit-test build passed. Real Strata
discovery at Maxis loopback returned qwen3.8-flash-next-gsq-rco-iq3_s; its LAN
address was unreachable in that check.

Signed installed OAuth acceptance and the live subscription-funded agent task
are still pending. Browser fixtures and source compilation do not prove them.
