/** The source encoder captures a write before its queue. Queue drain consumes
 * that same object and acknowledges only the protected pipe's completed write.
 * The hook is an internal transport, never admission or caller metadata. */
export const extractCodexSerialization = author => {
  const file = 'packages/effect-codex-app-server/src/protocol.ts'
  const client = 'packages/effect-codex-app-server/src/client.ts'
  const header = `export interface CodexCapturedWrite {
  readonly write: Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly discard: Effect.Effect<void>;
}

/** Bound once to an original invocation, not a mutable current-grant lookup. */
export interface CodexSerializedOutput {
  readonly capture: (encoded: string) => Effect.Effect<CodexCapturedWrite, CodexError.CodexAppServerError>;
  readonly refuse: (requestId: string | number) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

interface CapturedQueueEntry {
  readonly captured: CodexCapturedWrite;
  readonly acknowledged: Deferred.Deferred<void, CodexError.CodexAppServerError>;
}

`
  author.replace(file, 'export interface CodexAppServerPatchedProtocolOptions {',
    header + 'export interface CodexAppServerPatchedProtocolOptions {\n'
      + '  readonly serializedOutput?: CodexSerializedOutput;',
    'codex-immutable-serialized-output')
  author.replace(file, '    const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();',
    `    const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
    const capturedOutgoing = yield* Queue.bounded<CapturedQueueEntry, Cause.Done<void>>(8);
    const capturedPending = new Set<CapturedQueueEntry>();
    yield* Effect.addFinalizer(() => Effect.forEach([...capturedPending], (entry) =>
      Deferred.fail(entry.acknowledged, new CodexError.CodexAppServerInputStreamEndedError({})).pipe(
        Effect.andThen(entry.captured.discard)), { discard: true }));`, 'codex-captured-queue')
  author.replace(file, '            yield* Queue.end(outgoing);',
    `            yield* Queue.end(outgoing);
            yield* Queue.end(capturedOutgoing);
            yield* Effect.forEach([...capturedPending], (entry) =>
              Deferred.fail(entry.acknowledged, error).pipe(Effect.andThen(entry.captured.discard)),
              { discard: true });`, 'codex-terminate-captured-writes')
  author.replace(file, '        const accepted = yield* Queue.offer(outgoing, encoded);',
    `        if (options.serializedOutput) {
          // The encoder's exact complete NDJSON and immutable invocation port
          // are captured before the first Queue.offer. No sink reconstructs it.
          return yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
              const captured = yield* options.serializedOutput!.capture(encoded);
              const acknowledged = yield* Deferred.make<void, CodexError.CodexAppServerError>();
              const entry = Object.freeze({ captured, acknowledged });
              capturedPending.add(entry);
              return entry;
            }),
            (entry) => Effect.gen(function* () {
              if (!(yield* Queue.offer(capturedOutgoing, entry))) {
                return yield* new CodexError.CodexAppServerInputStreamEndedError({});
              }
              return yield* Deferred.await(entry.acknowledged);
            }),
            (entry) => entry.captured.discard.pipe(
              Effect.andThen(Effect.sync(() => { capturedPending.delete(entry); }))),
          );
        }
        const accepted = yield* Queue.offer(outgoing, encoded);`, 'codex-capture-before-queue')
  author.replace(file, '    yield* Stream.fromQueue(outgoing).pipe(',
    `    yield* Stream.fromQueue(capturedOutgoing).pipe(
      Stream.runForEach((entry) => entry.captured.write.pipe(
        Effect.matchEffect({
          onSuccess: () => Deferred.succeed(entry.acknowledged, undefined),
          onFailure: (error) => Deferred.fail(entry.acknowledged, error).pipe(
            Effect.andThen(handleTermination(() => Effect.succeed(error)))),
        }), Effect.asVoid)),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(`, 'codex-drain-exact-captured-write')
  author.replace(file,
    '    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));',
    `    ) => options.serializedOutput
      ? options.serializedOutput.refuse(requestId)
      : offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));`,
    'codex-fixed-protected-unsupported-reply')
  author.replace(client, 'export interface CodexAppServerClientOptions {',
    'export interface CodexAppServerClientOptions {\n'
      + '  readonly serializedOutput?: CodexProtocol.CodexSerializedOutput;', 'codex-client-serialized-output')
  author.replace(client, '    stdio,\n    ...(terminationError',
    '    stdio,\n    ...(options.serializedOutput ? { serializedOutput: options.serializedOutput } : {}),\n'
      + '    ...(terminationError', 'codex-client-forward-captured-output')
}
