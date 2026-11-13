# Retained import in the running daemon

Status: source implemented, not compiled or exercised. No signed package, native
ceremony, installed daemon, source database or user session was opened for this
checkpoint. The real Windows journey and normal combined graph qualification
remain required.

The integration candidate includes public `main` at
`30ba47d5bef31b0960b77215b468d9ca7277c0d3`, including the installed
`e799a7aa3dc53d8430a925ba3027b2039adca7ae` security/update baseline.
Conflict resolution preserves runtime peer-verification permission, separate
source-consent intake, fresh effect checks during exclusive file-create retries,
secret staging checks and both retained-import and local-inference tray output.
Source syntax checks do not qualify the combined native implementation.

## Home and protected local channel

The existing Windows executor console Settings review is the human doorway.
The tray still fetches queued challenges, verifies the selected paired executor,
and calls the protected source-owner ceremony. Neither receipt delivery nor
opening Settings approves anything. The original challenge, recipient, exact
source identities and unattested baseline remain unchanged.

The existing `user_connections` controller starts the verified packaged
`managed-runtime -- serve` child, retaining its inherited stdin for parent
liveness. `native/src/managed_windows.rs` launches the pinned Node/bundle under
the existing suspended-launch, custody registration and retained job lifetime;
it inherits standard handles. The handoff reuses those handles. The tray requests
`--parent-retained-stdio` together with `--parent-liveness-stdin`, pipes stdout,
and reads only bounded status frames from that exact child. There is no new
named pipe, loopback listener, daemon instance, executable selector or service
control command. A service-owned or externally started daemon is explicitly
unsupported by this doorway; it is never replaced or adopted.

The tray requires nonblocking mode on the inherited write handle. If Windows
refuses that mode, retained forwarding is unavailable and the ordinary daemon
remains usable. A partial or failed write closes this handoff's liveness handle
and reports uncertainty; it never retries into a partial frame or releases the
native approval based on a pipe error. This handle behavior still needs native
qualification.

Before native approval, the tray requires the running child to have acknowledged
the handoff channel. After the ceremony it forwards the actual in-memory
`{ challenge, receipt, expiresAtMs }` snapshot. No approval JSON, token or replay
spool is written locally. The existing `t3-retained` management CLI remains
proposal/status-only; its JSON output is now correctly read by the tray runner.
It cannot accept a receipt or launch a second capture process.
Offer/enrollment reviews keep their issuer pipe until server submission returns.
Their scoped cleanup removes only the exact original ceremony, so a late return
after cancellation cannot remove a newer review.

## Fixed protocol and results

One UTF-8 JSON line is at most 4096 bytes. The only accepted input operations are:

| Operation | Input | Result and retry |
| --- | --- | --- |
| `retained-import.begin` | Version 1, exact native challenge/receipt and finite expiry | `accepted` means parsed and scheduled, not authority or capture success. Exact active retry observes the same status; changed input cannot replace the existing operation and observes its status. |
| `retained-import.cancel` | Version 1 and exact challenge ID | `stopping` withdraws intake; `closed` follows completed producer teardown. Repeated cancellation observes the same operation. |

Output is credential-free `{ version: 1, kind: 'retained-import', status,
challengeId? }`. Initial `ready` describes the local framing channel only.
`published` follows the canonical publication receipt and held-lane attachment.
`closed` follows successful complete callback/source/native/server withdrawal.
`refused` means the request was denied before starting a producer. `failed`
does not claim completed native cleanup. Pipe/process exit is never a `closed`
receipt. Both directions bound frames and preserve exact challenge correlation;
malformed input, extra properties, invalid UTF-8 or excess pending output retires
the handoff. Standard output carries no receipt or source content.
Rejected retries for an existing ID retain that producer's current or terminal
status. They never emit a new `refused` that could release an approval still in
use. Unexpected dispatcher exceptions retire the channel without asserting a
completed outcome.

Only whole-source grants enter this capture doorway. Selected-thread grants
remain explicitly unsupported here, even though their separately issued native
bootstrap read/publication scope exists. They are not promoted to whole-source
capture or inherited/shared closure. Generic commands, native controls and stream
requests are not part of the parent protocol.

## One daemon and one held graph

After `claimExecutor` and `registerMachineT3Sources`, `serveExecutor` constructs
one transient retained registry and the existing T07 signed lane. The unused
pre-start `options.t3Sessions` injection is replaced by that actual registry;
callers must not wrap `serveExecutor` in another capture/daemon instance.
The local channel starts only when the explicit CLI option supplies its inherited
input/output. Parent EOF consumed during initialization still stops the daemon.

`createRetainedDaemonRuntime` invokes `withCapturedRetainedRuntime` directly.
The original local/native/server producer consumes the receipt, supplies capture
bootstrap authority, holds one physical reader and one private destination writer,
and composes the original capture/read graph. Inside the same callback it calls
`graph.publish(local.bootstrapAuthority('publish'), () => live, signal)`.
Only after publication completes is the callback's lane attached and the existing
session cadence awakened. No SQL/source connection is opened for forwarding,
publication or each request.

The lane preserves the eight finite RPC/five HTTP implementation ceiling, original
contracts and receipt-none read semantics. Every signed read still consumes its
own operation-bound local native grant. Parent `accepted`, publication, routing
readiness or prospective provenance grants no read or execution authority.
WebMCP and internal/external MCP use the existing canonical operation gateway;
they cannot send local approval or parent frames. Human approval remains local.

## Retirement, expiry and recovery

The registry permits one active import and retains only its transient digest and
last status. Cancellation removes its lane immediately, signals the callback to
return, and joins the complete producer before acknowledging `closed`. The tray's
Stop waits for that correlated acknowledgement before releasing its issuer pipe.
A finite wait expiring reports uncertainty and leaves the native approval held;
it does not infer success. A failed handoff latches refusal of replacements in
that daemon, preserves partial durable capture/journal artifacts and reports an
unproved close. The next verified daemon acquisition still requires actual
producer/native checks; no journal, lock, receipt or stuck request is deleted to
force recovery.

The enclosing deadline is the minimum of the actual receipt expiry, challenge
grant expiry, forwarded finite deadline and five minutes from admission. Neither
progress, retries nor signed stream credits extend it. Capture/publication retain
their independently bounded bootstrap leases (at most 60 seconds). The existing
20-second physical/local consent checks remain; no second heartbeat is added.

Daemon shutdown and connection failure withdraw and join this owner before global
API cancellation and source-registry release. Shutdown errors remain failures.
Automatic updates wait while the held import is busy. Parent loss or expiry may
invalidate native consent before cooperative cleanup can finish; those paths
withdraw readiness and make no positive native-release claim. No provider stop,
native session mutation or executing lifecycle follows from local cancellation.

## Qualification still required

Authored fixtures cover fragmented/bounded framing, unknown/excess/invalid UTF-8
input, joined retirement, selected-grant refusal, real unregistered-owner refusal,
CLI flag coupling, startup EOF and Rust acknowledgement correlation/terminal
status refusal. They are unrun. TypeScript builtin syntax parsing and whitespace
checks do not validate Rust, imports, native custody or this journey.

In the coordinator's serial window, use the existing `test:t3-session-runtime`
Turbo gate plus the executor CLI/daemon-liveness tests and the tray Rust tests
and check. No dependency installs or heavy window are authorized by this document.
Then use an explicitly admitted signed Windows candidate and isolated fixtures:
review whole-source consent in Settings, observe actual capture/publication and
finite read through Sessions/WebMCP/MCP, stop during capture/publication/read,
verify ordered drain and server withdrawal, and exercise wrong executor, selected
grant, malformed frame, duplicate request, expired approval, changed epoch,
lost parent and failed cleanup. Verify source and destination are each opened
once, no provider launches, and no stale lane survives. Capture visible evidence
only for changed UI states. No installed or end-to-end availability is claimed.
