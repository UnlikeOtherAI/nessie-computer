# Interactive session resource boundary

Status: authored source checkpoint, 8 November 2026. No interactive capability
is registered or available through this checkpoint. Native custody, canonical
resource admission and the private session gateway remain required. The focused
fixtures are authored and have not run. Syntax parsing is not qualification.

The intended home is the existing Dev/Computer session detail, through its
terminal, browser/device preview and composer voice doors. The UI, WebMCP and
internal/external MCP must use the same canonical operation, including its exact
source identity and resource grant. This checkpoint adds no alternate tool route.

## Interfaces

`src/t3-session/interactive/operations.ts` derives input, result and descriptor
types directly from the original `WsRpcGroup` exported by
`@nessie/t3-session-source/contracts`. `interactiveOperationContract(method)`
provides finite/stream, read/operate, receipt, retry, grant and binding metadata.
It is an inventory for the gateway/tool owners, not a callable registration.
Strict decoding rejects extra fields and returns a content-free boundary error;
it does not log the original schema failure with its input values.

| Canonical operation | Result | Required access and retry |
| --- | --- | --- |
| `terminal.open` | Original `TerminalSessionSnapshot` | Operate; exact terminal and host-resolved workspace; durable operation identity, reconcile uncertain creation. |
| `terminal.attach` | Original `TerminalAttachStreamEvent` stream | Operate even with `resume`; original attach can create/restart a PTY. Preserve original `resume`/`restartIfNotRunning` semantics and reconcile creation before reconnect. |
| `terminal.observe` | Same original stream | Read of an admitted existing terminal; renewing a stream never opens a PTY. |
| `terminal.write/resize/clear/close` | Original finite result/error | Operate on the exact terminal; same operation identity on retry. A write receipt proves delivery only, never command completion. Omitted close target is refused because upstream closes all terminals. |
| `subscribeTerminalMetadata` | Original filtered metadata stream | Read; filter snapshot, upsert and remove before serialization. |
| `preview.open/resize/adjust/close` | Original finite result/error | Operate plus canonical browser grants. Open remains refused until destination/profile/tab admission is bound. Profile clearing is not admitted by tab access. |
| `preview.list/subscribePreviewEvents` | Original list/event stream | Read of exact session tabs; filter lists and validate nested snapshot identity. |
| `device.list` | Original filtered `DeviceServiceState` | Read with `inspectOnly: true`; update/retry inputs are refused. No tool installation. |
| `device.open/close/detail/action` | Original finite result/error | Exact stored host/device association, including threadless operations. Detail is read; other actions operate. Open requires explicit `boot: false`; shutdown and extra app/URL/permission actions remain refused pending their grants. |
| `subscribeDeviceState` | Original filtered state stream | Read; remove foreign devices, sessions, booting rows and host statuses before encoding. Preserve actual unavailable-platform reasons. |
| Original `GET /ws/voice` | Original speech text events and binary PCM | Operate; retain separately selected transcription executor/environment. Audio/finish is never blindly replayed on a replacement connection. |

All rows still have `required_unbound` runtime status. There is no supported
empty stream standing in for missing hardware, custody or admission. A session
grant cannot authorize browser profile access, a different computer or an
environment-wide device/terminal inventory. App identity is independent of the
native Codex/Claude provider; these functions never merge source identities.

`InteractiveScope` is a **restriction after admission**, not an authority token.
It carries the exact executor/environment/thread/connection epoch/runtime
generation, workspace and allowed resource IDs. `requireInteractiveSource`
compares each field without normalization or numeric coercion. A caller-created
scope or callback establishes no human continuity or custody. The canonical
producer must resolve and fence every association before use; T16 supplies no
producer which stamps an observed resource as owned.

`constrainInteractiveRequest` narrows already-decoded original inputs before
native work. Provider credential overlays and arbitrary terminal environments
remain refused until the native owner supplies the required admission. These
restrictions are remaining parity work, not claims that the operations are
complete. Device state still carries the original functional global status;
optional global status details are omitted. The gateway must bind its mounted
hub resource path before serving that state.

## Bounded output and voice

`scopedTerminalOutput` calls the actual pinned
`apps/server/src/terminal/OutputProtocol.ts` through the generated engine export
`TerminalOutputProtocol`. It validates exact event and nested snapshot targets
before enqueue, requires the original snapshot-resync callback and retains
original sequences and shared terminal grid fields. It does not implement
terminal lifecycle, launch or history. Resource mismatches fail the consuming
stream with a content-free error, including callbacks after acquisition; no
foreign event is enqueued. Gateway error mapping must not serialize a native cause.

No original file is patched. The only shared producer change is the namespace
export in the already registered `packaging/session-engine/core/Engine.ts`.
Normal generation must qualify its new source/type closure and hashes; older
generated package evidence does not qualify this export.

`InteractiveStreamWindow` is an executor-local transport window. It retains at
most eight unacknowledged frames, 64 KiB of ordinary in-flight payload, 8 MiB
of total queued/in-flight payload and 1,024 total frames. One large frame may
exceed the 64 KiB window, but cannot exceed 1 MiB. Multipart original messages
must be framed by the canonical transport; do not truncate or rewrite them.
Exact ordered relay ACKs release credit; duplicates are harmless and future or
skipped ACKs fail. Relay ordinals never replace original source sequences.

Overflow fails explicitly with `stream_capacity` and drops this transport
window. Abort, deadline and close erase retained references and release the
deadline timer. Idle expiry runs without another request. A window cannot last
beyond the canonical read maximum of 60 seconds. The real resource owner must
also interrupt the upstream subscription/native demand when its admission is
withdrawn; closing a relay window proves no PTY/provider/device process stopped.
No server-side transcript buffer or durable resource grant is added.

`InteractiveVoiceProtocol` uses original speech command/event schemas, 16 kHz
Float32 PCM chunk limits and two-frame pending demand. Ready precedes audio;
each update acknowledges one feed, including unchanged text revisions. Invalid
or regressing revisions, malformed PCM and excess demand fail. Finish waits for
all feed acknowledgements. Cancellation closes this attempt and never retries
audio elsewhere. The class validates protocol ordering; it is not a speech
service or proof of available hardware/model. Cloud speech is not selected.

## Required production composition

1. T02/T05: expose an original terminal manager whose PTY creation, process
   inspection, workspace lease and stop paths use admitted native ports. The
   current original `Manager.ts` imports direct `PtyAdapter`, provider credential
   environment setup, `PortScanner` and `NativeTelemetryClient`; importing its
   layer unchanged would cross the approved extraction boundary. Its actual
   `open/attach/observe/write/resize/clear/close` behavior must remain original.
2. T03/T07/T09: bind current canonical human/session/resource admission and
   signed executor delivery before invoking these restrictions. Wire original
   operation IDs and durable mutation receipts, exact generation rechecks,
   publication checks, cancellation and revocation-driven subscription teardown.
3. T09: register original RPC/byte endpoints in the existing session gateway.
   The private `api/src/routes/t3-session-streams.ts` is intentionally not created
   against a fabricated dispatcher. Every stream needs its real bounded resource
   handle and original raw byte/status/error behavior. No generic URL tunnel.
4. Existing browser/device/voice owners: supply canonical browser control and
   frame/chooser/download/upload mappings, device native lifecycle, and local
   speech start/feed/finish/cancel. This checkpoint has no browser byte adapter,
   device hub proxy or transcription producer. Preserve explicit transcription
   destination and require separate admission when it is another computer.
5. UI and tool owners: register applicable actions via the same admitted T09
   operation; use bounded handles for streams and keep unavailable reasons
   visible. No MCP/WebMCP registration in this checkpoint grants bypass access.

## Qualification

The registered public gate is:

```powershell
pnpm exec turbo run test:t3-session-interactive --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

It depends on the normal executor build, including the actual generated source
package. Fixtures import ordinary built exports. They exercise original codecs,
the real original terminal queue/resync interface, exact target restrictions,
metadata filtering, relay credit/overflow/expiry, and voice framing/ACK ordering.
Synthetic subscription callbacks are fixture event sources, not native grants.
No provider, PTY, device, database, server or browser is started by these tests.
Run the normal public typecheck and scoped lint as well. Test heaps are capped
at 512 MiB; builds retain their existing compiler cap of 5 GiB.

All functional gates are currently **unrun** under the assigned source-only
restriction. Heavy setup/build/test requires the coordinator's serial Maxis lane,
at least 12 GiB free at admission, concurrency one and this checkout's own frozen
dependencies/generated outputs. No sibling artifact is a qualification input.

Still required after actual integration: original-client terminal open/write/
resize/clear/close and multi-viewer reconnect; lost attach and stopped history;
read-only denial and mid-stream revocation; admitted browser frames/input and
file chooser/download; device availability and lifecycle; explicit-computer
voice recording/cancel/retry. Repeat through UI, WebMCP and internal/external
MCP. Protected native release and hardware evidence remain separate from these
fixtures. No manual journey or P27/P32/P33/P36 completion is claimed here.
