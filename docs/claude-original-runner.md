# Original Claude query runner

`makeSessionClaudeQueryRunner` connects the original T3 runner tag to the pinned
SDK capsule and the existing reserved native launch. This is a machine-only
composition boundary. Production `open` still refuses while full host activation
and the remaining effect owners are unfinished.

## Shared source and actual launch

The application and protected runner share the original prompt queue, query
controls, MCP initialization and message diagnostics. Extraction moves those
implementations into `ClaudeAdapterV2.session-query.ts`, the original tag/types
into `.session-port.ts`, and pure protocol helpers into `.session-protocol.ts`.
The application retains its launcher, logger and resumed-open retry policy.

The protected runner uses the same `SecureRandom` service to allocate session
IDs. Its one open belongs to the accepted target and original initial-message
edge. The SDK builds its actual command/argv/cwd/environment descriptor; native
preparation holds that descriptor under the reservation's original provider
session ID. Explicit Windows executables and a configured Claude home are
required. Native independently matches that home to its held directory handles.

The original T3 `Queue.offer` receives an opaque SDK capture. Capture runs
synchronously before that offer; its original `onQueued` callback runs after
the actual native write acknowledgment. Parent cancellation interrupts and joins
the actual queue take, SDK parser, captured writes and provider clearance.
`stderrDrained` means pipe drainage and remains separate from native clearance.

The existing Codex writer was refactored before reuse. Both drivers use the same
native held-byte preparation, backend FRAME admission, signature/binding checks
and awaited commit. Their metadata decoders remain distinct. The SDK transport
provides no generic stdin or spawned-process facade. Failed or uncertain native
preparation cannot reopen this runner.

## Association and lifetime

The shared original `isClaudeTurnStartMessage` edge requests association when
the SDK yields `system/init`. That request carries no caller-selected native ID.
The service must independently recognize its actual held child stdout, including
the init UUID and preceding initialization write, before producing association.
An allocated session ID or process argument cannot substitute for that evidence.

Association closes bootstrap input. Post-association writes still require their
separate original effect context and native proof. This composition does not
provide that writer or authorize further user/tool input through bootstrap.

Both original factories inspect their actual Effect scope and its ancestors.
Closing starts refusal before finalizers drain. The Codex parser is a real child
scope. Captured writes check lifetime before and after native acknowledgment;
escaped owners cannot acquire work while parent cleanup is pending.

## Required host owners

`SessionClaudeHistoryOwner` is required for history fork, subagent lookup and
the original completeness check. Its admitted producer is still absent. History
uses its distinct native purposes; ordinary SDK host-config reads cannot supply
this service.

SDK host callbacks execute before their response is encoded. Tool permission,
hook, elicitation and dialog callbacks therefore need their actual pre-effect
authority before this path accepts them. They currently refuse before native
startup, as do SDK/in-process and stdio MCP hosts. HTTP/SSE MCP configuration
uses the original stdin registration path, with real credential issue/resolve/
revoke owners still required by full activation.

Selected Claude construction now follows [the original host contract](claude-selected-host.md).
Real host services, MCP credential ownership, startup/recovery authority,
workspace/attachment/TurnStart effects, post-association input, history
and installed signed verification remain unfinished. Empty secret plans alone
do not satisfy those dependencies.

## Verification

Run `test:t3-session-runtime`, `test:t3-session-engine`,
`test:t3-session-claude-sdk` and `test:t3-session-request-source` through the
public Turbo graph on Maxis, with the isolated `DATABASE_URL` exported and
concurrency one. Runtime fixtures use the external `T3_RUNTIME_FIXTURE_ROOT`.

Real Node echo subprocesses exercise the original SDK and original T3 queue,
MCP byte transport, notification timing and cancellation. These fixtures do not
run Claude or establish SYSTEM custody, native association or installed readiness.
Source/privacy replay separately checks both the application and derived source.
