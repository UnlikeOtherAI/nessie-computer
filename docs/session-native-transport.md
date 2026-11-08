# Original session adapter transport

Status: source ABI audit, not an admitted provider binding. Original T3 source
was read from Git objects at `25bf84ab07f53f141c20239c63e383823a9d5ea0`.
The Claude SDK `0.3.316` archive was fetched without installing or executing it
and verified against that revision's `pnpm-lock.yaml` integrity:

```text
sha512-mCMr0que5kIy80JslJub6WFDB2+GYRGWNeVgSZaBpkBwXrr4wnRMnnGHitkA2BEJ5QP5xWyc6YH/6do/edxCWg==
```

The bounded builtin audit used a 192 MiB heap, a 32 MiB compressed limit and
64 MiB decompressed limit. It read `package/sdk.d.ts` in memory. No dependency
tree, generated output, provider or native process was created.

## Codex Stdio

The original `packages/effect-codex-app-server/src/_internal/stdio.ts`
`makeChildStdio(handle, stderrDrained)` uses:

- `Stdio.args`: `Effect.succeed([])`.
- `Stdio.stdin`: child stdout as `Stream<Uint8Array>`, ending only after
  `stderrDrained` completes.
- `Stdio.stdout()`: the child stdin sink, accepting `string | Uint8Array`;
  strings pass through `TextEncoder`, byte chunks remain bytes.
- `Stdio.stderr()`: `Sink.drain`; actual child stderr is drained separately.

Keep the original `CodexClient.make(stdio, options, terminationError)` and
`CodexAppServerClientFactory.open({ instanceId, threadId, providerSessionId,
runtimePolicy, settings, environment })`. The transport must preserve bytes,
backpressure, error propagation and the awaited write outcome. A pipe ACK is
not provider acceptance or an original command receipt.

## Claude SDK process ABI

SDK `SpawnedProcess` requires:

```ts
stdin: Writable
stdout: Readable
readonly killed: boolean
readonly exitCode: number | null
readonly signalCode?: NodeJS.Signals | null
kill(signal: NodeJS.Signals): boolean
on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
on(event: 'error', listener: (error: Error) => void): void
once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
once(event: 'error', listener: (error: Error) => void): void
off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
off(event: 'error', listener: (error: Error) => void): void
```

`stderr` is not a member of this SDK interface. The original adapter separately
drains stderr and retains its bounded diagnostic tail; the custody producer
must expose that stream to the adapter as well.

`SpawnOptions` contains `command: string`, `args: string[]`, optional `cwd`,
`env: Record<string, string | undefined>` and required `signal: AbortSignal`.
The SDK signal is forwarded after its stdin-EOF/graceful-close path, with an
approximately two-second grace; it is not the caller's immediate signal.
`spawnClaudeCodeProcess` is synchronous. A facade must not forward writes or
claim a live native child before protected acquisition completes.

Keep `ClaudeAgentSdkQueryRunner.open`, `forkSession`,
`subagentLaunchToolUseId` and `assertComplete`, plus the original query methods.
Neither `kill()` returning true nor an exit event proves process-tree clearance.
Original cleanup must await the custody owner's positive
`confirmHostExecutionStopped`; unknown stop retains debt and prevents replacement.

## Claude history child

Original `ClaudeAgentSdkSessionForkInput` contains `sessionId`,
`options: ForkSessionOptions`, `environment`, original `threadId` and
`providerSessionId`. `runClaudeWorker` launches the host executable with a fixed
`__claude-history` entry in a packaged executable, followed by `forkSession`,
the original session ID and JSON options. It passes the admitted environment
plus `ELECTRON_RUN_AS_NODE=1`, applies a 30-second deadline and converts a
nonzero exit to `ClaudeAgentSdkQueryRunnerError` before decoding stdout.

The original `runClaudeHistoryWorker(method, sessionId, rawOptions)` accepts
`getSessionMessages` or `forkSession`. Its options codec contains optional
`dir`, `includeSystemMessages` and `upToMessageId`. Fork calls the SDK, reads
the fork's messages and returns the fork result with optional last-message
`headMessageId`. This behavior must remain, using a fixed immutable executor
child entry rather than a source-tree sibling script. Fork is a native write:
it requires its own finite admission and child clearance, including on timeout.

## Per-operation authority remains required

Neither the Codex Stdio sink nor Claude's Writable carries original
`requestDigest`/`commandId`. Claude queues prompts and creates control request
IDs inside the SDK. A process-wide latest-grant field or AsyncLocalStorage
around a query method does not establish correlation with later serialization.
The launch grant must never authorize arbitrary later SDK input.

Concrete serialization locations are now audited. Codex's original
`protocol.ts` `offerOutgoing(message)` encodes and enqueues a string; capture
the finite operation's association before that queue, and consume it at the
protected write. In verified Claude SDK `0.3.316`, the six
`this.transport.write` call sites are in `handleControlRequest` (reply),
`request` (request and cancellation), `writeAfterInitialize` (immediate and
deferred), and `streamInput` (prompt). `request` generates `request_id`
internally. Deferred writes wait for initialization; prompt writes consume the
asynchronous input iterator. The exported `Transport` type has a
`write(string): void | Promise<void>` method, but the public
`query({ prompt, options })` interface exposes no injected transport or
serialization hook. A narrow reviewed hook at those serialization boundaries
is required; accessing private Query fields or relying on ambient invocation
context is not an admitted producer.

The protected byte producer takes explicit fresh `SessionEffectAuthority` for
each admitted logical write and awaits its native outcome. The runtime adapter
must associate that operation with the exact protocol request/message IDs at
serialization, retaining the original command, thread, provider session,
runtime generation and native association. Chunk boundaries are not message
boundaries. Partial UTF-8/frames must be retained within bounded storage;
ambiguous or mixed-authority writes are refused atomically.

Automatic replies use a separate restricted path and must correlate a real
outstanding provider request. Structural JSON classification alone is not
authority for arbitrary SDK bytes. No replay follows an uncertain ACK.

The exact per-operation serialization binding is absent from the integrated
original adapters at this checkpoint. Generic SDK stdin remains unbound until
that producer and canonical native-association admission integrate. This audit
supplies no raw spawner, credential resolver or alternate provider engine.
