import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  ExecutorEnrollmentRequestSchema,
  ExecutorCommandCancellationTargetSchema,
  type ExecutorCommandEnvelope,
  type ExecutorOperationKey,
} from '@nessie/executor-protocol'

import { serveExecutor } from '../src/daemon-server.js'
import { claimExecutor, heartbeatExecutor } from '../src/daemon.js'
import { pairExecutor } from '../src/pair.js'
import { loadExecutorState } from '../src/state-store.js'

const EXECUTOR_ID = '00000000-0000-4000-8000-000000000601'
const ENROLLMENT_ID = '00000000-0000-4000-8000-000000000602'
const BINDING_ID = '00000000-0000-4000-8000-000000000603'
const RUN_ID = '00000000-0000-4000-8000-000000000604'
const CHALLENGE = 'control-plane-e2e-challenge-0000000000000000'
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const windowsDevelopmentRun = process.platform === 'win32'
  && process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1'
const packagedWindowsRun = process.platform === 'win32'
  && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'

const sha256 = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const commandFor = (
  index: number,
  operationKey: ExecutorOperationKey,
  args: Record<string, unknown>,
): ExecutorCommandEnvelope => {
  const payload = { args, runId: RUN_ID }
  return {
    argumentDigest: sha256(canonicalExecutorJson(payload)) as ExecutorCommandEnvelope['argumentDigest'],
    bindingFence: String(index + 1),
    bindingId: BINDING_ID,
    capabilityRevision: 1,
    commandId: `00000000-0000-4000-8000-${String(610 + index).padStart(12, '0')}`,
    expiresAt: '2099-09-04T00:00:00.000Z',
    idempotencyKey: `control-plane-e2e-${index}`,
    operationKey,
    payload,
  }
}

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  return parsed as Record<string, unknown>
}

const send = (response: ServerResponse, data: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(status === 200 ? { data } : { error: data }))
}

const machineKey = (rawPublicKey: string): KeyObject => createPublicKey({
  format: 'der',
  key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey, 'base64url')]),
  type: 'spki',
})

const assertSignature = (
  key: KeyObject,
  domain: string,
  payload: Record<string, unknown>,
  signature: unknown,
): void => {
  assert.equal(typeof signature, 'string')
  assert.equal(verify(
    null,
    Buffer.from(canonicalExecutorPayload(domain, payload)),
    key,
    Buffer.from(signature, 'base64url'),
  ), true)
}

test('pairing, signed control traffic, and selected-folder enforcement work end to end', {
  skip: windowsDevelopmentRun
    ? 'Windows folder ACL verification runs through the packaged runtime in desktop-windows.yml.'
    : false,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'nessie-e2e-workspace-'))
  const outside = await mkdtemp(join(tmpdir(), 'nessie-e2e-outside-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-e2e-state-'))
  await writeFile(join(workspace, 'visible.txt'), 'selected folder')
  await writeFile(join(outside, 'secret.txt'), 'outside folder')

  const commands = [
    commandFor(0, 'file.read', { path: 'workspace/visible.txt' }),
    commandFor(1, 'file.read', { path: 'workspace/../secret.txt' }),
    commandFor(2, 'file.write', { content: 'draft only', path: 'workspace/draft.txt' }),
    commandFor(3, 'workspace.review', {}),
  ]
  const results: Record<string, unknown>[] = []
  let publicKey: KeyObject | undefined
  let connectionEpoch = '0'
  let daemonChallenge = ''
  let daemonChallengeCounter = 0
  let commandIndex = 0
  let serverFailure: unknown
  let resolveComplete: (() => void) | undefined
  const complete = new Promise<void>((resolve) => { resolveComplete = resolve })

  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request)
      const path = request.url
      if (path === '/api/executor-enrollments/submit') {
        const enrollment = ExecutorEnrollmentRequestSchema.parse(body)
        publicKey = machineKey(enrollment.machinePublicKey)
        const descriptorDigest = sha256(canonicalExecutorJson(enrollment.descriptor.descriptor))
        assertSignature(publicKey, 'nessie.executor.enrollment.v1', {
          challenge: enrollment.challenge,
          descriptorDigest,
          enrollmentId: enrollment.enrollmentId,
          machinePublicKey: enrollment.machinePublicKey,
        }, enrollment.proof)
        send(response, { executorId: EXECUTOR_ID, fingerprint: sha256(enrollment.machinePublicKey) })
        return
      }
      assert(publicKey)
      if (path === '/api/executor-daemon/challenge') {
        assert.equal(body.executorId, EXECUTOR_ID)
        daemonChallengeCounter += 1
        daemonChallenge = `${'d'.repeat(80)}.${String(daemonChallengeCounter).padStart(64, '0')}`
        send(response, { challenge: daemonChallenge, expiresAt: '2099-09-04T00:00:00.000Z' })
        return
      }
      if (path === '/api/executor-daemon/claim') {
        assert.equal(body.challenge, daemonChallenge)
        assertSignature(publicKey, 'nessie.executor.daemon.claim.v1', {
          challenge: body.challenge,
          executorId: body.executorId,
        }, body.signature)
        daemonChallenge = ''
        connectionEpoch = String(Number(connectionEpoch) + 1)
        send(response, { connectionEpoch, status: 'online' })
        return
      }
      if (path === '/api/executor-daemon/descriptor') {
        const signed = body.descriptor as Record<string, unknown>
        assertSignature(
          publicKey,
          'nessie.executor.descriptor.v1',
          signed.descriptor as Record<string, unknown>,
          signed.signature,
        )
        const revision = (signed.descriptor as { revision: number }).revision
        for (const command of commands) command.capabilityRevision = revision
        send(response, { reviewStatus: 'approved', revision })
        return
      }
      if (path === '/api/executor-daemon/session-views') {
        const { signature, ...payload } = body
        assertSignature(publicKey, 'nessie.executor.daemon.session_view.v1', payload, signature)
        send(response, { requests: [] })
        return
      }
      if (path === '/api/executor-daemon/heartbeat') {
        assert.equal(body.connectionEpoch, connectionEpoch)
        // Verify the exact transmitted body, including signed software status.
        const { signature, ...payload } = body
        assertSignature(publicKey, 'nessie.executor.daemon.heartbeat.v1', payload, signature)
        send(response, { connectionEpoch, status: 'online' })
        return
      }
      if (path === '/api/executor-daemon/commands/poll') {
        assert.equal(body.connectionEpoch, connectionEpoch)
        if (body.activeCommand) {
          const { signature, ...payload } = body
          assertSignature(publicKey, 'nessie.executor.daemon.cancel.v1', payload, signature)
          assert.deepEqual(ExecutorCommandCancellationTargetSchema.parse(body.activeCommand),
            ExecutorCommandCancellationTargetSchema.strip().parse(commands.find(command =>
              command.commandId === (body.activeCommand as { commandId: string }).commandId)))
          send(response, { command: null, cancellation: null })
          return
        }
        assertSignature(publicKey, 'nessie.executor.daemon.poll.v1', {
          connectionEpoch,
          executorId: body.executorId,
          observedAt: body.observedAt,
        }, body.signature)
        send(response, { command: commands[commandIndex] ?? null })
        return
      }
      if (path === '/api/executor-daemon/commands/receipt') {
        const receipt = body.receipt as Record<string, unknown>
        assert.equal(body.connectionEpoch, connectionEpoch)
        assertSignature(publicKey, 'nessie.executor.daemon.receipt.v1', {
          connectionEpoch,
          executorId: body.executorId,
          receipt,
        }, body.signature)
        if (receipt.state === 'result_acknowledged') {
          const result = body.result as Record<string, unknown>
          assert.equal(receipt.resultDigest, sha256(canonicalExecutorJson(result)))
          results.push(result)
          commandIndex += 1
          if (commandIndex === commands.length) resolveComplete?.()
        }
        send(response, { recorded: true })
        return
      }
      send(response, { code: 'NOT_FOUND', message: 'Unexpected executor test route.' }, 404)
    } catch (error) {
      serverFailure = error
      send(response, { code: 'TEST_SERVER_FAILED', message: String(error) }, 500)
      resolveComplete?.()
    }
  })

  const liveness = new PassThrough()
  let daemon: Promise<void> | undefined
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const apiBaseUrl = `http://127.0.0.1:${address.port}`

    await pairExecutor({
      apiBaseUrl,
      challenge: CHALLENGE,
      enrollmentId: ENROLLMENT_ID,
      stateDir,
      workspaceFolders: [{ name: 'workspace', path: workspace }],
    })
    const paired = await loadExecutorState(stateDir)
    const claimed = await claimExecutor(stateDir, paired)
    await heartbeatExecutor(claimed)

    await writeFile(join(stateDir, 'existing-coding-sessions.json'), JSON.stringify({ enabled: false }))
    daemon = serveExecutor(stateDir, claimed, { parentLiveness: liveness, runtime: {
      entry: packagedWindowsRun ? join(dirname(process.execPath), 'nessie-executor.cjs')
        : fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      execArgv: packagedWindowsRun ? [] : ['--import', 'tsx'],
      execPath: process.execPath, packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
    } })
    const timeout = setTimeout(() => resolveComplete?.(), 12_000)
    await complete
    clearTimeout(timeout)
    if (serverFailure) throw serverFailure
    assert.equal(commandIndex, commands.length, 'daemon did not finish every command before the deadline')

    assert.deepEqual(results[0], {
      byteCount: 15,
      content: 'selected folder',
      path: 'workspace/visible.txt',
      success: true,
      truncated: false,
    })
    assert.deepEqual(results[1], { code: 'EXECUTOR_WORKSPACE_DENIED', success: false })
    assert.deepEqual(results[2], { byteCount: 10, path: 'workspace/draft.txt', success: true })
    assert.equal(results[3]?.success, true)
    assert.equal(results[3]?.changeCount, 1)
    await assert.rejects(readFile(join(workspace, 'draft.txt'), 'utf8'), { code: 'ENOENT' })
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside folder')
  } finally {
    liveness.end()
    await daemon?.catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(workspace, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})
