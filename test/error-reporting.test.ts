import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

const invoke = (args: string[], dsn: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/index.ts'), ...args], {
      env: { ...process.env, NESSIE_COMPUTER_SENTRY_DSN: dsn,
        SENTRY_RELEASE: 'nessie-computer@reporting-test', SENTRY_TRACES_SAMPLE_RATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolveResult({ code, stdout, stderr }))
  })

test('the real CLI reports failed commands without reporting ordinary use or changing stdout', async () => {
  const bodies: string[] = []
  const collector = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { bodies.push(body); response.writeHead(200).end('{}') })
  })
  await new Promise<void>(resolveReady => collector.listen(0, '127.0.0.1', resolveReady))
  const address = collector.address()
  assert.ok(address && typeof address !== 'string')
  const dsn = 'http://public@127.0.0.1:' + address.port + '/1'
  const scratch = resolve('.artifacts')
  await mkdir(scratch, { recursive: true })
  const state = await mkdtemp(resolve(scratch, 'nessie-reporting-'))
  try {
    const version = await invoke(['--version'], dsn)
    assert.equal(version.code, 0, version.stderr)
    assert.ok(version.stdout.length > 0)
    const help = await invoke(['--help'], dsn)
    assert.equal(help.code, 0, help.stderr)
    assert.ok(help.stdout.length > 0)
    assert.equal(bodies.length, 0, 'Ordinary CLI use is not product analytics')
    const failure = await invoke(['describe', '--state-dir', state], dsn)
    assert.equal(failure.code, 1, failure.stderr)
    assert.equal(failure.stdout, '')
    assert.ok(failure.stderr.length > 0, 'The original command failure is still shown')
    assert.ok(bodies.some(body => body.includes('"exception"')),
      'A real exception reached the collector; stderr: ' + failure.stderr)
    const itemTypes = bodies.flatMap(body => body.split('\n').filter((_, index) => index % 2 === 1)
      .map(line => (JSON.parse(line) as { type: string }).type))
    assert.ok(itemTypes.length > 0, 'The collector received at least one envelope item')
    assert.ok(itemTypes.every(type => ['event', 'client_report'].includes(type)),
      'CLI telemetry contains only errors and delivery outcomes: ' + itemTypes.join(', '))
  } finally {
    await new Promise<void>((resolveClosed, reject) => {
      collector.close(error => error ? reject(error) : resolveClosed())
    })
    assert.equal(dirname(resolve(state)), scratch)
    await rm(state, { recursive: true, force: true })
  }
})
