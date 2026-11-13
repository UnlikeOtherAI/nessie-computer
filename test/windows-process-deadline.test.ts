import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { createCodingProcessControl, powershellExchange, WINDOWS_KILL } from '../src/coding-session/process-control.js'

test('Windows: process termination enforces a supplied deadline before killing the held identity', {
  skip: process.platform !== 'win32' ? 'Windows only' : false, timeout: 30_000,
}, async context => {
  for (const expired of [true, false]) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
      stdio: 'ignore', windowsHide: true,
    })
    try {
      const identity = await createCodingProcessControl('win32', {}).identify(child.pid!)
      assert.ok(identity?.startedAt)
      const exchange = powershellExchange(WINDOWS_KILL, () => [
        `${identity.pid} ${identity.startedAt} ${Date.now() + (expired ? -1 : 5000)}`,
      ])
      assert.equal(await exchange.done, !expired)
      if (expired) assert.doesNotThrow(() => process.kill(child.pid!, 0), 'expired input must leave its target alive')
      else {
        if (child.exitCode === null && child.signalCode === null) await once(child, 'exit', { signal: context.signal })
        assert.throws(() => process.kill(child.pid!, 0), 'the current deadline must execute the actual kill branch')
      }
    } finally { child.kill() }
  }
})
