# Runtime durability

These are machine-only recovery and transport boundaries. They add no screen,
setting or keyboard shortcut. The ordinary Add a team dialog still uses code
pairing; the older service `Pair` command remains available to its existing
clients. Public command grammar lives in `cli-arguments.ts`, with standard-input
pairing readers in `cli.ts`. The removed `executor-cli-command.ts` had no import,
package export or distribution entry point.

## Windows pipe lifetime

The pairing/control and runtime-custody pipes each reserve at most 16 workers.
Each instance has 128 KiB input and output buffers. A worker has five seconds
to receive one bounded newline-delimited request, regardless of how many small
writes arrive. After command execution, a separate five-second deadline covers
the reply and the peer closing its handle. Existing command execution limits
remain separate from these transport deadlines.

The server uses byte-mode nonblocking reads and writes, checking shutdown and
the monotonic deadline between calls. It never calls `FlushFileBuffers`, which
can wait indefinitely for the peer to read. A completed write keeps its queued
bytes until the peer closes or the reply deadline expires. The transport uses
the raw Win32 read helper so `ERROR_NO_DATA` is not mistaken for end-of-file.
The behavior follows Microsoft's [pipe wait-mode contract](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-type-read-and-wait-modes)
and [nonblocking connection contract](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe).

Custody saturation does not consume pairing-control workers. Exhausted slots,
instance creation failures and thread creation failures retry without setting
the service shutdown flag. Handles and permits are released on exit, including
a failed thread spawn. Pipe ACLs, local-only access and native custody proofs
are unchanged; accepting a transport connection grants no runtime authority.

## Personal guard capacity

One encoder validates both mutation paths, including credential activation,
before publishing the guard. The exact serialized UTF-8 bytes, including the
newline, must fit within 1 MiB; registrations must not exceed 4,096. Activation
publishes its validated fence before invoking the credential writer. A rejected
registration, execution binding or activation leaves the prior file intact.
Releasing a known stopped admission can still make room.

Older oversized files can be read under the admission lock up to 8 MiB and
32,768 registrations. Recovery removes only claims with a recorded boot UUID
that differs from the independently observed current kernel boot. It preserves
unknown-boot and current-boot claims, and all profile protection. PID absence
alone never clears an arbitrary host process tree. The result must fit the
ordinary write limits before it is published. Malformed files, larger recovery
inputs and unresolved excess claims remain blocked and unchanged. No reset or
credential-fence deletion substitutes for clearance evidence.

## Legacy service pairing

The service holds an OS file lock for each enrollment while it checks, runs and
promotes that attempt. A service-owned journal binds the API URL, enrollment,
challenge, workspace and authenticated Windows SID by a SHA-256 digest. It
contains no challenge or private key. Another input or account cannot adopt the
attempt. An older staging directory with no original owner/input proof is kept
intact and refused; the service does not guess an owner or erase it.

The CLI also holds its existing process lease while pairing. A child surviving
a service restart therefore cannot overlap another pairing writer. When called
by the Windows service, a successful CLI exit keeps its prepared key and exact
signed enrollment request until promotion. Lost HTTP replies, CLI failures,
timeouts and lost stdout retain that request for the next matching retry.

After a successful CLI response the service records the executor ID and
fingerprint before promotion. It writes the owner marker before renaming the
staging directory, then clears the CLI preparation only after promotion. The
completed journal makes retries after a service restart or lost service reply
return the same result without a new CLI invocation. Journal records are
published from synced drafts; locks are never unlinked and uncertain state is
never deleted to make progress.

## Settlement-only inference replay

`LocalInferenceAttemptLease` distinguishes a full active request with a positive
dispatch fence, a settlement-only replay containing admission identity and
`attemptId` with a null dispatch fence, and the all-null idle response. The host
binds the original admission and checks the fence before reading request fields
or discovering/invoking a model. A settlement-only response produces confirmed
non-invocation termination. The coordinator retains the physical capacity claim
until the server acknowledges that termination. No prompt, tools, model details
or decrypted request fields are needed for settlement.

## Focused verification

From the standalone public checkout, after installing its dependencies:

```sh
pnpm exec turbo run test:runtime-durability --root-turbo-json=scripts/turbo.public.json --concurrency=2
pnpm exec turbo run lint typecheck build --root-turbo-json=scripts/turbo.public.json --concurrency=2
cargo test --locked --manifest-path service-windows/Cargo.toml
cargo clippy --locked --manifest-path service-windows/Cargo.toml --all-targets -- -D warnings
```

Run the Rust commands on Windows. `pipe_lifecycle_tests` uses unique disposable
pipes, stalls readers and writers, fills the custody budget, checks control
responsiveness and waits for recovery while the stalled clients remain open.
`pair_recovery_tests` runs a real child process with a scripted CLI under a
disposable supervisor root; the TypeScript pairing tests separately exercise
the actual signed-request preparation and replay. These are test fixtures, not
installed custody or live-server enrollment proofs.

The Windows TypeScript runner requires the Debug native ACL helper at
`native/target/debug/nessie-executor-native.exe`, with an unmarked Node beside
it. Reuse a matching test artifact or prepare it on the verification host before
running the gate. Its absence is a blocked check, not a skipped pass.

The focused TypeScript gate covers count and UTF-8 byte limits, rejected-write
preservation, boot-proven recovery, unknown claims, the recovery read ceiling,
pairing replay, payload-free settlement, CLI grammar and help. It needs no
database. Server replay/database checks belong to the control-plane change.

Before release, use an isolated Windows candidate through the real service
control doorway: repeat a lost-reply legacy enrollment, restart before promotion,
check ordinary status and valid native admission, and confirm refusal of a
different Windows account. Keep this separate from the installed live service.
The existing code-pairing promotion regression also needs its Windows test and
manual Add a team flow because the owner-marker write now precedes its shared
directory rename. No visible UI changes require screenshot evidence here.
