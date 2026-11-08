import { execFileSync } from 'node:child_process'

// Probe the selected executable, including real SQLite authorization behavior.
// A language target or the builder's version cannot establish these capabilities.
const probe = `
const { DatabaseSync, constants } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
try {
  if (typeof db.setAuthorizer !== 'function' || typeof db.isTransaction !== 'boolean') throw Error('sqlite API');
  db.exec('BEGIN');
  if (!db.isTransaction) throw Error('transaction state');
  db.exec('ROLLBACK');
  db.setAuthorizer(() => constants.SQLITE_DENY);
  let denied = false;
  try { db.prepare('SELECT 1').get(); } catch { denied = true; }
  if (!denied) throw Error('authorization bypass');
  process.stdout.write(JSON.stringify({ nodeVersion: process.versions.node }));
} finally { db.close(); }
`

export function inspectPackagedNodeRuntime(executable) {
  try {
    const result = JSON.parse(execFileSync(executable, ['--no-warnings', '-e', probe], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }))
    if (typeof result.nodeVersion !== 'string' || !/^24\.\d+\.\d+$/u.test(result.nodeVersion)) throw new Error('version')
    return Object.freeze({ nodeVersion: result.nodeVersion })
  } catch {
    throw new Error('The packaged executor requires Node 24 with SQLite setAuthorizer and transaction-state support.')
  }
}
