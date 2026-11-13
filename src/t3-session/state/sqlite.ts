/** Minimal structural surface shared by Node's supported SQLite connection and the capture journal. */
export type SqlValue = string | number | bigint | null | Uint8Array
export type SqlRow = Record<string, SqlValue>
export interface SqlStatement {
  all(...parameters: SqlValue[]): SqlRow[]
  get(...parameters: SqlValue[]): SqlRow | undefined
  iterate(...parameters: SqlValue[]): IterableIterator<SqlRow>
  run(...parameters: SqlValue[]): { changes: number | bigint }
}
export interface CaptureDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
}

export class CaptureFailure extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'CaptureFailure'
    this.code = code
  }
}

export function requireCapture(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CaptureFailure(code)
}

/** Journal writes serialize on the same database, including the generation recheck. */
export function journalTransaction<A>(database: CaptureDatabase, body: () => A): A {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
