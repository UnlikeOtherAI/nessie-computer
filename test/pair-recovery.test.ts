import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorEnrollmentRequest } from '@nessie/executor-protocol'

import { pairExecutor, type PairExecutorInput } from '../src/pair.js'
import type {
  ExecutorLocalState,
  ExecutorPreparedPairing,
} from '../src/state-store.js'

test('client-recovery: durable enrollment preparation reuses its key after response loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-pair-recovery-'))
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot)
  const input: PairExecutorInput = {
    apiBaseUrl: 'https://api.example.test',
    challenge: Buffer.alloc(32, 7).toString('base64url'),
    enrollmentId: '00000000-0000-4000-8000-000000000601',
    stateDir: join(root, 'state'),
    workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
  }
  let prepared: ExecutorPreparedPairing | null = null
  let savedState: ExecutorLocalState | null = null
  let submitAttempts = 0
  const submitted: ExecutorEnrollmentRequest[] = []
  const events: string[] = []
  const dependencies = {
    clearPrepared: async () => {
      events.push('clear-prepared')
      prepared = null
    },
    loadPrepared: async () => prepared,
    savePrepared: async (_stateDir: string, value: ExecutorPreparedPairing) => {
      events.push('save-prepared')
      prepared = structuredClone(value)
    },
    saveState: async (_stateDir: string, state: ExecutorLocalState) => {
      events.push('save-state')
      savedState = structuredClone(state)
    },
    submitEnrollment: async (_baseUrl: string, request: ExecutorEnrollmentRequest) => {
      events.push('submit')
      submitAttempts += 1
      submitted.push(structuredClone(request))
      if (submitAttempts === 1) throw new Error('enrollment response lost')
      return {
        executorId: '00000000-0000-4000-8000-000000000602',
        fingerprint: `sha256:${'2'.repeat(64)}`,
      }
    },
  }

  try {
    await assert.rejects(pairExecutor(input, dependencies), /enrollment response lost/)
    assert.deepEqual(events, ['save-prepared', 'submit'])
    assert.ok(prepared)
    const preparedPrivateKey = prepared.machinePrivateKey

    await pairExecutor(input, dependencies)
    assert.equal(submitAttempts, 2)
    assert.deepEqual(submitted[1], submitted[0])
    assert.equal(savedState?.machinePrivateKey, preparedPrivateKey)
    assert.deepEqual(events, ['save-prepared', 'submit', 'submit', 'save-state', 'clear-prepared'])
    assert.equal(prepared, null)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('client-recovery: unfinished pairing rejects different enrollment input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-pair-recovery-mismatch-'))
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot)
  let submitted = false
  let prepared: ExecutorPreparedPairing | null = null
  const input: PairExecutorInput = {
    apiBaseUrl: 'https://api.example.test',
    challenge: Buffer.alloc(32, 9).toString('base64url'),
    enrollmentId: '00000000-0000-4000-8000-000000000611',
    stateDir: join(root, 'state'),
    workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
  }
  const dependencies = {
    clearPrepared: async () => undefined,
    loadPrepared: async () => prepared,
    savePrepared: async (_stateDir: string, value: ExecutorPreparedPairing) => {
      prepared = structuredClone(value)
    },
    saveState: async () => undefined,
    submitEnrollment: async () => {
      submitted = true
      throw new Error('hold unfinished pairing')
    },
  }

  try {
    await assert.rejects(pairExecutor(input, dependencies), /hold unfinished pairing/)
    submitted = false
    await assert.rejects(pairExecutor({
      ...input,
      challenge: Buffer.alloc(32, 8).toString('base64url'),
    }, dependencies), /different unfinished pairing/)
    assert.equal(submitted, false)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('service promotion keeps the signed preparation across successful CLI exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-pair-promotion-'))
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot)
  const input: PairExecutorInput = { apiBaseUrl: 'https://api.example.test',
    challenge: Buffer.alloc(32, 7).toString('base64url'), enrollmentId: '00000000-0000-4000-8000-000000000601',
    stateDir: join(root, 'state'), workspaceFolders: [{ name: 'workspace', path: workspaceRoot }], retainPrepared: true }
  let prepared: ExecutorPreparedPairing | null = null
  const requests: ExecutorEnrollmentRequest[] = []
  const states: ExecutorLocalState[] = []
  const dependencies = {
    clearPrepared: async () => assert.fail('Only the service may clear preparation after promotion'),
    loadPrepared: async () => prepared,
    savePrepared: async (_directory: string, value: ExecutorPreparedPairing) => { prepared = structuredClone(value) },
    saveState: async (_directory: string, value: ExecutorLocalState) => { states.push(structuredClone(value)) },
    submitEnrollment: async (_origin: string, request: ExecutorEnrollmentRequest) => {
      requests.push(structuredClone(request))
      return { executorId: '00000000-0000-4000-8000-000000000602', fingerprint: `sha256:${'2'.repeat(64)}` }
    },
  }
  try {
    const first = await pairExecutor(input, dependencies)
    // The service can crash after the CLI saved state but before its stdout or
    // staging directory was promoted. A new process submits the same proof.
    assert.deepEqual(await pairExecutor(input, dependencies), first)
    assert.deepEqual(requests[1], requests[0])
    assert.equal(states[1]?.machinePrivateKey, states[0]?.machinePrivateKey)
    assert.ok(prepared)
  } finally { await rm(root, { force: true, recursive: true }) }
})
