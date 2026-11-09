# macOS updates with the existing Developer ID identity

Status: implementation in progress. No installed upgrade is claimed.

The distribution identity is the existing `Developer ID Application:
UnlikeOtherAI s.r.o. (23B7GTLBN7)`. Its certificate is on the Mac Desktop and its
private key is already in the login keychain. The signed 0.9.0 app and DMG have
already passed notarization and Gatekeeper with this identity. No new Apple
account, publisher or certificate is needed for that distribution format.

The updater uses the notarized DMG and an app-bundled native LaunchDaemon
registered through `SMAppService`. It needs no Developer ID Installer identity.
Apple documents the [bundle-relative helper layout and approval
model](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos).
An administrator must approve the background helper once in System Settings;
its status and the route to approval belong in the local Settings page.

## Trust and installation

The helper is the existing native executable, signed inside the app. Its plist
lives in `Contents/Library/LaunchDaemons` and uses a fixed `BundleProgram` and
fixed command. It accepts no caller-selected path, URL, executable or command.
Registration never grants Node or a web page Root execution.

On its first approved launch the helper validates its own loaded publisher,
the enclosing app's sealed compatibility floor, and the bundled runtime's
hashes, numeric version and compiled source revision. It copies that runtime
into a Root-owned staging directory, verifies the readonly copied contents,
then atomically selects the immutable release. It preserves the existing
custody inode and journals. Initial migration still waits for legacy creators
and work to finish naturally; it never signals a process to obtain clearance.
The copied app is read by an unprivileged process inside a private directory,
then frozen and verified. A verified snapshot is reused for retries rather than
copying the same app on each restart.

The registered job then executes the protected native broker image. Existing
accepted workers, durable retry state and the socket contract remain unchanged.
A later app launch must resume the protected installed factory; it must not
replace that factory from an older bundled runtime or reset removal intent.

## Replacement

The signed catalogue names an immutable DMG asset with its size and SHA-256.
The native adapter verifies the DMG's publisher and Gatekeeper result before
mounting it readonly at a protected location. It stages and validates the app
and its bundled runtime against the accepted version/source, then uses the
existing machine barrier, drain and independent clearance proof for replacement.
No shell or arbitrary installer script runs as Root.

The app and CLI factory switch in one journaled transaction. A macOS atomic
directory exchange preserves the app's registered helper throughout replacement;
the old app and runtime remain available for recovery. Partial replacement
keeps admissions fenced and retries the accepted bytes. Completion requires the
new runtime generation and the appropriate application restart proof. A nested
menu app inside Nessie Desktop remains part of that signed parent bundle; it
must reopen as an independent consumer of the new installed runtime without
requiring its unchanged bundle to carry the runtime's new source revision.

All existing publisher, manifest, Root ownership, process-generation and
credential-custody checks remain mandatory. Homebrew-owned installations retain
their package-manager ownership. First setup, denial/recovery, active work,
opt-out, reboot and signed A-to-B replacement still require installed testing
on the Mac before publication.

The public release also supplies the actual Mac and Windows URLs used by
Nessie's Computers page. Its existing download buttons must not be enabled
before those public immutable assets exist and their anonymous downloads verify.

At `e511bf8`, 42 Mac helper tests and 17 updater tests passed. App/Core typechecking
and strict Swift lint passed at `3bbadc4`; 31 focused update tests and the public
TypeScript gate passed on Maxis. The setup, denial and retry controls passed
18 headless shared-console journeys. These source checks do not establish an
approved installed helper or a completed signed upgrade.

The `e511bf8` 0.9.0 DMG was signed, notarized, stapled and accepted by Gatekeeper
on the Mac. SHA-256:
`efb1d4c683bd8338f5c064101d90271673e5786c536d293f7206a50f347c0e71`.
The same verified app was installed in `/Applications`, with the previous app
retained outside the checkout. Its compiled `build-info` reports version 0.9.0
and source `e511bf86d9f0c3ffccbd7fd67e9ade1ee0579e4e`. The real local Settings
rendered setup and its button opened macOS background-helper approval. This
does not yet establish an approved Root helper or an A-to-B upgrade.

The registration fix at `c79eac7` passed Core tests, strict Swift lint and the
full App/Core typecheck. Its new signed and notarized 0.9.0 app is installed;
macOS's administrator approval is recorded and its Root job starts. The first
protected copy exposed a `ditto` destination-resolution failure. A private-cwd
archive-copy probe preserved the signed app and passed Gatekeeper; the native
replacement still requires a signed installed retry. No protected factory or
completed upgrade is claimed yet. Existing failed snapshots and journals remain.

The same revision's 0.9.0 Windows MSI was built and signed on Maxis. It passed
publisher, profile EKU, timestamp, SignTool and updater-protocol inspection;
SHA-256 `fbe63a66d41b90866d0e0dff9d11091e8dadaff6cb2dcc8570e5cee6e71f10d4`.
It remains uninstalled and unpublished. Matching setup screenshots cover the
actual base `54c6175`, two console widths and all seven supported locales, with
denial/retry journeys. Their broker responses are fixtures, not installed proof.

The signed `879a601` app was subsequently installed by atomic exchange, using
the existing approval. Its Root service stays running after snapshot creation
and validation, with public maintenance state draining and no selected factory.
It is waiting for older Nessie/CTO processes. Those processes and their journals
remain intact pending coordinated shutdown; this is not a completed migration.
The DMG SHA-256 is
`0c1632af196b026d882164d49d612b125d9cf0d64c678495684c4def3dd39bac`.

With explicit permission, the legacy CTO service was stopped through launchd
and Nessie Desktop through its Quit action. The CTO job's automatic relaunch is
disabled; its configuration and state are retained. The helper then selected
release `906495a8666c565113599a225c82bc4423ff92067c83cbb8264cf37b85db6a93`.
Its compiled build information reports 0.9.0 at `879a601`, the protected broker
and worker run, and maintenance has returned to non-draining. Status RPCs still
time out, including a 25-second authenticated-peer diagnostic. Preserve this
live failure while debugging; do not restart the service or clear its journals
to hide it. No completed update or working Settings control is claimed.

Read-only live sampling isolated the delay to repeated payload hashing and
signature validation on the broker's listener and ordinary status path. Three
subsequent status requests returned the correct protected version and policy
after 5.0–6.3 seconds, beyond the native client's five-second deadline. Worker
supervision now runs separately from socket acceptance. Status retains one
fully verified release for version and eligibility together; irrelevant health
and application-restart observations are rejected before payload verification.
No verification result is cached across requests or used to authorize creation.
Installed timing and recovery still need verification with the signed fix.

Managed CLI creation now binds its release to the kernel's loaded native image,
not the mutable `current` launch alias. The Mac regression test launches the
test executable through a symlink and confirms the same kernel image is used.

Ordinary-user process snapshots read every process's short kernel record, which
macOS allows across users, and take the full record only for the user's own
processes and Root processes named like Node or Nessie. The full record is
refused (EPERM) for Root daemons such as launchd, so the earlier snapshot failed
on every Mac with `EXECUTOR_MACOS_PROCESS_UNVERIFIED` and no managed runtime
could start. A user process whose image was replaced on disk stays in the tree
with no executable path unless its name is a product name, which still refuses.

## Recovering a stuck helper

On 8 November the Mac's helper had run since 6 November with maintenance state
`{"draining":true,"restartReady":false,"target":null}`. Its accepted preview
1.0.13 transaction (superseding 1.0.12 at 13:46) sat in `waiting`. The installed
0.9.0 runtime (`879a601`) refused every launch with
`EXECUTOR_MANAGED_RELEASE_REJECTED`: its `load()` resolved the `current` launch
symlink as the release directory, which the immutability check rejects (fixed
later by binding the kernel image). Installing 1.0.13 needed whole-machine
clearance with the menu app gone. The app quits only through the handoff it
starts when status says `waiting` and draining, but the 0.9.0 broker took 11.8
seconds to answer status, past the 5-second native and 10-second app deadlines.
The handoff never started, the drain never ended and no team could start.
launchd's 178 runs and last exit 1 date from the 6 November snapshot failures;
the running service had not restarted since. Replacing the app with 1.0.12 and
1.0.15 did not restart it: launchd keeps the registered job until it exits, and
the job hands over to the protected worker image of the installed runtime.

Recovery now works from both ends without weakening a fence:

- **Bounded drain.** A `waiting` transaction holds new starts back for at most
  one hour (`updater/src/drain.rs`). Admissions then reopen for six hours and
  the same accepted transaction tries again. Replacement is offered only inside
  a window. `installing` and `restarting` keep the fence. The first drain time
  is kept in `updates/drain.json`, beside the journal, so older workers ignore it.
- **The app's own runtime.** Each time launchd starts the helper, its
  app-bundled entry compares the installed runtime with the compiled app version
  (`native/src/updates/macos_recovery.rs`). When the app is newer and no
  replacement has started, it installs the app's runtime exactly as first setup
  does: verified sealed snapshot, machine barrier, independent clearance with
  the menu app allowed to stay, legacy retirement, then `current`. A
  `downloading` or `waiting` transaction the new runtime meets is archived in
  `updates/retired/<digest>.json` with its failure code and request, its staged
  bytes stay, and the drain ends. An older worker still running then refuses the
  downgrade, finds no transaction and exits; the new service starts a worker
  from the new runtime. While admissions are already held for nothing newer
  than the app, the entry keeps trying every three seconds. Otherwise it tries
  for about a minute and hands over to the installed worker as before.
- **The app restarts its helper.** A newer app unregisters and registers its
  daemon once per app version when status shows an older installed runtime or
  fails two probes in a row. The person's **Restart updates** does the same on
  request and opens Login Items if macOS asks for approval again.
- **Plain words.** While the helper can't be reached or refuses, the app reports
  the local status `update.helper_unavailable`. The window's Needs you strip
  and the menu say "Updates are stuck — teams can't start" instead of "No team
  connected", with Restart updates as the one action.
- **Approval is asked for, not called stuck.** While SMAppService reports the
  daemon `requiresApproval`, or after this app re-registered it and it has failed
  two probes since (8 November, 1.0.16: no helper job ran for ten minutes after
  the automatic re-register), the app reports `update.approval_required`
  instead. The menu's Needs you line ("Needs you: allow Nessie Computer in
  System Settings to finish updating") opens Login Items itself; Overview's
  Needs you strip and Settings say "Allow Nessie Computer in System Settings to
  finish updating" with **Open Login Items**, which calls
  `SMAppService.openSystemSettingsLoginItems()`. `ComputerUpdateRecovery.attention`
  decides between them. The journey
  `node tray-windows/test/renderer-harness.mjs --updates-stuck-only` asserts
  these states and the refused registration below in both places in seven
  locales.
- **A refused registration is said, not swallowed.** On 9 November (1.0.18)
  the automatic restart unregistered the helper and macOS refused the new
  `register()` with "Operation not permitted". The restart ignored the error,
  SMAppService then reported `notRegistered`, launchd ran no helper job, and
  the app had already spent its one automatic registration, so it never
  registered again. The menu said "No team connected" while a team, started by
  another process, was serving. Now every `register()` refusal goes to the
  unified log and is kept, with the app version and its attempt count, under
  `computer-update-helper-registration` in the app's defaults (display only).
  While SMAppService reports `notRegistered` or `notFound`, the app registers
  again by itself at most twice per app version (the restart's or first
  setup's attempt and one more, 15 seconds later), never in a loop. While the
  refusal holds, the app reports `update.registration_failed` with macOS's
  short reason; the window's Needs you strip and Settings say "Updates can't
  start: <reason>" with **Try again**, and the menu says "Needs you: updates
  can't start — <reason>". **Try again** registers again without limit and,
  if macOS still refuses, opens Login Items. `ComputerUpdateRegistration`
  and `ComputerUpdateRecovery.attention` decide this.
- **The restart waits for macOS to let go.** 1.0.19 still had no helper on
  9 November. Its launch registered (accepted), its restart unregistered and
  called `register()` 12 ms later, and smd logged "Job is not allowed to
  bootstrap": Login Items still listed the removed job as enabled, so macOS
  returned "Operation not permitted". The same refusal is in the log at 22:11,
  01:38 and 02:12; every register made once the record had settled was
  accepted. The restart now polls the status every 250 ms, for up to ten
  seconds, until macOS stops reporting the helper enabled, and only then
  registers.
- **Nothing waits for a click.** The two-attempt limit is gone. After each
  refused `register()` the app registers again by itself once
  `ComputerUpdateRegistration.retryDelay` has passed (15 seconds, doubling, at
  most 15 minutes), for as long as macOS refuses; an accepted registration
  resets it. The automatic helper restart is no longer once per app version:
  while the helper stays unreachable or reports an installed runtime older than
  the app, the app restarts it again after `ComputerUpdateRecovery.restartDelay`
  (15 minutes, doubling, at most four hours), recorded under
  `computer-update-helper-restarts`. **Try again** and **Restart updates** only
  hurry these.
- **Old entrypoints still hold the swap.** The app's runtime is installed only
  once clearance passes. Nessie Desktop (`nessie-desktop`; the allow list named
  a `Nessie` executable that never existed) may stay only when its sealed floor
  keys pass `require_independent_app`; otherwise clearance waits for it to quit
  instead of failing, so recovery keeps trying. A desktop build without the
  `NessieExecutor*` keys (0.1.1 has none), or a runtime someone started by hand
  outside custody, keeps the swap waiting; the helper tries again every three
  seconds while admissions are held, and the app's restarts give it further
  chances when they are not.
- **Creation journals end with their command.** Clearance needs no creation
  journal from this boot in `~/.nessie/personal-inference/managed-runtimes`.
  The macOS creator kept a command's journal, and exited refused, whenever the
  guard held any `host_execution` registration at all. On dictator a team's
  local apps had left 405 of them, most from the previous boot, so every
  five-second `describe` kept its journal (371 in half an hour), exited 1 after
  printing its answer, and the app never started the team or passed clearance
  again. A command now keeps its journal only for a host registration its own
  child made in this boot (`unresolved_host`, `native/src/managed_macos_runtime.rs`),
  and a registration made in a new boot drops the host and runtime
  registrations an earlier boot left (`PersonalInferenceGuard.register`).
  Each launch first drops this boot's journals a one-shot command would have
  dropped itself (`reconcile`): no long-lived activity, supervisor and child
  ended, nothing left in the child's process group, no host registration of
  its own. Journals the old rule kept therefore clear on the next launch, not
  only at the next restart; a daemon's journal and anything running stay.
  Update clearance (`ready_with`) does not wait for such journals either
  (`ended_one_shot`): the installed older creator keeps adding them until the
  swap installs the corrected one, so on dictator 1.0.22's helper could not
  clear for that swap. Clearance only skips them; it deletes nothing. The
  process-group check uses every account's processes (`live_groups`, from the
  short process record), not the caller's own, so a Root helper still sees a
  user's leftover descendant; a process it cannot read counts as running.
- **A refused team stays in the window.** The console's `executor_view` lists a
  paired team whose `describe` is refused under `unreadable-<folder>`, so the
  window never opens Add another team over a team that exists. It reads as
  working while its daemon runs and says why when stopped; it takes its
  executor id back on the next reading that succeeds.
- **A running team is never "No team connected".** A team whose `describe` is
  refused (here, by the stale installed runtime the missing helper could not
  replace) still counts when its daemon lease is held by a live process, and
  the menu says "Working for 1 team". A pairing that can't be read and isn't
  running reads "Not connected — open Nessie Computer". Neither depends on the
  helper's state.
- **Monotonic for the app too.** Catalogue replacement refuses to put an older
  app over a newer hand-installed one (`update.downgrade_refused`), and the
  status client now waits nine seconds.

Source checks cover these with the live state as fixtures: 22 updater tests on
macOS (two model the 8 November state and fail without the change), 51 native
Mac tests, 149 app unit tests, strict SwiftLint and an App/Core typecheck.
Still unverified on the real Mac: whether SMAppService keeps the existing
approval across unregister and register (9 November suggests not: the
re-registration was refused); that the 0.9.0 worker verifies the new
release, refuses the 1.0.13 downgrade and exits; and the full path from a signed
newer app to a working team. Any extra product process, such as a team daemon
started by hand from the app bundle, holds clearance until it exits.
