import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PersonalInferenceGuard, type PersonalHostRegistration } from '../src/personal-inference-guard.js'
import { hasKnownLiveHostExecution } from '../src/personal-host-session-state.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'

const bootId = '7035bda9-0000-4000-8000-000000000000'
const controller = { pid: 2_000_000_000, startedAt: '1000000', bootId }
const principal = { serverOrigin: 'https://fixture.example', identityIssuer: 'https://identity.example',
  organizationId: 'org', teamId: 'team', ownerUserId: 'b518bb56-8077-4ad3-9dca-a80cfec12b84', ownerSubject: 'subject' }
const protection = { profileId: 'profile-a', principal, backgroundConsentRevision: null }

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-host-retirement-'))
  let identity = controller
  const guard = PersonalInferenceGuard.open({ directory,
    security: { platform: 'win32', helper: verifyInferenceTestState },
    processIdentity: async () => identity, kernelBootId: async () => bootId,
    admissionLock: { kernelBootId: async () => bootId,
      processes: { identify: async pid => pid === process.pid ? { pid, startedAt: '1' } : undefined,
        isAlive: pid => pid === process.pid } },
    verifyRuntimeInventory: async () => true,
  })
  return { directory, guard, identify: (next: typeof controller) => { identity = next },
    clean: () => rm(directory, { recursive: true, force: true }) }
}

test('native-ended controllers retire authority only after preserving exact admission history', async () => {
  const f = await fixture()
  try {
    const old = await f.guard.admitHostExecution('stdio-mcp:fixture', null)
    const original = (await f.guard.status()).registrations[0]!
    f.identify({ ...controller, pid: controller.pid - 1 })
    const active = await f.guard.admitHostExecution('active terminal', null)
    const proof = { ...controller, journal: { protocolVersion: 1 as const, guardVersion: 2 as const, bootId,
      supervisorPid: controller.pid - 10, supervisorStartedAt: '900000', childPid: controller.pid,
      childStartedAt: controller.startedAt, releaseDigest: 'a'.repeat(64), activity: 'serve' as const } }
    await f.guard.retireHostAdmissions([proof])
    assert.deepEqual((await f.guard.status()).registrations.map(row => row.id), [active.id])
    const name = createHash('sha256').update(old.id).digest('hex') + '.json'
    const history = JSON.parse(await readFile(join(f.directory, 'retired-host-admissions', name), 'utf8'))
    assert.deepEqual(history, { format: 1, reason: 'controller_ended', registration: original, controller: proof })
    await f.guard.retireHostAdmissions([controller])
    assert.deepEqual(await readdir(join(f.directory, 'retired-host-admissions')), [name])
    let writes = 0
    await assert.rejects(f.guard.activate(protection, async () => { writes++ }), /incompatible_sessions/u)
    assert.equal(writes, 0, 'a live controller still fences credentials')
    await active.release()
    await f.guard.activate(protection, async () => { writes++ })
    assert.equal(writes, 1)
    await assert.rejects(f.guard.admitHostExecution('new terminal', null), /host_isolation_required/u)
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'retired-host-admissions', name), 'utf8')), history)
  } finally { await f.clean() }
})

test('retirement requires the complete controller generation and preserves recorded execution details', async () => {
  const f = await fixture()
  try {
    const lease = await f.guard.admitHostExecution('stdio-mcp:fixture', null)
    await lease.bindExecution({ pid: 123, startedAt: '99' }, [{ pid: 124, startedAt: '100' }])
    const original = (await f.guard.status()).registrations[0]!
    for (const proof of [{ ...controller, pid: controller.pid - 1 }, { ...controller, startedAt: '2' },
      { ...controller, bootId: 'ff61df02-d264-4db7-9a2d-2fa908745780' }]) {
      await f.guard.retireHostAdmissions([proof])
      assert.deepEqual((await f.guard.status()).registrations, [original])
    }
    await f.guard.retireHostAdmissions([controller])
    const files = await readdir(join(f.directory, 'retired-host-admissions'))
    const history = JSON.parse(await readFile(join(f.directory, 'retired-host-admissions', files[0]!), 'utf8'))
    assert.deepEqual(history.registration, original, 'retirement never claims the escaped execution ended')
  } finally { await f.clean() }
})

test('failed history publication leaves the active admission and credential fence intact', async () => {
  const f = await fixture()
  try {
    await f.guard.admitHostExecution('stdio-mcp:fixture', null)
    const before = await readFile(join(f.directory, 'guard.json'), 'utf8')
    await writeFile(join(f.directory, 'retired-host-admissions'), 'occupied')
    await assert.rejects(f.guard.retireHostAdmissions([controller]))
    assert.equal(await readFile(join(f.directory, 'guard.json'), 'utf8'), before)
    await assert.rejects(f.guard.activate(protection, async () => assert.fail('must not write credentials')),
      /incompatible_sessions/u)
  } finally { await f.clean() }
})

test('known live host sessions have a specific refusal; unknown history still requires native proof', async () => {
  const registration: PersonalHostRegistration = { ...controller, id: 'fixture', kind: 'host_execution',
    guardVersion: 2, label: 'stdio-mcp:fixture', authority: null }
  const asked: number[] = []
  const inspector = { identify: async (pid: number) => { asked.push(pid); return controller }, isAlive: () => true }
  assert.equal(await hasKnownLiveHostExecution([registration], bootId, inspector), true)
  assert.equal(await hasKnownLiveHostExecution([{ ...registration, kind: 'runtime' }], bootId, inspector), false)
  assert.equal(await hasKnownLiveHostExecution([registration], undefined, inspector), false)
  assert.equal(await hasKnownLiveHostExecution([registration], 'ff61df02-d264-4db7-9a2d-2fa908745780', inspector), false)
  assert.equal(await hasKnownLiveHostExecution([{ ...registration, startedAt: '2' }], bootId, inspector), false)
  const unknown = { identify: async () => undefined, isAlive: () => true }
  assert.equal(await hasKnownLiveHostExecution([registration], bootId, unknown), false)
  asked.length = 0
  await hasKnownLiveHostExecution([{ ...registration, startedAt: '2' }, { ...registration, startedAt: '2' }], bootId, inspector)
  assert.equal(asked.length, 1, 'one inspection per controller generation')
  const gone = { identify: async () => { throw new Error('dead process inspected') }, isAlive: () => false }
  assert.equal(await hasKnownLiveHostExecution([registration], bootId, gone), false)
})
