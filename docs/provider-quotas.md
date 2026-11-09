# Provider quota sources

Collection runs only on viewer demand, at most once a minute, independently of
host sampling. No probe sends an inference turn. Credentials remain on the
computer; only derived facts, opaque grouping keys, allowances and reset times
travel. These readings are pairing-owner only.

The audit uses [T3 Code commit 25bf84ab](https://github.com/pingdotgg/t3code/tree/25bf84ab07f53f141c20239c63e383823a9d5ea0).
These are its standalone quota readers, plus the requested SysMon sources:

| Account | Local source | Read protocol |
| --- | --- | --- |
| Claude Code | Installed CLI and `CLAUDE_CONFIG_DIR` | Stream-JSON `initialize` and `get_usage` with `skip_behaviors`. Keep session, weekly, model and spend windows separate. CLI metadata supplies workspace identity. |
| Codex | Installed CLI and `CODEX_HOME` | Signed in when `codex login status` exits 0; app-server `account/read` only names the account, because it can answer `account: null` while signed in. Then `account/rateLimits/read`. Use the main Codex bucket, actual window lengths, `accountId` workspace and optional `rateLimitResetCredits`. |
| Cursor | `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` | API-key exchange, optional `/v1/me`, then `DashboardService/GetCurrentPeriodUsage`. Reported percentages include bonus usage. Cursor Models and Other Models remain separate; Overall is not a third allowance. |
| Antigravity | `GEMINI_HOME/antigravity-acp/acp_token.json`, default `~/.gemini`, and existing T3 profiles under `~/.t3/userdata/providers/antigravity/` | Refresh access in memory through Google OAuth; Google userinfo supplies cross-machine identity. Merge daily and normal Cloud Code quota summaries, keeping the stricter bucket. Older accounts use reported model quotas without invented cadence. |
| OpenCode Go | Selected OpenCode 2 Console credential in SQLite, then `opencode-go` in `auth.json`, then `OPENCODE_API_KEY` | GET `https://opencode.ai/zen/go/v1/usage`. Keep rolling, weekly and monthly windows. A valid Zen key without Go is unsupported, not an invented Go subscription. |
| Grok Build | Native `.grok/auth.json` default xAI realm; `GROK_HOME` and `GROK_AUTH` honoured | GET `https://cli-chat-proxy.grok.com/v1/billing?format=credits`. An omitted zero means unused only with a complete, valid subscription period, as T3's reader requires. |
| Kimi | Existing `.kimi-code`/`.kimi` OAuth credential or official API key | GET `https://api.kimi.com/coding/v1/usages`. Native weekly usage is authoritative; conflicting legacy short limits use the stricter reading. The CLI owns refresh. |
| Grok website | Existing local SysMon browser sign-in | Authenticated `get_accounts({vendor: 'Grok'})` at literal loopback `127.0.0.1:7738/mcp`. Import only derived windows; never browser cookies or profiles. |

Grok website and Grok Build are different allowances. Google IDs and Cursor
subjects are hashed for grouping and grant no Nessie authority. OpenCode Go uses
an opaque key fingerprint when identity is absent. Known workspaces stay separate;
unknown accounts never merge by plan or percentages.

T3's Pi integration reads auth/model availability and history, not a standalone
remaining-quota account. Muse observes `usage/changed` during a live MSP session
for retry timing; it does not publish a standalone quota account. These do not
become fabricated subscription cards. Token history and estimated cost remain
distinct from remaining allowances.

## Sign-ins and configuration

The normal CLI environment supplies credentials. There is no new sign-in surface
or extraction from T3's protected secret-provider bindings or Cursor's desktop
browser profile. Configure the same Cursor API key or token locally when another
application owns it. Custom Cursor endpoints, custom Grok auth and remote
OpenCode servers never borrow the default account. Unreadable Grok selection
configuration fails closed.

Antigravity honours `T3CODE_HOME` and optional `ANTIGRAVITY_PROFILE_DIRS`, a
comma-separated list of absolute or `~/` profile paths replacing discovery.
Non-OAuth `ANTIGRAVITY_AUTH_METHOD` values do not reuse old Google logins. Refresh
tokens are never rewritten. Access tokens remain in memory for at most an hour;
deleting or changing the credential file retires cached access.
An access-token rejection invalidates that cached token so the next requested
probe can refresh it, retaining an already established Google account identity.

OpenCode respects `XDG_DATA_HOME`, `OPENCODE_DB` and `OPENCODE_AUTH_CONTENT`.
Inline auth overrides stored Console credentials. SQLite opens read-only and
selects the active row before decoding, never falling through an OAuth or custom
Console row to another stored account.

Claude reset-credit counts use T3's read-only `cedar_ember=1&skip_spend=1` request
on Windows/Linux and the actual installed CLI version. macOS does not scrape the
Keychain. Explicit auth overrides never borrow file-account credits. No collector
redeems a credit or calls a consumption URL.

## CLIProxyAPI pools and bounds

Read T3's Claude/Codex pools through `NESSIE_CLIPROXY_URL` and
`NESSIE_CLIPROXY_MANAGEMENT_KEY`, or a private `NESSIE_CLIPROXY_SOURCES_FILE` JSON
array of `{url, managementKey, enabled?}` entries outside the checkout. This is a
machine-only configuration interface; readings use the existing quota sidebar.

The collector reads `v0/management/auth-files` and only the fixed read-only
Claude/Codex usage and reset-credit URLs through `api-call`. The hub substitutes
its token, which never reaches Nessie. Exclude disabled/unsupported accounts and
read four at a time. HTTPS uses pinned public transport; explicit HTTP loopback
uses literal `127.0.0.1`. Refuse redirects. Transient failures retain derived
readings for up to 15 minutes; 401/403 clears allowance windows.

Responses are capped at 256 KiB with eight-second transport deadlines.
Antigravity and each proxy pool carry a 30-second deadline. Admit at most 16
Antigravity profiles, eight pools, 128 rows per pool and 64 accounts per snapshot.
Source failures or omitted accounts set owner-only `subscriptionsIncomplete`.
One failed provider cannot hide another's readings or expose diagnostic bodies.

Run public Turbo `//#test:computer-data` on Node 22 for projections, real read-only
SQLite, selection precedence, cross-profile identity, cache retirement, malformed
data, credit eligibility and transport bounds. Report live sign-in availability
separately; fixture passes do not establish live provider access.
