import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

test('the real CLI reports a failed command and flushes before exiting', async () => {
  const bodies: string[] = []
  const collector = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { bodies.push(body); response.writeHead(200).end('{}') })
  })
  await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve))
  const address = collector.address()
  assert.ok(address && typeof address !== 'string')
  const scratch = resolve('.artifacts')
  await mkdir(scratch, { recursive: true })
  const state = await mkdtemp(resolve(scratch, 'nessie-reporting-'))
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/index.ts'),
      'describe', '--state-dir', state], {
      env: { ...process.env, NESSIE_COMPUTER_SENTRY_DSN: 'http://public@127.0.0.1:' + address.port + '/1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.equal(code, 1, stderr)
    assert.ok(stderr.length > 0, 'The original command failure is still shown')
    assert.ok(bodies.some(body => body.includes('"exception"')), 'A real exception reached the collector')
  } finally {
    await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()))
    assert.equal(dirname(resolve(state)), scratch)
    await rm(state, { recursive: true, force: true })
  }
})
