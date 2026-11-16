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
caches never do. A read nobody answered (a network failure, a server error, a
rate limit) does not permit a new connection; the next status check asks again.

A connection that can no longer be the team being added never holds a new one
back. That covers a connection Nessie refuses outright on its own signed read —
revoked, unknown to that server, or in a team that no longer exists — and a
folder whose settings cannot be read, which can neither run a team nor prove one.
One dead connection on a computer used to stop every later pairing there.

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

## Windows npm program discovery

Coding-session startup, CLI probes and help-cache identity share one launch
resolver. It searches only absolute PATH entries in PATHEXT order, considering
native executables and npm command forwarders. The fixed npm forwarding format
is read as data: a native target runs directly; a JavaScript target runs through
the adjacent Node executable or Node from the same absolute PATH search. The
session folder never supplies either executable. Arguments remain a literal
vector, including spaces, quotes and shell metacharacters. No command interpreter,
new sign-in, permission screen or configuration step is added.

Custom batch/PowerShell programs and modified forwarding scripts are refused.
Existing command admission, immutable request authority and native Job Object
containment still apply to the resolved executable. Resolution does not grant
provider access or change the provider's own login.

Run the public Turbo task `test:windows-npm-launch`. On Maxis, its real Windows
session fixture covers an npm-only installation, a hostile same-name executable
in the session folder, first output, same-session follow-up, literal arguments,
close and descendant termination. Native-forwarder probes and malformed shims
are covered too. These source checks do not establish installed CTO/provider
acceptance; that remains a separate signed-candidate journey.

## Lifecycle ownership and interrupted pairing

The daemon, pairing-operation and root-wide pairing-activation locks share the
existing atomic generation-lock implementation with personal admission. A fully
written, secured draft is linked into place atomically. Recovery serializes on
the observed ownership token and rechecks file identity; releasing an old owner
cannot erase a replacement. Status uses the same generation decision as acquisition.
PID reuse, a different recorded kernel boot and positive process absence recover
without signalling the process currently using that PID. Unknown identity stays
unknown. An interrupted publication leaves no empty canonical claim.

Disconnecting a team removes its folder while the disconnect still holds that
folder's daemon lock. Releasing a lifecycle lock whose claim file is already
gone therefore succeeds; a claim that somebody else replaced is still refused.
Without this, a completed disconnect ended with `owner_process_admission_fenced`.

### Settings updates interrupted by an upgrade

A team's settings are saved under `executor-state-mutation.lock`. That lock was
a bare exclusively-created file holding a process number, and nothing ever
cleared it: a save cut short by a crash, a restart or the installer left the
team refusing every later save, and its daemon refusing to start, with "This
team's settings are already being updated". Upgrading Maxis from 1.1.1 did
exactly this to one of its three teams.

The settings lock now uses the same generation lock as the lifecycle files. The
next update takes over a lock whose holder has gone. A lock in the old format is
also given up once it is ten minutes old, because a save takes moments and its
process number may since belong to another program. A lock that cannot be read
still refuses the update. `test/state-mutation-lock.test.ts` covers an
interrupted update, a running one and a reused process number.

Legacy PID-only lifecycle records contain no birth. On Windows a bounded,
read-only kernel/WMI check can additionally prove that the PID now belongs to a
different OS principal than the owner-only state. It checks the process birth
before and after reading ownership, and against an observed birth when available.
It neither guesses from executable names nor signals the process. A same-account
or unreadable legacy owner remains unknown. This migration check applies only to
the three lifecycle files; it does not authorize or alter personal custody.

Cancellation persists its intent and original key before transport. The closed
dialog's normal background checks and startup restore retry until the server
acknowledges that attempt. Confirmed claims cannot activate while cancellation
is pending. The server's rejected tombstone also fences a late mint.

Duplicate activation compares fresh signed server/org/team identities. A signed
refusal (410 inactive, or any other answer that is not a timeout or rate limit)
skips that history without deleting it. Reuse proves both
local keys to the server, retires only the redundant claim and returns a durable
retained-connection outcome to both surfaces. A lost response recovers by polling;
the native client checks the retained local connection before clearing its key.
Accepted source authority, retained keys, grants and withheld outputs do not change.

The public Turbo tasks test:process-lease-recovery and test:executor-pairing cover
competing reclaimers, crash boundaries, unknown legacy owners, different-principal
recovery, duplicate reuse and durable cancellation after restart. The local console
renderer checks closed-dialog retries on both host renderers. These gates do not
replace signed installed qualification against the matching server protocol.

## Native lifecycle readers

The Windows app and service read the same versioned generation records as the
CLI. Their read-only preflight compares the kernel birth and boot identity;
a reused PID cannot hold a departed daemon's connection indefinitely. Missing
files permit a start, while unreadable, malformed and uninspectable records
remain busy. The CLI still owns atomic acquisition and final disconnection.

A legacy PID-only record can be excluded when the held file belongs to the
calling account and the retained process handle proves a different token SID.
Group-owned files and unreadable token identity remain unknown. The observer
requests query rights only and never signals the process, removes a lease or
changes execution authority. Its real Windows regression keeps the replacement
process alive through the stale-generation check and verifies normal recovery
after the fixture process exits.

Installed Minis 1.1.5 exposed this missing native reader: the repaired CLI and
the Windows app disagreed about the old duplicate's reused PID. A read-only
source observer now distinguishes that preserved stale record from the current
live connection. That observation does not replace a signed installed recovery
check; the original duplicate and its history remain available for that check.
### Legacy locks during Windows upgrades

A normal Windows account cannot inspect every SYSTEM process token. A legacy
PID-only file can therefore remain unknown after Windows reuses that PID.
Unknown identity still blocks ordinary acquisition; access denied is never
treated as proof that a process has ended.

The deferred SYSTEM installer completion resolves that historical case. After
old processes drain, it reads active Windows login tokens through WTS and checks
each token owner against the corresponding session owner. The profile comes from
that token, never a request, environment variable or journal. It examines only daemon.pid,
pairing-operation.pid and the root pairing-activation.pid in that profile's
normal state layout. It retires a legacy file only when its held file owner
matches that login account and the process is positively absent or belongs to a
different principal. Unknown, same-owner, malformed and versioned records stay.

The file handle denies writes and deletion throughout inspection. Retirement
marks that exact handle for deletion, so a competing reclaimer cannot substitute
a newly acquired lock between comparison and removal. Reparse points are
refused. This adds no control endpoint, prompt or privilege to the running app.
Pairing keys, grants, session history, command receipts and custody are untouched.
Only active Windows login profiles are inspected. Completion runs before reading
the optional service-owned app-reopen journal: a manual MSI cannot write that
journal from its immediate close action, but still performs privileged recovery.
The MSI sequence and existing manual-app-reopen behavior are unchanged.

Maxis tests cover competing replacement, held writers, reparse points, foreign
file owners, unknown/same-owner processes, modern/malformed records and real
process exit. Signed installed upgrade qualification remains separate.

The installer pins every directory from the volume root through the observed
profile and selected connection before opening a legacy lock. Directory handles
deny writes and replacement, and reparse points are rejected. This keeps an
otherwise valid file-owner check from following a path swapped after inspection.
Two additional Windows regressions prove directory replacement is blocked while
held and a directory link is refused before any claim is opened.


The deferred-completion profile reader passed a read-only SYSTEM test on Maxis
and Minis, each resolving the active login without modifying files. Maxis passed
131 common, 104 service and 80 tray tests, plus 25 MSI authoring checks.
The SYSTEM test is opt-in and was run explicitly on both machines; one unrelated
installed-only common test remains outside this check. Signed MSI qualification
of the stale lock itself is still required.
