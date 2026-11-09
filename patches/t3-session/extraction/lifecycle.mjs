/** Preserve the original global recovery policy while making its two SQL
 * transitions indivisible. Notification belongs to the outermost commit. */
export const extractLifecycleTransactions = author => {
  const file = 'apps/server/src/orchestration-v2/EffectOutbox.ts'
  const original = author.between(file, '      reconcileAfterProcessLoss: Effect.gen(function* () {',
    '      // The worker polls for the next effect even when there is no work to claim.')
  const atomic = original.replace('reconcileAfterProcessLoss: Effect.gen(function* () {',
    'reconcileAfterProcessLoss: sql.withTransaction(Effect.gen(function* () {')
    .replace('if (requeuedRows.length > 0) yield* notifyAvailable(requeuedRows.length);',
      'if (requeuedRows.length > 0) yield* sql.afterCommit(notifyAvailable(requeuedRows.length));')
    .replace('      }).pipe(', '      })).pipe(')
  author.replace(file, original, atomic, 'lifecycle-atomic-process-loss-and-committed-notification')

  const sqlite = 'packages/shared/src/nodeSqliteClient.ts'
  const connection = '  const semaphore = yield* Semaphore.make(1);\n  const connection = yield* makeConnection;'
  author.replace(sqlite, connection, `${connection}
  // Retain the original routing/ownership locks. The shared Effect SQLite
  // cleanup owner runs only while that actual connection is held, and refuses
  // reuse after failed rollback until its next cleanup attempt succeeds.
  const recoveries = new WeakMap<Connection, ReturnType<typeof Client.makeSqliteAcquirers>>();
  const recoveryFor = (connection: Connection) => {
    let recovery = recoveries.get(connection);
    if (recovery === undefined) {
      recovery = Client.makeSqliteAcquirers({ connection: Effect.succeed(connection),
        semaphore: Semaphore.makeUnsafe(1) });
      recoveries.set(connection, recovery);
    }
    return recovery;
  };`, 'lifecycle-sqlite-failed-commit-owner')
  author.replace(sqlite, '        return use(target.connection);',
    '        return recoveryFor(target.connection).borrower(use);', 'lifecycle-clean-before-sqlite-borrow')
  author.replace(sqlite,
    '    use: (connection: Connection) => Effect.Effect<A, E, R>,\n  ): Effect.Effect<A, E, R> =>',
    '    use: (connection: Connection) => Effect.Effect<A, E, R>,\n  ): Effect.Effect<A, E | SqlError, R> =>',
    'lifecycle-retain-sqlite-cleanup-failure')
  author.replace(sqlite, `        return Effect.as(
          // A scheduler yield after taking the permit must not precede its release finalizer.
          Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
          target.connection,
        );`, `        return Effect.andThen(
          // A scheduler yield after taking the permit must not precede its release finalizer.
          Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
          recoveryFor(target.connection).borrower(Effect.succeed),
        );`, 'lifecycle-clean-before-sqlite-transaction')
  author.replace(sqlite, '    compiler,\n    transactionAcquirer,',
    '    compiler,\n    transactionAcquirer,\n'
    + '    onCommitFailure: (connection) => recoveryFor(connection).onCommitFailure(connection),',
    'lifecycle-clean-rejected-sqlite-commit')
}
