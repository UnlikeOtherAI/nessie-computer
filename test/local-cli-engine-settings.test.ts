import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, createPublicKey, verify } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalExecutorPayload } from '@nessie/executor-protocol'

import {
  addLocalCliAccount, findLocalCliAccount, localCliAccountDirectory, readLocalCliAccounts,
} from '../src/local-cli-engine-accounts.js'
import { applyLocalCliEngineOperation, localCliEngineRows } from '../src/local-cli-engine-cli.js'
import { codexAccountStatus, detectLocalCliEngines, type LocalCliProbes } from '../src/local-cli-engine-detect.js'
import { registerLocalCliHost } from '../src/local-cli-engine-host.js'
import { createLocalCliEngineManager } from '../src/local-cli-engine-manager.js'
import { readLocalCliStatus, setLocalCliAvailability, writeLocalCliStatus } from '../src/local-cli-engine-settings.js'
import { LocalInferenceApiError } from '../src/local-inference-api.js'
import type { LocalInferenceHostSession } from '../src/local-inference-host-session.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import type { ExecutorLocalState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/** Claude Code is not installed; Codex is, signed in by default and signed out in any added account. */
const probes = (installed: { claude?: boolean } = {}): LocalCliProbes => ({
  findProgram: async (engine) => engine === 'codex' || installed.claude
    ? { path: `/opt/${engine}`, version: '1.0.0' } : undefined,
  claudeStatus: async () => ({ signedIn: true, account: 'person@example.com' }),
  codexStatus: async (_program, env) => env.CODEX_HOME ? { signedIn: false } : { signedIn: true, account: 'me@example.com' },
})

const folders = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-cli-engines-'))
  const [teamA, teamB, accounts] = await Promise.all(['team-a', 'team-b', 'accounts'].map((name) =>
    ensureOwnerOnlyStateDirectory(join(root, name))))
  const done = () => rm(root, { recursive: true, force: true })
  return { root, teamA: teamA!, teamB: teamB!, accounts: accounts!, done }
}

test('detection reports installed, signed in and the account, for each account', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const dirs = await folders()
  try {
    const work = await addLocalCliAccount('codex', 'Work', dirs.accounts)
    const found = await detectLocalCliEngines({ accounts: [work], accountsRoot: dirs.accounts, env: {},
      probes: probes() })
    const row = (engine: string, profileId: string | null) =>
      found.find((entry) => entry.engine === engine && entry.profileId === profileId)!
    assert.deepEqual([row('claude-code', null).installed, row('claude-code', null).signedIn], [false, false])
    assert.deepEqual([row('codex', null).installed, row('codex', null).signedIn, row('codex', null).account],
      [true, true, 'me@example.com'])
    assert.equal(row('codex', work.id).signedIn, false)
    assert.equal(row('codex', work.id).env.CODEX_HOME, localCliAccountDirectory(dirs.accounts, work.id))
    assert.equal(row('codex', null).env.CODEX_HOME, undefined)
  } finally { await dirs.done() }
})

test('Codex is signed in when its own login status says so; the account name is optional', async () => {
  const ran: string[][] = []
  const run = (code: number) => async (_file: string, args: string[]) => {
    ran.push(args)
    return { code, missing: false, stdout: code === 0 ? 'Logged in using ChatGPT' : 'Not logged in' }
  }
  assert.deepEqual(await codexAccountStatus('/opt/codex', {}, run(1)), { signedIn: false })
  // A program that cannot answer account/read still counts as signed in.
  assert.deepEqual(await codexAccountStatus(process.execPath, {}, run(0)), { signedIn: true })
  assert.deepEqual(ran, [['login', 'status'], ['login', 'status']])
})

test('Make available is per team, and only for an installed program', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const dirs = await folders()
  try {
    const deps = { accountsRoot: dirs.accounts, env: {}, probes: probes() }
    const on = await applyLocalCliEngineOperation(dirs.teamA,
      { operation: 'set', engine: 'codex', profileId: null, available: true }, deps)
    assert.equal(on.find((row) => row.engine === 'codex')?.available, true)
    assert.equal(on.find((row) => row.engine === 'codex')?.offered, 'not_yet')
    const other = await localCliEngineRows(dirs.teamB, deps)
    assert.equal(other.find((row) => row.engine === 'codex')?.available, false)
    assert.equal(other.find((row) => row.engine === 'codex')?.offered, 'no')
    await writeLocalCliStatus(dirs.teamA, { codex: 'yes' })
    assert.equal((await localCliEngineRows(dirs.teamA, deps)).find((row) => row.engine === 'codex')?.offered, 'yes')
    await assert.rejects(applyLocalCliEngineOperation(dirs.teamA,
      { operation: 'set', engine: 'claude-code', profileId: null, available: true }, deps), /not installed/u)
    const off = await applyLocalCliEngineOperation(dirs.teamA,
      { operation: 'set', engine: 'codex', profileId: null, available: false }, deps)
    assert.equal(off.find((row) => row.engine === 'codex')?.offered, 'no')
  } finally { await dirs.done() }
})

test('another account signs in with the program and is removed with its sign-out', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const dirs = await folders()
  try {
    const signIns: string[] = []
    const signOuts: string[] = []
    const deps = { accountsRoot: dirs.accounts, env: {}, probes: probes(),
      signIn: async (_engine: string, _program: string, directory: string) => { signIns.push(directory) },
      signOut: async (_engine: string, _program: string, _env: NodeJS.ProcessEnv, directory: string) => {
        signOuts.push(directory); return true
      } }
    const rows = await applyLocalCliEngineOperation(dirs.teamA, { operation: 'add', engine: 'codex', name: 'Work' }, deps)
    const added = rows.find((row) => row.profileId !== null)!
    assert.deepEqual([added.name, added.signedIn], ['Work', false])
    assert.deepEqual(signIns, [localCliAccountDirectory(dirs.accounts, added.profileId!)])
    await assert.rejects(applyLocalCliEngineOperation(dirs.teamA, { operation: 'add', engine: 'codex', name: 'work' }, deps),
      /already/u)
    assert.equal(findLocalCliAccount(await readLocalCliAccounts(dirs.accounts), 'codex', 'WORK')?.id, added.profileId)
    await applyLocalCliEngineOperation(dirs.teamA,
      { operation: 'set', engine: 'codex', profileId: added.profileId, available: true }, deps)
    const left = await applyLocalCliEngineOperation(dirs.teamA, { operation: 'remove', profileId: added.profileId! }, deps)
    assert.equal(left.some((row) => row.profileId !== null), false)
    assert.deepEqual(signOuts, signIns)
    await assert.rejects(stat(signIns[0]!), /ENOENT/u)
  } finally { await dirs.done() }
})

const machine = () => {
  const keys = generateKeyPairSync('ed25519')
  const state = { apiBaseUrl: 'https://nessie.test', connectionEpoch: '7', executorId: randomUUID(),
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }
  return { state: state as unknown as ExecutorLocalState, publicKey: createPublicKey(keys.privateKey) }
}

test('registration is signed in its own domain, and an older Nessie means not offered yet', async () => {
  const { state, publicKey } = machine()
  let body: Record<string, unknown> | undefined
  const answer = await registerLocalCliHost(state, 'claude-code', null, true, { registerCliHost: async (input) => {
    body = input
    return { connectionEpoch: '3', hostId: randomUUID(), organizationId: randomUUID() }
  } })
  assert.equal(answer.kind, 'host')
  const { signature, ...payload } = body!
  assert.deepEqual(Object.keys(payload).sort(),
    ['available', 'connectionEpoch', 'engine', 'executorId', 'observedAt', 'profileId'])
  assert.ok(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.local_inference.cli_host.v1', payload)),
    publicKey, Buffer.from(String(signature), 'base64url')))
  const older = await registerLocalCliHost(state, 'codex', null, true, { registerCliHost: async () => {
    throw new LocalInferenceApiError('LOCAL_INFERENCE_API_FAILED', 404)
  } })
  assert.equal(older.kind, 'unsupported')
})

test('turning a switch on offers its host; off withdraws it from Nessie', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const dirs = await folders()
  try {
    const { state } = machine()
    const calls: Array<{ engine: string; available: boolean }> = []
    let stops = 0
    const session = { loop: { stop: () => undefined, drain: async () => undefined, resume: () => undefined,
      isIdle: () => true }, heartbeat: async () => undefined, refused: new Promise<void>(() => undefined),
    connected: Promise.resolve(), stop: async () => { stops += 1 } } as unknown as LocalInferenceHostSession
    const manager = createLocalCliEngineManager(dirs.teamA, state, { accountsRoot: dirs.accounts, watch: false,
      underService: async () => false, log: () => undefined,
      register: async (_state, engine, _profile, available) => {
        calls.push({ engine, available })
        if (engine === 'claude-code') return { kind: 'unsupported' }
        return available ? { kind: 'host', hostId: randomUUID(), organizationId: randomUUID(), connectionEpoch: '1' }
          : { kind: 'withdrawn' }
      },
      connect: async () => session })
    await setLocalCliAvailability(dirs.teamA, { engine: 'codex', profileId: null }, true)
    await setLocalCliAvailability(dirs.teamA, { engine: 'claude-code', profileId: null }, true)
    await manager.reconcile()
    assert.deepEqual((await readLocalCliStatus(dirs.teamA))?.offered, { codex: 'yes', 'claude-code': 'not_yet' })
    await setLocalCliAvailability(dirs.teamA, { engine: 'codex', profileId: null }, false)
    await manager.reconcile()
    assert.deepEqual(calls, [{ engine: 'claude-code', available: true }, { engine: 'codex', available: true },
      { engine: 'codex', available: false }])
    assert.equal(stops, 1)
    assert.deepEqual((await readLocalCliStatus(dirs.teamA))?.offered, { 'claude-code': 'not_yet' })
    await manager.stop()
  } finally { await dirs.done() }
})
