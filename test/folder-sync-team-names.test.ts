import assert from 'node:assert/strict'
import test from 'node:test'

import { TeamNames } from '../src/folder-sync/team-names.js'
import type { FolderSyncTransport } from '../src/folder-sync/transport.js'

/** Only `teamNames` is read; every other transport call is a defect here. */
const claims = (answers: Array<{ teamName: string | null; organizationName: string } | Error>) => {
  let asked = 0
  const transport = {
    teamNames: async () => {
      const answer = answers[Math.min(asked, answers.length - 1)]!
      asked += 1
      if (answer instanceof Error) throw answer
      return answer
    },
  } as unknown as FolderSyncTransport
  return { transport, asked: () => asked }
}

test('before the folder is named, names are read once per start, and each hour while one is unknown', async () => {
  let now = 0
  const claim = claims([new Error('offline'), { teamName: 'Platform', organizationName: 'UnlikeOtherAI' }])
  const names = new TeamNames(claim.transport, () => now)
  assert.equal(await names.learn({ teamLabel: null, organizationName: null }), null, 'a failed read is quiet')
  now += 30 * 60 * 1000
  assert.equal(await names.learn({ teamLabel: null, organizationName: null }), null, 'not again within the hour')
  assert.equal(claim.asked(), 1)
  now += 31 * 60 * 1000
  assert.deepEqual(await names.learn({ teamLabel: null, organizationName: null }),
    { teamLabel: 'Platform', organizationName: 'UnlikeOtherAI' })
  now += 2 * 60 * 60 * 1000
  assert.equal(await names.learn({ teamLabel: 'Platform', organizationName: 'UnlikeOtherAI' }), null, 'known names stay')
  assert.equal(claim.asked(), 2)
})

test('a new start reads the names again, so a renamed team shows its new name', async () => {
  const claim = claims([{ teamName: 'Platform team', organizationName: 'UnlikeOtherAI' }])
  const names = new TeamNames(claim.transport, () => 0)
  assert.deepEqual(await names.learn({ teamLabel: 'Platform', organizationName: 'UnlikeOtherAI' }),
    { teamLabel: 'Platform team', organizationName: 'UnlikeOtherAI' })
})

test('a new team folder takes the handshake\'s names, and the claim\'s organisation only when Nessie sent none', async () => {
  const claim = claims([{ teamName: 'Platform', organizationName: 'From the claim' }])
  const names = new TeamNames(claim.transport, () => 0)
  const handshake = { teamLabel: 'Platform', organizationName: 'UnlikeOtherAI' } as Parameters<TeamNames['forNewFolder']>[0]
  assert.deepEqual(await names.forNewFolder(handshake), { teamName: 'Platform', organizationName: 'UnlikeOtherAI' })
  assert.equal(claim.asked(), 0)
  const older = { teamLabel: 'Platform' } as Parameters<TeamNames['forNewFolder']>[0]
  assert.deepEqual(await names.forNewFolder(older), { teamName: 'Platform', organizationName: 'From the claim' })
})
