import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stampDaemonLog } from '../src/daemon-log-time.js'

test('every daemon log line starts with when it was written', () => {
  const original = { error: console.error, warn: console.warn }
  const lines: unknown[][] = []
  console.error = (...parts: unknown[]) => { lines.push(parts) }
  console.warn = (...parts: unknown[]) => { lines.push(parts) }
  try {
    stampDaemonLog(() => new Date('2026-11-11T09:30:00.000Z'))
    console.error('[nessie-executor] codex was not offered:', 'RATE_LIMITED')
    console.warn('[nessie-executor] a warning')
    assert.deepEqual(lines, [
      ['2026-11-11T09:30:00.000Z', '[nessie-executor] codex was not offered:', 'RATE_LIMITED'],
      ['2026-11-11T09:30:00.000Z', '[nessie-executor] a warning'],
    ])
  } finally { Object.assign(console, original) }
})
