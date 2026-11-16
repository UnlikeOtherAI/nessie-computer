# Windows admission recovery

Windows job and ConPTY launches retain their existing process containment and
input authority. They no longer acquire a machine-wide host-execution lease.
The program/ChatGPT exclusion policy was retired on 11 November 2026
(`SECURITY.md`); its Windows native acquisition path had remained active.

The old release reconciled each host lease against every lease on the same
daemon and the daemon's complete Job Object. On Maxis, 1,316 retained leases
shared one daemon with a persistent Codex app-server. Even completed controllers
could not clear. Repeating that work under the global admission mutex queued
native helpers and suspended runtimes until Add another team timed out.

## Recovery and retained evidence

The service admits a signed caller and reads the protected custody journal
under its existing admission locks. It identifies ended legacy controller
generations through `custody_observation::absent`. It does not require that
unrelated programs in the same daemon job have stopped. Live controllers stay
in the active journal.

Before removing any ended entries, `Store::retire_hosts` writes their original
records under `custody/retired-host-admissions/<sha256>.json`. It flushes a draft
and atomically publishes the archive. Only then may normal journal persistence
remove those active entries. A crash before journal persistence repeats the
same content-addressed archive; a partial draft is safely rewritten. An
unreadable or conflicting archive refuses retirement and preserves active
evidence. No pairing, credential, runtime-creation or execution-authority record
is removed by this migration.

The obsolete native `managed-host-check` and `managed-host-barrier` commands and
service HostCheck/HostAcquire/HostRelease operations are removed. No current
JavaScript consumer uses them. New job and terminal launches cannot recreate
the backlog. Update clearance still independently checks all retained runtime
jobs and any live legacy controllers before replacing a release.

## Verification

Run Windows common, service and native Rust tests on Windows, serially within
each test process (`cargo test --locked --manifest-path <crate>/Cargo.toml --
--test-threads=1`). The service regression reproduces 1,316 ended leases while
the daemon and an unknown child remain alive; it keeps a live controller and
a revoked credential fence. Store tests cover archival, replay after a crash
before journal persistence and archive failure without lost evidence.

Installed qualification must use the signed package, the actual Add another
team entry point, an existing team's Access/Documents/AI checks, and a real
agent-to-provider session. Compilation and fixture results alone do not prove
that installed journey. Record the exact signed revision and observed results.

## Windows state checks during a finite session call

A signed session-authority consumption remains bounded to five seconds. The
state reader still verifies the directory and the individual file before every
read, both before and after the owning-route exchange. Windows runs these checks
over one finite native helper's private stdio pipe instead of starting another process
for each check. The helper rereads the actual DACL and owner every time. It
retains no permission verdict, credential or session authority.

The channel accepts only the four existing state-security operations. Frames
are bounded and replies are correlated to one pending request. Malformed
replies, process loss and deadlines refuse the check; an interrupted operation
is never replayed. The check scope closes the helper and observes its exit before returning to a native launch or custody check. It also exits on parent pipe closure.
Independent checks use independent helpers; no idle process survives between operations.

On the installed Minis 1.1.2 baseline, four separate ACL checks took 6.06 seconds
in one of three bounded samples, before any network time. Running the two
checks concurrently still took 5.91 seconds in one sample. These measurements
explain why merely changing query ordering cannot qualify the session path.
The replacement transport requires real Windows ACL-change regressions and
new signed installed CTO verification; source tests alone do not complete it.


Focused source qualification on Maxis passed eight native ACL/parser tests and
19 Turbo tasks: build, lint, typecheck, 84 Windows tests (seven platform skips),
and all 44 authority tests. The Windows tests broaden a file DACL after a
successful check, remove and recreate that file, exercise fragmented and invalid
replies, helper loss and timeout, and require the finite scope to exit before
the parent CLI finishes. Source helper probes on Minis took 29, 32 and 830 ms
for four checks in one child. These are source timings, not signed installed
acceptance; the real CTO start and same-session follow-up remain required.


## One active local connection per team

Code pairing previously inspected only its newly allocated directory, so a new
key could activate another local connection to a team already present elsewhere.
Activation now holds one account-wide lock and checks existing connections
through signed connection reads before publishing local state. The exact server,
organisation ID and team ID decide a match; names, offline status and display
caches never do. Failure to read an existing connection does not permit a new one.

When a match exists, the runtime cancels only the redundant attempt through the
normal signed pairing endpoint. It returns `alreadyPaired` with the existing
connection ID. Native hosts do not promote another directory, restart a paused
connection, replace keys or merge permissions. The shared console selects that
team and says it is already connected. A lost cancellation response is recovered
by the normal poll, which sees the rejected attempt and closes the dialog without
publishing a connection.

Windows service pairing supplies its fixed `executors` root with the internal
`--connections-root` argument; user pairing discovers the same local roots as
the existing team list. The separate service-owned ChatGPT plan connection is
still a distinct custody compartment linked to its user-owned team. Existing
duplicates and their historical commands are not silently deleted or merged.

Run `test:executor-pairing` and the affected CLI discovery checks through the
public Turbo graph. The duplicate gate uses isolated real state directories and
signed protocol requests, including simultaneous activation, unchanged grants,
equal names across different IDs/servers, lost cancellation and lookup refusal.
Installed Add another team verification remains required before qualification.

Source qualification on Maxis passed all 19 selected Turbo tasks: build, lint,
typecheck, 27 pairing tests (two existing Windows platform skips) and all 45 CLI
tests. All 17 focused Windows service pairing tests and 18 rendered shared-console
journeys passed, including duplicate selection and cancellation recovery. The
console gate loads the existing retained-import assets and keeps its separate
Settings heading outside the general-settings heading assertion. Console and
fixture lint also passed. These source gates do not claim installed acceptance.

## Session request handoff

The installed Minis 1.1.3 candidate created session
`7398e2bf-ae11-452a-8b9d-dc47e29873ea` through the real CTO conversation, but
the host stopped before producing a screen. Its queued scope expired at
09:41:00.956 UTC; the host first wrote state at 09:41:02.903 UTC. The bridge
had refreshed its own permission while preparing the host, but the queue still
contained an earlier five-second permission.

The owning route already returns two different deadlines: an exact operation
reference, bounded to 30 seconds for commands, and an execution permit bounded
to five seconds. The client now retains both values from that verified response.
Execution, provider transport and result publication still use the short permit.
Only the immutable queued request retains the route-issued reference. The host
must present that unexpired reference to the signed owning route and pass current
pairing, actor, command and revocation checks before obtaining its own short
permit. Neither deadline is extended locally. T3 grants are unchanged.

A parent whose permit expired cannot publish another request. A carrier that
expired cannot be renewed, and a revoked or substituted carrier cannot authorize
an effect. Existing queue bytes, command identities, accepted results and withheld
outputs are never rewritten by this repair. Older expired requests remain
evidence; they do not become instructions to replay.

The `test:executor-private-assignments` Turbo gate includes the real state-file
and request-queue regression in `test/session-carrier.test.ts`. It advances time
past the parent's permit, consumes the original route-issued reference in the
host, and checks expiry, revocation, substitution and immutable request bytes.
On Windows the gate uses the fixed Debug helper for real owner-only ACL checks.
Those source checks do not replace a new signed installed CTO response and
same-session follow-up.
