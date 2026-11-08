import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { offerUpdateAtLaunch } from '../src/updates/cli.js'
import type { ExecutorLocalUpdateStatus } from '@nessie/executor-protocol'

const available: ExecutorLocalUpdateStatus = {
  format: 1, installedVersion: '1.0.2', availableVersion: '1.0.3', automatic: false,
  channel: 'stable', phase: 'available', canInstall: true, notify: true,
}

test('a stalled launch check never delays the command or consumes a terminal answer', async () => {
  let settle!: (value: ExecutorLocalUpdateStatus) => void
  const output: string[] = []
  const check = new Promise<ExecutorLocalUpdateStatus>(resolve => { settle = resolve })
  assert.equal(offerUpdateAtLaunch(['teams'], { terminal: true, check: () => check, write: text => { output.push(text) } }), undefined)
  assert.deepEqual(output, [])
  settle(available)
  await setImmediate()
  assert.equal(output.length, 1)
  assert.ok(output[0]!.includes('1.0.3'))
  assert.ok(output[0]!.includes('nessie-executor updates install'))
  assert.ok(output[0]!.includes('nessie-executor updates remind'))
})

test('machine launches and explicit JSON commands never start an offer', () => {
  const check = async () => { assert.fail('Machine command started an update check') }
  offerUpdateAtLaunch(['connect'], { terminal: false, check })
  offerUpdateAtLaunch(['teams', '--json'], { terminal: true, check })
})

test('coordinator failure and an already active update do not change ordinary output', async () => {
  const write = () => { assert.fail('Unexpected launch notice') }
  offerUpdateAtLaunch(['teams'], { terminal: true, check: async () => { throw new Error('offline') }, write })
  offerUpdateAtLaunch(['teams'], { terminal: true, check: async () => ({ ...available, phase: 'downloading' }), write })
  offerUpdateAtLaunch(['teams'], { terminal: true, check: async () => ({ ...available, notify: false }), write })
  await setImmediate()
})
