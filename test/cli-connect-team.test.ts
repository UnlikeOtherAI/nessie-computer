import assert from 'node:assert/strict'
import test from 'node:test'
import { connectTeam } from '../src/cli-connect-team.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const saved = { connectionEpoch: '4' } as unknown as ExecutorLocalState
const claimed = { connectionEpoch: '5' } as unknown as ExecutorLocalState

// 9 November, Mac: `connect` left its local inference host session open, so
// the command never exited and the app, which waits for it before `serve`,
// never started the team. `connect` ends; the daemon owns the socket.
test('connect claims, reports a pause, registers the local host and closes its session', async () => {
  const calls: string[] = []
  let open = false
  await connectTeam('/state/team', saved, {
    claim: async (stateDir, state) => {
      calls.push(`claim ${stateDir} ${state.connectionEpoch}`)
      return claimed
    },
    reportPause: async (_stateDir, live) => { calls.push(`pause ${live.connectionEpoch}`) },
    connectLocal: async (_stateDir, live) => {
      calls.push(`local ${live.connectionEpoch}`)
      open = true
      return { session: { stop: async () => { calls.push('stop'); open = false } } }
    },
  })
  assert.deepEqual(calls, ['claim /state/team 4', 'pause 5', 'local 5', 'stop'])
  assert.equal(open, false, 'nothing keeps the command running')
})

test('a refused claim registers nothing and opens no session', async () => {
  let registered = false
  await assert.rejects(connectTeam('/state/team', saved, {
    claim: async () => { throw new Error('Executor connection is fenced.') },
    reportPause: async () => { throw new Error('not reached') },
    connectLocal: async () => {
      registered = true
      return { session: { stop: async () => undefined } }
    },
  }), /fenced/)
  assert.equal(registered, false)
})
