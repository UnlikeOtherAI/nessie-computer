import assert from 'node:assert/strict'
import test from 'node:test'

import { EXECUTOR_FOLDER_SYNC_ERROR_CODES as CODES } from '@nessie/executor-protocol'

import { ExecutorApiError } from '../src/api-client.js'
import { isTransientSyncError } from '../src/folder-sync/transport.js'

/**
 * Found by the real-stack rehearsal: the API's per-IP limiter answers 429
 * `RATE_LIMITED` (not the sync code) before a sync route runs. The initial
 * sync of 224 files met it on the byte route, and the engine — reading it as an
 * action failure — re-planned at once: 1,664 refused downloads in 25 seconds.
 */
test('any 429 is transient: the pass backs off instead of re-planning at once', () => {
  assert.equal(isTransientSyncError(new ExecutorApiError('Too many requests', { code: 'RATE_LIMITED', status: 429 })), true)
  assert.equal(isTransientSyncError(new ExecutorApiError('Slow down', { code: CODES.RATE_LIMITED, status: 429 })), true)
  assert.equal(isTransientSyncError(new ExecutorApiError('Unavailable', { status: 503 })), true)
})

test('a refusal that says something about the request stays an action failure', () => {
  assert.equal(isTransientSyncError(new ExecutorApiError('Gone', { code: CODES.NOT_FOUND, status: 404 })), false)
  assert.equal(isTransientSyncError(new ExecutorApiError('Conflict', { code: CODES.CONFLICT, status: 409 })), false)
  assert.equal(isTransientSyncError(new ExecutorApiError('Too large', { code: CODES.TOO_LARGE, status: 413 })), false)
})
