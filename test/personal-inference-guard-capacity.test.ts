import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PERSONAL_INFERENCE_GUARD_VERSION } from '@nessie/executor-protocol'
import { PersonalInferenceGuard, type PersonalHostRegistration } from '../src/personal-inference-guard.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'

const CURRENT_BOOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OLD_BOOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MAX_BYTES = 1024 * 1024
const protection = { profileId: 'profile', backgroundConsentRevision: null, principal: {
  serverOrigin: 'https://selfhost.example', identityIssuer: 'https://identity.example', organizationId: 'org',
  teamId: 'team', ownerUserId: 'b518bb56-8077-4ad3-9dca-a80cfec12b84', ownerSubject: 'subject',
} }
const registration = (id: string, bootId?: string): PersonalHostRegistration => ({
  id, pid: 4242, startedAt: '7', label: '', kind: 'runtime', authority: null,
  guardVersion: PERSONAL_INFERENCE_GUARD_VERSION, ...(bootId ? { bootId } : {}),
})

const fixture = async (t: test.TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-guard-capacity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let boot: string | undefined = CURRENT_BOOT
  const guard = PersonalInferenceGuard.open({ directory,
    security: { platform: 'win32', helper: verifyInferenceTestState },
    processIdentity: async () => ({ pid: 4242, startedAt: '7', bootId: CURRENT_BOOT }),
    kernelBootId: async () => boot, verifyRuntimeInventory: async () => true,
    admissionLock: { kernelBootId: async () => CURRENT_BOOT, processes: {
      identify: async pid => ({ pid, startedAt: '7' }), isAlive: () => true,
    } },
  })
  await guard.initialize()
  const path = join(directory, 'guard.json')
  return { guard, path, setBoot: (value: string | undefined) => { boot = value } }
}

test('count-limited admissions and activation leave the previous readable guard intact', async t => {
  const { guard, path } = await fixture(t)
  const lease = await guard.registerRuntime('retained lease')
  const state = await guard.status()
  const entries = Array.from({ length: 4095 }, (_, index) => registration(`entry-${index}`))
  await writeFile(path, JSON.stringify({ ...state, registrations: [...state.registrations, ...entries] }))
  const before = await readFile(path, 'utf8')
  assert.equal((await guard.status()).registrations.length, 4096)
  await assert.rejects(guard.registerRuntime('one too many'), /guard_invalid/u)
  await assert.rejects(guard.registerCredentialRuntime(), /guard_invalid/u)
  await assert.rejects(guard.activate(protection, async () => assert.fail('No credential write at capacity')),
    /guard_invalid/u)
  assert.equal(await readFile(path, 'utf8'), before)
  await lease.release()
  assert.equal((await guard.status()).registrations.length, 4095)
  await guard.registerRuntime('space reclaimed by release')
  assert.equal((await guard.status()).registrations.length, 4096)
})

test('serialized UTF-8 byte capacity covers registrations, execution binding and activation', async t => {
  const { guard, path } = await fixture(t)
  const lease = await guard.admitHostExecution('host', null)
  const state = await guard.status()
  const entry = state.registrations[0]!
  // Leave exactly one byte for the writer's newline. Multibyte text catches
  // character-count checks that would accept an unreadable UTF-8 file.
  entry.label = ''
  const space = MAX_BYTES - Buffer.byteLength(JSON.stringify(state)) - 1
  entry.label = 'é'.repeat(Math.floor(space / 2)) + 'x'.repeat(space % 2)
  await writeFile(path, `${JSON.stringify(state)}\n`)
  assert.equal((await readFile(path)).byteLength, MAX_BYTES)
  assert.equal((await guard.status()).registrations.length, 1)
  const before = await readFile(path, 'utf8')
  await assert.rejects(guard.registerRuntime('over byte capacity'), /guard_invalid/u)
  await assert.rejects(lease.bindExecution({ pid: 42, startedAt: '8' }), /guard_invalid/u)
  assert.equal(await readFile(path, 'utf8'), before)
  // Activation has a separate semantic precondition; make the retained entry a
  // runtime so the byte limit, rather than host isolation, refuses its fence.
  entry.kind = 'runtime'
  await writeFile(path, `${JSON.stringify(state)}\n`)
  const runtimeBefore = await readFile(path, 'utf8')
  await assert.rejects(guard.activate(protection, async () => assert.fail('No credential write over byte capacity')),
    /guard_invalid/u)
  assert.equal(await readFile(path, 'utf8'), runtimeBefore)
  await lease.release()
  assert.equal((await guard.status()).registrations.length, 0)
})

test('bounded oversized recovery prunes only positively cleared boots and retains protection', async t => {
  const { guard, path } = await fixture(t)
  const old = Array.from({ length: 4096 }, (_, index) => registration(`old-${index}`, OLD_BOOT))
  old[0]!.kind = 'credential_runtime'
  old[1]!.kind = 'host_execution'
  const retained = [registration('current', CURRENT_BOOT), registration('unknown')]
  await writeFile(path, JSON.stringify({ version: 1, revision: 12, protection: { profiles: [protection] },
    registrations: [...old, ...retained] }))
  await assert.rejects(guard.status(), /guard_invalid/u)
  await guard.initialize()
  const state = await guard.status()
  assert.deepEqual(state.registrations, retained)
  assert.deepEqual(state.protection, { profiles: [protection] })
  assert.equal(state.revision, 13)
  await assert.rejects(guard.assertExecutionAuthority(null), /host_isolation_required/u)
})

test('oversized state without sufficient whole-boot clearance is preserved, never reset', async t => {
  const { guard, path, setBoot } = await fixture(t)
  for (const boot of [undefined, CURRENT_BOOT]) {
    setBoot(boot)
    const entries = Array.from({ length: 4097 }, (_, index) => registration(`current-${index}`, CURRENT_BOOT))
    await writeFile(path, JSON.stringify({ version: 1, revision: 9, protection: null, registrations: entries }))
    const before = await readFile(path, 'utf8')
    await assert.rejects(guard.initialize(), /guard_invalid/u)
    assert.equal(await readFile(path, 'utf8'), before)
  }
  // Unknown boot claims do not become cleared just because a boot is observable.
  const unknown = Array.from({ length: 4097 }, (_, index) => registration(`unknown-${index}`))
  await writeFile(path, JSON.stringify({ version: 1, revision: 9, protection: null, registrations: unknown }))
  const before = await readFile(path, 'utf8')
  await assert.rejects(guard.registerRuntime('blocked'), /guard_invalid/u)
  assert.equal(await readFile(path, 'utf8'), before)
})

test('recovery refuses files above its bounded read ceiling without rewriting them', async t => {
  const { guard, path } = await fixture(t)
  const before = `${' '.repeat(8 * MAX_BYTES)}{}`
  await writeFile(path, before)
  await assert.rejects(guard.initialize(), /guard_invalid/u)
  assert.equal(await readFile(path, 'utf8'), before)
})
