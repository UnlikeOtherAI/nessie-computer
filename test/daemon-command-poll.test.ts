import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import test from 'node:test'

import {
  canonicalExecutorPayload,
  ExecutorDaemonCommandPollRequestSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { ExecutorApiError, type ExecutorApiClient } from '../src/api-client.js'
import type { CommandDispatcher } from '../src/command-dispatcher.js'
import { concurrentPollRefused, createDaemonCommandPoll } from '../src/daemon-command-poll.js'

const keys = generateKeyPairSync('ed25519')
const state = {
  apiBaseUrl: 'https://api.example.test', connectionEpoch: '7', executorId: '00000000-0000-4000-8000-00000000e001',
  machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
}
const command = {
  argumentDigest: `sha256:${'3'.repeat(64)}`, bindingFence: '1', bindingId: '00000000-0000-4000-8000-00000000e002',
  capabilityRevision: 1, commandId: '00000000-0000-4000-8000-00000000e003', expiresAt: '2099-01-01T00:00:00.000Z',
  idempotencyKey: 'poll-test', operationKey: 'file.read', payload: { args: { path: 'a' }, runId: '00000000-0000-4000-8000-00000000e004' },
} as ExecutorCommandEnvelope
const target = {
  argumentDigest: command.argumentDigest, bindingFence: '1', bindingId: command.bindingId, capabilityRevision: 1,
  commandId: command.commandId, expiresAt: command.expiresAt, idempotencyKey: command.idempotencyKey,
}

const fakeDispatcher = (held = 0) => {
  const calls: string[] = []
  const accepted: ExecutorCommandEnvelope[] = []
  let mode = 'concurrent'
  const dispatcher: Pick<CommandDispatcher, 'accept' | 'activeCommands' | 'cancel' | 'capacity' | 'closeSessions'
    | 'held' | 'setMode' | 'stoppedSessions' | 'waiting'> = {
    accept: async (commands) => { accepted.push(...commands); calls.push(`accept ${commands.length}`) },
    activeCommands: () => (held ? [target as never] : []),
    cancel: (cancellations) => { calls.push(`cancel ${cancellations.length}`) },
    capacity: () => ({ file: 16, program: 4, coding: 2, browser: 2, mcp: 8 }),
    closeSessions: (closes) => { calls.push(`close ${closes.length}`) },
    held: () => held,
    setMode: (next) => { mode = next },
    stoppedSessions: () => (held ? ['00000000-0000-4000-8000-00000000e005'] : []),
    waiting: () => (held ? [{ commandId: command.commandId, for: 'owner' as const }] : []),
  }
  return { accepted, calls, dispatcher, mode: () => mode }
}

const verifies = (domain: string, request: Record<string, unknown>): boolean => {
  const { signature, ...payload } = request
  return verify(null, Buffer.from(canonicalExecutorPayload(`nessie.executor.daemon.${domain}.v1`, payload)),
    keys.publicKey, Buffer.from(String(signature), 'base64url'))
}

test('the concurrent poll signs every field it sends and hands the answer to the dispatcher', async () => {
  const fake = fakeDispatcher(1)
  const sent: Record<string, unknown>[] = []
  const api: Pick<ExecutorApiClient, 'pollCommand'> = {
    pollCommand: async (_url, request) => {
      sent.push(request as Record<string, unknown>)
      return {
        cancellations: [{ ...target, requestedAt: new Date().toISOString() }],
        commands: [command],
        sessionClose: [{ sessionId: '00000000-0000-4000-8000-00000000e005', reason: 'owner_stopped' }],
      } as never
    },
  }
  await createDaemonCommandPoll({ state: () => state, dispatcher: fake.dispatcher, api, log: () => undefined }).poll()

  const [request] = sent
  assert.ok(request)
  assert.equal(request.concurrency, 1)
  assert.deepEqual(request.activeCommands, [target])
  assert.deepEqual(request.waiting, [{ commandId: command.commandId, for: 'owner' }])
  assert.deepEqual(request.stoppedSessions, ['00000000-0000-4000-8000-00000000e005'])
  assert.equal('activeCommand' in request, false)
  assert.ok(verifies('poll', request), 'signed in the poll domain over every field')
  assert.ok(ExecutorDaemonCommandPollRequestSchema.safeParse(request).success, 'Nessie\'s schema reads it')
  assert.deepEqual(fake.calls, ['cancel 1', 'close 1', 'accept 1'])
  assert.equal(fake.mode(), 'concurrent')
})

test('an idle concurrent poll leaves out waiting and stoppedSessions, so they are not in the signed payload', async () => {
  const fake = fakeDispatcher(0)
  let sent: Record<string, unknown> | undefined
  await createDaemonCommandPoll({
    state: () => state, dispatcher: fake.dispatcher, log: () => undefined,
    api: {
      pollCommand: async (_url, request) => {
        sent = request as never
        return { cancellations: [], commands: [], sessionClose: [] } as never
      },
    },
  }).poll()
  assert.deepEqual(Object.keys(sent ?? {}).sort(), [
    'activeCommands', 'capacity', 'concurrency', 'connectionEpoch', 'executorId', 'observedAt', 'signature',
  ])
})

test('a Nessie that refuses the concurrent fields gets the old poll, one command at a time, for that connection', async () => {
  const fake = fakeDispatcher(0)
  const sent: Record<string, unknown>[] = []
  const logged: string[] = []
  const api: Pick<ExecutorApiClient, 'pollCommand'> = {
    pollCommand: async (_url, request) => {
      sent.push(request as Record<string, unknown>)
      if ('concurrency' in request) {
        throw new ExecutorApiError('Request validation failed.', {
          code: 'VALIDATION_ERROR', details: [{ message: 'Unrecognized key(s) in object: \'activeCommands\', \'capacity\', \'concurrency\'' }],
          status: 400,
        })
      }
      return { command } as never
    },
  }
  const poll = createDaemonCommandPoll({
    state: () => state, dispatcher: fake.dispatcher, api, log: (message) => { logged.push(message) },
  })
  await poll.poll()
  assert.equal(sent.length, 2)
  assert.deepEqual(Object.keys(sent[1]!).sort(), ['connectionEpoch', 'executorId', 'observedAt', 'signature'])
  assert.ok(verifies('poll', sent[1]!))
  assert.deepEqual(fake.accepted, [command])
  assert.equal(fake.mode(), 'single')
  assert.equal(poll.single(), true)
  assert.equal(logged.length, 1)

  await poll.poll()
  assert.equal(sent.length, 3, 'it stays on the old shape for this connection')
  assert.equal('concurrency' in sent[2]!, false)
})

test('the old poll waits while a command is held, and a new connection tries the concurrent shape again', async () => {
  let epoch = '7'
  const fake = fakeDispatcher(1)
  const sent: Record<string, unknown>[] = []
  const poll = createDaemonCommandPoll({
    state: () => ({ ...state, connectionEpoch: epoch }), dispatcher: fake.dispatcher, log: () => undefined,
    api: { pollCommand: async (_url, request) => { sent.push(request as never); return { command: null } as never } },
  })
  await poll.poll()
  assert.equal(poll.single(), true, 'a 200 in the old shape is an older Nessie too')
  await poll.poll()
  assert.equal(sent.length, 1, 'the held command watches its own cancellation; no second poll')
  epoch = '8'
  await poll.poll()
  assert.equal(sent.at(-1)?.concurrency, 1)
})

test('only a validation refusal naming a concurrent field reads as an older Nessie', () => {
  const refusal = (message: string, status = 400, code = 'VALIDATION_ERROR') => new ExecutorApiError(message, { code, status })
  assert.equal(concurrentPollRefused(refusal('Unrecognized key(s) in object: \'concurrency\'')), true)
  assert.equal(concurrentPollRefused(refusal('Unrecognized key(s) in object: \'activeCommandsX\'')), false)
  assert.equal(concurrentPollRefused(refusal('concurrency', 401, 'EXECUTOR_SIGNATURE_INVALID')), false)
  assert.equal(concurrentPollRefused(new Error('concurrency')), false)
})
