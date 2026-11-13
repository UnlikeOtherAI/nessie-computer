/** Share the same Windows filename with SQLite's writer and worker opens. */
export const extractSqlitePaths = author => {
  const file = 'packages/shared/src/nodeSqliteClient.ts'
  author.replace(file, 'import * as NodeSqlite from "node:sqlite";',
    'import * as NodePath from "node:path";\nimport * as NodeSqlite from "node:sqlite";',
    'sqlite-windows-file-namespace-import')
  author.replace(file, '  yield* checkNodeSqliteCompat();', `  yield* checkNodeSqliteCompat();
  // SQLite appends WAL/journal suffixes itself. Ordinary Win32 paths can open
  // the database yet fail later when a sidecar exceeds MAX_PATH. Use the same
  // extended filename for the writer, reader and checkpoint connections.
  if (options.filename !== ":memory:" && options.filename !== "") {
    options = { ...options, filename: NodePath.toNamespacedPath(options.filename) };
  }`, 'sqlite-windows-file-namespace')
}
