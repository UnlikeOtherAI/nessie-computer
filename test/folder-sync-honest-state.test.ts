import assert from 'node:assert/strict'
import test from 'node:test'

import { engineStateOf, heartbeatSummaryOf, type EngineFacts } from '../src/folder-sync/report.js'

// The engine's own word, which the heartbeat and the report carry to Nessie,
// must agree with the console, tray and menu bar: an entry resting in `error`
// (a refused name, a transport failure) holds a change that is in neither
// place, so the computer is not up to date (docs/standards/folder-sync.md →
// "Honest status").

const facts = (counts: Partial<EngineFacts['counts']> = {}): EngineFacts => ({
  enabled: true, paused: false, serverStatus: 'live', rootPresent: true, diskFull: false, offline: false,
  snapshotTaken: true,
  counts: {
    entries: 3, pendingUploads: 0, pendingDownloads: 0, openConflicts: 0, waiting: 0, errors: 0, heldDeletes: 0,
    notSynced: 0, ...counts,
  },
})

test('an entry resting in error keeps the engine from up to date', () => {
  assert.equal(engineStateOf(facts()), 'up_to_date')
  const failing = facts({ errors: 1 })
  const state = engineStateOf(failing)
  assert.equal(state, 'needs_attention')
  assert.notEqual(heartbeatSummaryOf(true, state, failing.counts, null).state, 'up_to_date')
  assert.equal(engineStateOf(facts({ errors: 1, pendingUploads: 2 })), 'syncing')
})
