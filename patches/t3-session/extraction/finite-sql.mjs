/** Carry a restrictive finite window to the actual original SQLite step,
 * including cached statements and checkpoint-admission waits. Never admission. */
export const extractFiniteSql = author => {
  const file = 'packages/shared/src/nodeSqliteClient.ts'
  author.replace(file, 'const ReadOnly = Context.Reference<', `export interface SqliteStatementDeadline {
  readonly notAfterMs: number;
  readonly notAfterMonotonicMs: number;
}
const StatementDeadline = Context.Reference<SqliteStatementDeadline | undefined>(
  "nessie/session-engine/SqliteStatementDeadline", { defaultValue: () => undefined });
/** Restriction only. A supplied window cannot authorize a SQL mutation. */
export const withStatementDeadline = (deadline: SqliteStatementDeadline) =>
  Effect.provideService(StatementDeadline, Object.freeze({ ...deadline }));

const ReadOnly = Context.Reference<`, 'finite-sql-statement-window')
  author.replace(file, '        const execute = () => {\n          let arrays = false;', `        const window = Context.get(fiber.context, StatementDeadline);
        // Rollback must remain possible after expiry. Every other step,
        // including COMMIT and a cached statement, checks the current clock.
        const cleanup = /^\\s*ROLLBACK\\b/i.test(statement.sourceSQL);
        const checkWindow = () => {
          if (window === undefined || cleanup) return;
          if (!Number.isSafeInteger(window.notAfterMs) || !Number.isFinite(window.notAfterMonotonicMs)
            || Date.now() >= window.notAfterMs || performance.now() >= window.notAfterMonotonicMs) {
            throw new Error("T3_SQL_STATEMENT_DEADLINE_EXPIRED");
          }
        };
        const execute = () => {
          let arrays = false;`, 'finite-sql-check-after-actual-admission-wait')
  author.replace(file, '            const value = withClassification(classification, () => {\n              statement.setReadBigInts(',
    '            checkWindow();\n            const value = withClassification(classification, () => {\n'
    + '              statement.setReadBigInts(', 'finite-sql-before-actual-step')
  author.replace(file, '            result = Exit.succeed(value);',
    '            checkWindow();\n            result = Exit.succeed(value);', 'finite-sql-late-outcome-refused')
}
