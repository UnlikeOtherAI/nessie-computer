import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultUpdateState, readUpdateState, remindAboutUpdateTomorrow,
  updateReminderDue, writeUpdateObservation, writeUpdatePreferences } from '../src/updates/state.js'

test('automatic stable updates default on and an explicit opt-out survives later catalog writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-update-preferences-'))
  const stateRoot = join(directory, 'updates')
  try {
    assert.deepEqual(await readUpdateState(stateRoot), defaultUpdateState())
    await writeUpdatePreferences(stateRoot, { ...defaultUpdateState(), automatic: false })
    await writeUpdateObservation(stateRoot, { ...defaultUpdateState(), highestSequence: 7 })
    assert.equal((await readUpdateState(stateRoot)).automatic, false)
    assert.equal((await readUpdateState(stateRoot)).highestSequence, 7)
    await writeUpdatePreferences(stateRoot, { ...defaultUpdateState(), channel: 'preview', automatic: false })
    assert.equal((await readUpdateState(stateRoot)).highestSequence, 0)
    await writeUpdateObservation(stateRoot, { ...defaultUpdateState(), channel: 'preview', highestSequence: 3 })
    await writeUpdatePreferences(stateRoot, { ...defaultUpdateState(), automatic: false })
    assert.equal((await readUpdateState(stateRoot)).highestSequence, 7, 'returning to stable retains its replay floor')
    assert.equal(JSON.parse(await readFile(join(stateRoot, 'preferences.json'), 'utf8')).automatic, false)
    await writeFile(join(stateRoot, 'preferences.json'), '{', { mode: 0o600 })
    await assert.rejects(readUpdateState(stateRoot), /update.preferences_unavailable/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('reminders are per version, last one day and a newer release is announced immediately', () => {
  const state = remindAboutUpdateTomorrow(defaultUpdateState(), '1.0.2', 100)
  assert.equal(updateReminderDue(state, '1.0.2', 101), false)
  assert.equal(updateReminderDue(state, '1.0.2', 86_400_100), true)
  assert.equal(updateReminderDue(state, '1.0.3', 101), true)
  assert.equal(state.automatic, true)
})
