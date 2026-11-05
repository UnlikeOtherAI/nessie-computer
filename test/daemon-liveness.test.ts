import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  createNonOverlappingExecutorTask,
  waitForExecutorDaemonShutdown,
} from '../src/daemon.js'

test('a desktop parent-liveness pipe stops the daemon when its parent closes', async () => {
  const parentLiveness = new PassThrough()
  const stopped = waitForExecutorDaemonShutdown(parentLiveness)
  parentLiveness.end()
  await stopped
  assert.equal(parentLiveness.readableEnded, true)
})

// The menu bar app stops its daemon with SIGTERM and keeps the pipe's write end
// until the daemon exits. A resumed pipe left open held the stopped daemon's
// process alive forever: no heartbeat, "Offline" in Nessie, and an app that
// would not start another daemon while that process still ran.
test('a daemon stopped by a signal exits while its parent still holds the liveness pipe', {
  skip: process.platform === 'win32' ? 'Windows has no catchable SIGTERM.' : false,
}, async () => {
  const daemon = new URL('../src/daemon.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { waitForExecutorDaemonShutdown } = await import(${JSON.stringify(daemon)})
    const stopped = waitForExecutorDaemonShutdown(process.stdin)
    process.stdout.write('ready\\n')
    await stopped
  `], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = once(child, 'exit')
  try {
    await once(child.stdout, 'data')
    child.kill('SIGTERM')
    const deadline = new Promise<'still running'>((resolve) => { setTimeout(() => resolve('still running'), 5_000).unref() })
    const outcome = await Promise.race([exited, deadline])
    assert.deepEqual(outcome, [0, null])
  } finally {
    child.stdin.end()
    child.kill('SIGKILL')
  }
})

test('client-recovery: a slow heartbeat cannot overlap its next scheduled run', async () => {
  let release: (() => void) | undefined
  let calls = 0
  const task = createNonOverlappingExecutorTask(async () => {
    calls += 1
    await new Promise<void>((resolve) => { release = resolve })
  })

  const first = task.run()
  const second = task.run()
  assert.equal(first, second)
  assert.equal(calls, 1)
  release?.()
  await first

  const third = task.run()
  assert.notEqual(third, first)
  assert.equal(calls, 2)
  release?.()
  await third
})
