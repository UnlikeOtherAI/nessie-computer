import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import type { PersonalInferenceAuthority, PersonalInferencePrincipal } from '@nessie/executor-protocol'

import { PersonalNativeWriters } from '../src/personal-native-writers.js'
import { PersonalInferenceGuard } from '../src/personal-inference-guard.js'
import { assertPersonalInferenceFilePath, assertPersonalInferenceWorkspace } from '../src/personal-inference-paths.js'
import { createExecutorMcpSessionManager } from '../src/mcp-session-manager.js'
import { startAgentProcess } from '../src/coding-session/agent-process.js'
import type { CodingProcessControl } from '../src/coding-session/process-control.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'
import { readChatgptBackgroundConsent } from '../src/chatgpt-background-consent.js'
import { currentKernelBootId } from '../src/kernel-boot.js'

const principal: PersonalInferencePrincipal = {
  serverOrigin: 'https://selfhost.example', identityIssuer: 'https://identity.example',
  organizationId: 'org', teamId: 'team', ownerUserId: 'b518bb56-8077-4ad3-9dca-a80cfec12b84', ownerSubject: 'subject',
}
const authority: PersonalInferenceAuthority = {
  principal, agent: { kind: 'private', id: 'b518bb56-8077-4ad3-9dca-a80cfec12b83', ownerUserId: 'b518bb56-8077-4ad3-9dca-a80cfec12b84', teamId: 'team' },
  origin: { kind: 'interactive', requestingUserId: 'b518bb56-8077-4ad3-9dca-a80cfec12b84', rootRunId: 'root' },
  runId: 'b518bb56-8077-4ad3-9dca-a80cfec12b82', rootRunId: 'root', soleReaderUserId: 'b518bb56-8077-4ad3-9dca-a80cfec12b84',
}
const protection = { profileId: 'profile-a', principal, backgroundConsentRevision: null }
const security = { platform: 'win32' as const, helper: verifyInferenceTestState }

const fixture = async (realAdmissionProcesses = false) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-personal-guard-'))
  await ensureOwnerOnlyStateDirectory(directory, security)
  // These fixtures simulate packaged process tables; their development Node
  // has no installed kernel helper. Retain the boot observation before that flag.
  const boot = await currentKernelBootId()
  const guard = PersonalInferenceGuard.open({ directory, security,
    processIdentity: async () => ({ pid: 2_000_000_000, startedAt: '1' }),
    kernelBootId: async () => boot,
    admissionLock: { kernelBootId: async () => boot, ...(realAdmissionProcesses ? {} : { processes: {
      identify: async (pid) => pid === process.pid ? { pid, startedAt: '1' } : undefined,
      isAlive: (pid) => pid === process.pid,
    } }) },
    verifyRuntimeInventory: async () => true,
  })
  return { directory, guard, clean: () => rm(directory, { recursive: true, force: true }) }
}

test('local background withdrawal and re-enable cannot revive grants or change foreground source identity', async () => {
  const { guard, clean } = await fixture()
  const source = { kind: 'chatgpt' as const, processing: 'openai_cloud' as const,
    billingSource: 'personal_plan' as const, profileId: '00000000-0000-4000-8000-000000000001',
    accountGeneration: 1, consentRevision: 1 }
  const protectedSource = { profileId: source.profileId, principal, inferenceSource: source,
    backgroundConsentRevision: null }
  const control = { profileId: source.profileId, principal, inferenceSource: source }
  try {
    await guard.activate(protectedSource, async () => undefined)
    const first = await guard.setBackgroundConsent({ ...control, enabled: true, expectedRevision: null })
    assert.ok(first)
    assert.equal(await readChatgptBackgroundConsent(guard, { source, principal }), first)
    await assert.rejects(guard.setBackgroundConsent({ ...control, principal: { ...principal, teamId: 'another' },
      enabled: false, expectedRevision: first }), /consent_fenced/u)
    await guard.setBackgroundConsent({ ...control, enabled: false, expectedRevision: first })
    assert.equal(await readChatgptBackgroundConsent(guard, { source, principal }), null)
    const second = await guard.setBackgroundConsent({ ...control, enabled: true, expectedRevision: null })
    assert.ok(second && second > first)
    await assert.rejects(guard.setBackgroundConsent({ ...control, enabled: false, expectedRevision: first }),
      /consent_fenced/u)
    await guard.activate(protectedSource, async () => undefined)
    assert.equal(await readChatgptBackgroundConsent(guard, { source, principal }), second)
    const replacement = { ...source, accountGeneration: 2 }
    await guard.activate({ ...protectedSource, inferenceSource: replacement }, async () => undefined)
    assert.equal(await readChatgptBackgroundConsent(guard, { source: replacement, principal }), null)
    assert.equal(await readChatgptBackgroundConsent(guard, { source, principal }), null)
    assert.deepEqual((await guard.status()).protection?.profiles[0]?.inferenceSource, replacement)
  } finally { await clean() }
})

test('first-use initialization precedes profile metadata and never resets a missing protected guard', async () => {
  const { directory, guard, clean } = await fixture()
  try {
    await guard.initialize()
    await mkdir(join(directory, 'profiles'))
    assert.equal((await guard.status()).protection, null)
    await unlink(join(directory, 'guard.json'))
    await assert.rejects(guard.initialize(), /guard_missing/u)
    await assert.rejects(readFile(join(directory, 'guard.json')), { code: 'ENOENT' })
  } finally { await clean() }
})

test('an unverified runtime writes no credential; an older version\'s terminal record keeps no plan out', async () => {
  const { directory, guard, clean } = await fixture()
  try {
    let saved = false
    const unverified = PersonalInferenceGuard.open({ directory, security })
    await assert.rejects(unverified.activate(protection, async () => { saved = true }), /runtime_unverified/u)
    assert.equal(saved, false)
    // Versions through 1.0.40 recorded every terminal, coding tool and local app, and refused a plan beside one.
    await guard.initialize()
    await writeFile(join(directory, 'guard.json'), JSON.stringify({ ...await guard.status(), registrations: [
      { id: 'terminal', pid: 4242, startedAt: '7', label: 'coding/terminal', kind: 'host_execution',
        guardVersion: 2, authority: null },
    ] }))
    await guard.activate(protection, async () => { saved = true })
    assert.equal(saved, true)
    assert.deepEqual((await guard.status()).registrations.map((item) => item.kind), ['credential_runtime'])
  } finally { await clean() }
})

test('one computer holds one owner\'s plans: another owner or server is refused, no token written', async () => {
  const { guard, clean } = await fixture()
  try {
    await guard.activate(protection, async () => undefined)
    const others = [{ ...principal, ownerUserId: 'other' }, { ...principal, serverOrigin: 'https://other.example' }]
    for (const other of others) {
      await assert.rejects(guard.activate({ profileId: 'profile-b', principal: other, backgroundConsentRevision: null },
        async () => assert.fail('No tokens may be written')), /other_custodian_active/u)
    }
    assert.deepEqual((await guard.status()).protection?.profiles.map((profile) => profile.profileId), ['profile-a'])
  } finally { await clean() }
})

test('one owner may connect plans for independent teams; removing one keeps the other', async () => {
  const { guard, clean } = await fixture()
  const secondPrincipal = { ...principal, organizationId: 'org-b', teamId: 'team-b' }
  const profiles = async () => (await guard.status()).protection?.profiles.map((profile) => profile.profileId)
  try {
    await guard.activate(protection, async () => undefined)
    await guard.activate({ profileId: 'profile-b', principal: secondPrincipal, backgroundConsentRevision: null },
      async () => undefined)
    assert.deepEqual(await profiles(), ['profile-a', 'profile-b'])
    await guard.deactivate('profile-a', async () => undefined)
    assert.deepEqual(await profiles(), ['profile-b'])
    await guard.deactivate('profile-b', async () => undefined)
    assert.equal((await guard.status()).protection, null)
  } finally { await clean() }
})

test('a failed token write keeps the plan accounted for, and so does a failed token deletion', async () => {
  const { guard, clean } = await fixture()
  try {
    await assert.rejects(guard.activate(protection, async () => {
      throw new Error('write interrupted')
    }), /interrupted/u)
    assert.notEqual((await guard.status()).protection, null)
    await assert.rejects(guard.deactivate('profile-a', async () => { throw new Error('clear failed') }), /clear failed/u)
    assert.notEqual((await guard.status()).protection, null)
    await guard.deactivate('profile-a', async () => undefined)
    assert.equal((await guard.status()).protection, null)
  } finally { await clean() }
})

test('a missing guard beside persisted profiles fails closed', async () => {
  const { directory, guard, clean } = await fixture()
  try {
    await mkdir(join(directory, 'profiles'), { mode: 0o700 })
    await assert.rejects(guard.status(), /guard_missing/u)
  } finally { await clean() }
})

test('a sign-in in one process and a registration in another never change the guard at once', async () => {
  const { directory, guard, clean } = await fixture(true)
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(
    new URL('./fixtures/personal-inference-guard-child.mjs', import.meta.url)), directory], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const done = new Promise<number | null>((resolve) => { child.once('exit', resolve) })
  try {
    assert.equal((await lines.next()).value, 'activation-held')
    await assert.rejects(guard.registerRuntime('a team starting meanwhile'), /admission_busy/u)
    child.stdin.end('release\n')
    assert.equal(await done, 0)
    // The plan is signed in; a team still starts beside it.
    await (await guard.registerRuntime('a team starting afterwards')).release()
    assert.notEqual((await guard.status()).protection, null)
  } finally {
    child.kill()
    await done
    await clean()
  }
})

test('workspace grants and aliases cannot cover the canonical protected subtree', async () => {
  const { directory, clean } = await fixture()
  try {
    const protectedRoot = join(directory, 'protected')
    const allowed = join(directory, 'project')
    await mkdir(protectedRoot)
    await mkdir(allowed)
    await writeFile(join(protectedRoot, 'sentinel.json'), '{}')
    await assert.rejects(assertPersonalInferenceWorkspace(directory, protectedRoot), /protected_workspace/u)
    await assert.rejects(assertPersonalInferenceWorkspace(protectedRoot, protectedRoot), /protected_workspace/u)
    await assert.rejects(assertPersonalInferenceFilePath(
      join(protectedRoot, 'new.json'), protectedRoot,
    ), /protected_path/u)
    await assertPersonalInferenceWorkspace(allowed, protectedRoot)
    const alias = join(directory, 'alias')
    await symlink(protectedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(assertPersonalInferenceWorkspace(alias, protectedRoot), /protected_workspace/u)
    await assert.rejects(assertPersonalInferenceFilePath(
      join(alias, 'sentinel.json'), protectedRoot,
    ), /protected_path/u)
  } finally { await clean() }
})

test('a signed-in plan refuses neither a local app nor a terminal or coding tool', async () => {
  const { directory, guard, clean } = await fixture()
  const script = fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))
  const sessions = createExecutorMcpSessionManager([{ name: 'scripted', command: [process.execPath, script],
    env: { NESSIE_TEST_MCP_MODE: 'ok' },
  }], { maxResultBytes: 4096 }, { log: () => undefined })
  let spawned = 0
  const control: CodingProcessControl = {
    spawnAgent: () => { spawned += 1; throw new Error('the spawn was reached') },
    identify: async () => undefined, descendants: async () => [],
    killTree: async () => undefined, killChildTree: async () => false,
  }
  try {
    await guard.activate(protection, async () => undefined)
    assert.equal((await sessions.listTools('scripted')).success, true)
    assert.equal((await sessions.callTool('scripted', 'echo', { value: 'beside a plan' }, {
      'nessie/personal-authority': authority,
    })).success, true)
    for (const program of ['terminal', 'coding-tool']) {
      await assert.rejects(startAgentProcess({ control, paths: codingSessionPaths(directory, authority.runId),
        folder: directory, env: process.env, log: () => undefined,
      }, [program], () => undefined), /the spawn was reached/u)
    }
    assert.equal(spawned, 2, 'nothing refuses a start before it is tried')
    // Neither leaves a record that a later sign-in or sign-out would trip over.
    assert.deepEqual((await guard.status()).registrations.map((item) => item.kind), ['credential_runtime'])
  } finally { await sessions.stopAll(); await clean() }
})

test('a credential-bearing process cannot release its own claim or be forgotten while it lives', async () => {
  const { directory, clean } = await fixture()
  let observed: string | undefined = '100'
  let alive = true
  const guard = PersonalInferenceGuard.open({ directory, security,
    processIdentity: async () => ({ pid: 2_000_000_000, startedAt: '100' }), verifyRuntimeInventory: async () => true,
    admissionLock: { processes: {
      identify: async (pid) => pid === process.pid ? { pid, startedAt: '1' }
        : observed ? { pid, startedAt: observed } : undefined,
      isAlive: (pid) => pid === process.pid || alive,
    } },
  })
  try {
    await guard.activate(protection, async () => undefined)
    const credential = await guard.registerCredentialRuntime()
    await assert.rejects(credential.release(), /credential_process_live/u)
    let deleted = false
    await assert.rejects(guard.deactivate(protection.profileId, async () => { deleted = true }),
      /credential_process_live/u)
    assert.equal(deleted, true, 'File deletion alone cannot erase process memory')
    assert.notEqual((await guard.status()).protection, null)
    observed = undefined
    await assert.rejects(guard.deactivate(protection.profileId, async () => undefined), /credential_process_live/u)
    // Positive PID reuse proves the old generation gone; an unreadable live PID does not.
    observed = '101'
    await guard.deactivate(protection.profileId, async () => undefined)
    assert.equal((await guard.status()).protection, null)
    assert.equal((await guard.status()).registrations.length, 0)
    alive = false
  } finally { await clean() }
})


test('an unresolved native credential writer prevents last-profile deactivation after file deletion', async () => {
  const { directory, clean } = await fixture()
  let helperAlive = true
  const processes = {
    identify: async (pid: number) => pid === process.pid ? { pid, startedAt: '1' }
      : pid === 2_000_000_001 && helperAlive ? { pid, startedAt: '200' } : undefined,
    isAlive: (pid: number) => pid === process.pid || pid === 2_000_000_001 && helperAlive,
  }
  const guard = PersonalInferenceGuard.open({ directory, security,
    processIdentity: async () => ({ pid: 2_000_000_000, startedAt: '100' }),
    admissionLock: { processes }, verifyRuntimeInventory: async () => true,
  })
  try {
    await guard.activate(protection, async () => undefined)
    const writers = new PersonalNativeWriters(directory, security, processes)
    await assert.rejects(writers.execute(async (track) => {
      await track({ pid: 2_000_000_001 })
      throw new Error('Native close unknown')
    }), /Native close unknown/u)
    await assert.rejects(guard.deactivate(protection.profileId, async () => undefined), /writer_unknown/u)
    assert.notEqual((await guard.status()).protection, null)
    helperAlive = false
    await guard.deactivate(protection.profileId, async () => undefined)
    assert.equal((await guard.status()).protection, null)
  } finally { await clean() }
})


test('boot-born credential claims do not confuse repeated Linux PID/start ticks after a reboot', async () => {
  const { directory, clean } = await fixture()
  const originalBoot = '11111111-1111-4111-8111-111111111111'
  let boot: string | undefined = originalBoot
  const guard = PersonalInferenceGuard.open({ directory, security,
    processIdentity: async () => ({ pid: 2_000_000_000, startedAt: '100', bootId: originalBoot }),
    kernelBootId: async () => boot, verifyRuntimeInventory: async () => true,
    admissionLock: { processes: {
      identify: async (pid) => ({ pid, startedAt: pid === process.pid ? '1' : '100' }), isAlive: () => true,
    } },
  })
  try {
    await guard.activate(protection, async () => undefined)
    assert.equal((await guard.status()).registrations[0]!.bootId, originalBoot)
    await assert.rejects(guard.deactivate(protection.profileId, async () => undefined), /credential_process_live/u)
    boot = undefined
    await assert.rejects(guard.deactivate(protection.profileId, async () => undefined), /credential_process_live/u)
    boot = '22222222-2222-4222-8222-222222222222'
    await guard.deactivate(protection.profileId, async () => undefined)
    assert.equal((await guard.status()).protection, null)
  } finally { await clean() }
})

// 9 November, dictator: 405 registrations of programs agents had started, most
// from a boot that had ended, sat in the guard; every native launch on the Mac
// then kept its creation record and exited refused. Nothing writes those any
// more, and a registration made in a new boot drops what an earlier boot left.
test('a registration in a new boot drops what earlier boots left behind', async () => {
  const { directory, guard: base, clean } = await fixture()
  try {
    await base.initialize()
    const current = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const earlier = '11111111-1111-4111-8111-111111111111'
    const state = await base.status()
    const registration = (id: string, kind: string, bootId?: string) => ({ id, pid: 4242, startedAt: '7', label: id,
      kind, guardVersion: 2, authority: null, ...(bootId ? { bootId } : {}) })
    await writeFile(join(directory, 'guard.json'), JSON.stringify({ ...state, registrations: [
      registration('old-host', 'host_execution', earlier), registration('old-runtime', 'runtime', earlier),
      registration('old-credential', 'credential_runtime', earlier), registration('live-host', 'host_execution', current),
      registration('unknown-boot', 'host_execution'),
    ] }))
    const guard = PersonalInferenceGuard.open({ directory, security,
      processIdentity: async () => ({ pid: 2_000_000_000, startedAt: '1', bootId: current }),
      kernelBootId: async () => current, verifyRuntimeInventory: async () => true })
    const lease = await guard.registerRuntime('executor:team')
    const kept = (await guard.status()).registrations.map((item) => item.label).sort()
    assert.deepEqual(kept, ['executor:team', 'live-host', 'old-credential', 'unknown-boot'])
    await lease.release()
  } finally { await clean() }
})
