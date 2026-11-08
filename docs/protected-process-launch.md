# Provider and history process creation

This is source implementation awaiting the root's combined compiler and installed
qualification. It does not establish a working native journey.

`startProtectedT3Provider(signedLaunch, signal?)` in `src/t3-protected-process.ts`
uses the existing authenticated graph pipe. It returns `ProtectedT3Provider`
with lossless `stdout`/`stderr`, observed `pid`/`exitCode`, `endInput()`,
`terminate()` and positive `closed`. Generic SDK stdin is absent. `completion()`
waits for clearance before exposing the service's result envelope.

The SYSTEM session host calls `ExecutionProcess::Authorize`. The service verifies
the backend launch signature against the paired origin, current graph, source,
release, reservation and preparation. It returns only its held exact launch
descriptor. The creator receives no caller-selected executable/argv/environment.
`execution_spawn::spawn_prepared` uses the same creation-time process/thread/token
protection and suspended nested Job path as the graph. Windows argument quoting
preserves embedded quotes, empty arguments and trailing backslashes; environment
names are case-insensitively unique and the exact block is double-terminated.

`Register` duplicates stdin, stdout and the initial thread handle into the service.
The SYSTEM host drops its stdin writer and raw stdout reader. `Resume` rechecks
source/graph/preparation and phase expiry, claims the transition, then resumes the
held thread inside the service. The ordinary virtual-account executor service
is not changed to SYSTEM. The former ordinary `Command` provider launcher is
removed. A late/ambiguous resume cannot be retried into another launch.

The service forwards observed stdout bytes unchanged, applies bounded buffering,
and retains the actual child process handle. History uses only immutable
`node <bundle> t3-session-history <method> <sessionId> <rawOptions>` and the admitted
`claude-history-read` or `claude-history-fork` purpose. Backend launchThread
authority still rejects both history purposes. In particular, reuseExistingThread
does not authorize a fork. A result receipt requires actual exit code zero,
stdout EOF, bounded output and independently observed empty Job. Nonzero exit
can clear custody but cannot yield a success receipt. Clearance retries return
the exact first journaled result without refreshing timestamps or signatures.

Service-observed native identity must also correlate a dispatched bootstrap
request. No caller providerSession/native identity substitutes for original
allocation or observed output. Frame prepare/commit composition remains separate;
this process interface alone authorizes no provider stdin bytes.

## Exact frame consumption

`ProtectedT3Provider.prepareFrame(bytes, metadata, capturedContext)` uploads a
bounded complete frame in ordered chunks. `T3ExecutionFrameContext` contains the
original `correlationId`, `commandId`, relay `requestDigest` and allocated
`providerSessionId`, captured before the original SDK queue. This is a correlation
assertion, not an authority. Before association it must equal the service's
accepted original launch binding. The service authenticates the SYSTEM host and
its actual graph, rechecks held source and child on every operation, rejects
incomplete/mixed NDJSON and duplicate JSON keys, derives metadata from exact bytes,
and signs FRAME_PREPARATION. Its five-second deadline begins at the first held
chunk and is never extended by retries.

`commitFrame(signedFrameAdmission)` checks the current paired-origin RS256 key,
full binding, child, issuer, exact launch and receipt digests, phase and deadline.
The service claims both nonce and frame before removing the held bytes and
writing them. It does not accept replacement bytes. The pipe writer rechecks the
deadline before each bounded write and ACK follows the actual write/flush.
Uncertain write/ACK terminates the child Job and cannot be retried as a new write.

After native association, `stageEffectFrame` holds one complete frame and returns
its service ID. `commitEffectFrame(frameId, freshSignedProof)` independently checks
the existing T3 effect-grant signature against the protected enrolled origin and
the actual service-associated native ID, homes, session, executor, environment,
epoch and runtime. Original correlation/command/HMAC must match the explicitly
captured frame context. Each grant nonce is consumed once. The graph never reads
machine state or chooses an issuer key. A raw grant reference cannot pass this
path. The runtime obtains the envelope from `VerifiedT3EffectGrant.signedProof`
after a fresh backend consume.

`refuseProviderRequest(protocolId)` has no response-body input. The service
constructs only an unsupported-request error for an outstanding ID it actually
observed on that provider's stdout within five seconds, consumes the ID, and
awaits the pipe write. Successful permission/tool/control responses are not
authorized by this automatic path. Generic stdin and arbitrary caller JSON stay
denied. Codex association observes only a response to a dispatched thread start/
resume ID; Claude initialization evidence follows an admitted initialize frame.

These native APIs still require the runtime owner's immutable original serializer
hooks to capture operation context before enqueue/SDK transport writes. Exporting
them is not evidence that the original SDK integration or installed journey works.

Home selection uses `execution_launch_homes::hold`, composed with the physical
resource owner's `resolve_launch_homes` and `match_launch_home`. Preparation retains
the returned guards and rechecks them before selection, registration, resume and
frame use. Codex's actual CODEX_HOME must match the credential reference (the
shadow home when configured); its continuation/history references remain the
shared home. Claude's explicit CLAUDE_CONFIG_DIR must match its configured home;
HOME/USERPROFILE remain untouched, preserving original keychain grouping.
Defaults and inherited home guesses are refused by this execution resource scope.

After actual OS file-ID matching under the graph's retained owner token, the
service uses the guard's canonical volume-GUID path for the provider home. It
hashes and holds that exact final Launch, before backend launch admission. There
is no later environment rewrite. Directory handles alone cannot pin a drive/SUBST
device mapping, so an original drive-letter spelling is not retained as proof.
History options.dir and process cwd remain original workspace selections, never
native-home aliases. This consumer requires parent integration of physical
producer `77be11620622812af1a44391326035c853b15441`; its compiler and installed
verification remain the root's responsibility. Original serializer integration is
also still required before a positive installed provider journey.

Authored fixtures cover creator selector injection, distinct history methods and
Windows argument/environment encoding. Only builtin Node syntax checks, rustfmt
parsing/formatting and Git whitespace checks ran in the worker. Root must compile,
run those fixtures and exercise creation, revocation, late resume, uncertain ACK,
history failure, backpressure and enclosing graph/host clearance on installed
Windows before qualification.
