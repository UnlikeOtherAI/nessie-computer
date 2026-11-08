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

Authored fixtures cover creator selector injection, distinct history methods and
Windows argument/environment encoding. Only builtin Node syntax checks, rustfmt
parsing/formatting and Git whitespace checks ran in the worker. Root must compile,
run those fixtures and exercise creation, revocation, late resume, uncertain ACK,
history failure, backpressure and enclosing graph/host clearance on installed
Windows before qualification.
