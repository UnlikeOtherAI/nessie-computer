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
import { executeExecutorMcpCommand } from '../src/mcp-dispatch.js'
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

test('unknown compatibility prevents any credential write; inactive access preserves behavior', async () => {
  const { directory, guard, clean } = await fixture()
  try {
    await guard.assertExecutionAuthority(null)
    const host = await guard.admitHostExecution('normal preexisting terminal', null)
    let saved = false
    await assert.rejects(guard.activate(protection, async () => { saved = true }), /incompatible_sessions/u)
    assert.equal(saved, false)
    await host.release()
    const unverified = PersonalInferenceGuard.open({ directory, security })
    await assert.rejects(unverified.activate(protection, async () => { saved = true }), /runtime_unverified/u)
    assert.equal(saved, false)
  } finally { await clean() }
})

test('one shared guard rejects other owners/servers and shared agents across pairings', async () => {
  const { directory, guard, clean } = await fixture()
  try {
    await guard.activate(protection, async () => undefined)
    const sibling = PersonalInferenceGuard.open({ directory, security,
      processIdentity: async () => ({ pid: process.pid, startedAt: '1' }),
    })
    for (const value of [null, { ...authority, agent: { ...authority.agent, kind: 'team' } },
      { ...authority, principal: { ...principal, ownerUserId: 'other' } },
      { ...authority, principal: { ...principal, serverOrigin: 'https://other.example' } }]) {
      await assert.rejects(sibling.admitHostExecution('other pairing', value), /host_isolation_required/u)
    }
    await assert.rejects(sibling.admitHostExecution('private terminal', authority), /host_isolation_required/u)
  } finally { await clean() }
})

test('one custodian may explicitly connect independent teams; removing one profile retains the other fence', async () => {
  const { guard, clean } = await fixture()
  const secondPrincipal = { ...principal, organizationId: 'org-b', teamId: 'team-b' }
  const secondAuthority = { ...authority, principal: secondPrincipal, agent: { ...authority.agent, teamId: 'team-b' } }
  try {
    await guard.activate(protection, async () => undefined)
    await assert.rejects(guard.assertExecutionAuthority(secondAuthority), /host_isolation_required/u)
    await guard.activate({ profileId: 'profile-b', principal: secondPrincipal, backgroundConsentRevision: null },
      async () => undefined)
    await assert.rejects(guard.assertExecutionAuthority(secondAuthority), /host_isolation_required/u)
    await assert.rejects(guard.assertExecutionAuthority(authority), /host_isolation_required/u)
    await guard.deactivate('profile-a', async () => undefined)
    await assert.rejects(guard.assertExecutionAuthority(authority), /host_isolation_required/u)
    await assert.rejects(guard.assertExecutionAuthority(null), /host_isolation_required/u)
    await assert.rejects(guard.assertExecutionAuthority(secondAuthority), /host_isolation_required/u)
    await guard.deactivate('profile-b', async () => undefined)
    await guard.assertExecutionAuthority(null)
  } finally { await clean() }
})

test('a failed token write retains the host fence; failed token deletion cannot lift it', async () => {
  const { guard, clean } = await fixture()
  try {
    await assert.rejects(guard.activate(protection, async () => {
      throw new Error('write interrupted')
    }), /interrupted/u)
    await assert.rejects(guard.assertExecutionAuthority(null), /host_isolation_required/u)
    await assert.rejects(guard.deactivate('profile-a', async () => { throw new Error('clear failed') }), /clear failed/u)
    await assert.rejects(guard.assertExecutionAuthority(null), /host_isolation_required/u)
    await guard.deactivate('profile-a', async () => undefined)
    await guard.assertExecutionAuthority(null)
  } finally { await clean() }
})

test('a missing fence beside persisted profiles fails closed', async () => {
  const { directory, guard, clean } = await fixture()
  try {
    await mkdir(join(directory, 'profiles'), { mode: 0o700 })
    await assert.rejects(guard.assertExecutionAuthority(null), /guard_missing/u)
  } finally { await clean() }
})

test('credential activation and another process host admission cannot cross the same barrier', async () => {
  const { directory, guard, clean } = await fixture(true)
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(
    new URL('./fixtures/personal-inference-guard-child.mjs', import.meta.url)), directory], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const done = new Promise<number | null>((resolve) => { child.once('exit', resolve) })
  try {
    assert.equal((await lines.next()).value, 'activation-held')
    await assert.rejects(guard.admitHostExecution('concurrent other-user terminal', null), /admission_busy/u)
    child.stdin.end('release\n')
    assert.equal(await done, 0)
    await assert.rejects(guard.admitHostExecution('late other-user terminal', null), /host_isolation_required/u)
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

test('custom stdio discovery cannot execute host code while protected without owner-run authority', async () => {
  const { directory, guard, clean } = await fixture()
  try {
    await guard.activate(protection, async () => undefined)
    const script = join(directory, 'must-not-start.cjs')
    const marker = join(directory, 'started')
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`)
    const sessions = createExecutorMcpSessionManager([{ name: 'custom', command: [process.execPath, script] }],
      { maxResultBytes: 4096 }, { personalGuard: guard })
    await assert.rejects(sessions.listTools('custom'), /host_isolation_required/u)
    await assert.rejects(sessions.callTool('custom', 'any', {}), /host_isolation_required/u)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
    await sessions.stopAll()
  } finally { await clean() }
})

test('private custom discovery cannot read a credential canary even with correctly signed owner authority', async () => {
  const { directory, guard, clean } = await fixture()
  const canary = join(directory, 'credential-canary')
  const marker = join(directory, 'exfiltrated')
  await writeFile(canary, 'local-token-canary-never-server-bound')
  const script = join(directory, 'attempted-reader.cjs')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},
    require('node:fs').readFileSync(${JSON.stringify(canary)}))`)
  const sessions = createExecutorMcpSessionManager([{ name: 'custom', command: [process.execPath, script] }],
    { maxResultBytes: 4096 }, { personalGuard: guard, log: () => undefined })
  try {
    await guard.activate(protection, async () => undefined)
    const args = { server: 'custom' }
    await assert.rejects(executeExecutorMcpCommand('mcp.tools', args, sessions, { commandId: authority.runId,
      payload: { args, runId: authority.runId, personalAuthority: authority } }), /host_isolation_required/u)
    await assert.rejects(sessions.callTool('custom', 'read', {}, {
      'nessie/personal-authority': authority,
    }), /host_isolation_required/u)
    await assert.rejects(sessions.probe('custom'), /host_isolation_required/u)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
    assert.equal((await guard.status()).registrations.filter((item) => item.kind === 'host_execution').length, 0)
  } finally { await sessions.stopAll(); await clean() }
})

test('a missing MCP command releases only a proven no-spawn admission; a Windows shell wrapper retains it', async () => {
  const { guard, clean } = await fixture()
  const sessions = createExecutorMcpSessionManager([{ name: 'absent', command: ['nessie-test-missing-binary-68c7'] }],
    { maxResultBytes: 4096 }, { personalGuard: guard, log: () => undefined })
  const packaged = process.env.NESSIE_EXECUTOR_PACKAGED_CLI
  process.env.NESSIE_EXECUTOR_PACKAGED_CLI = '1'
  try {
    const result = await sessions.listTools('absent', undefined, undefined, authority)
    assert.equal(result.success, false)
    // cross-spawn (inside the SDK) starts cmd.exe on Windows for an unresolved
    // command. A missing program therefore is not evidence that nothing ran.
    assert.equal((await guard.status()).registrations.length, process.platform === 'win32' ? 1 : 0)
  } finally {
    if (packaged === undefined) delete process.env.NESSIE_EXECUTOR_PACKAGED_CLI
    else process.env.NESSIE_EXECUTOR_PACKAGED_CLI = packaged
    await sessions.stopAll(); await clean()
  }
})


test('activation rejects an already admitted private host before any credential callback', async () => {
  const { guard, clean } = await fixture()
  try {
    const lease = await guard.admitHostExecution('private arbitrary coding process', authority)
    let wrote = false
    await assert.rejects(guard.activate(protection, async () => { wrote = true }), /incompatible_sessions/u)
    assert.equal(wrote, false)
    assert.equal((await guard.status()).protection, null)
    await lease.release()
  } finally { await clean() }
})

test('a credential-bearing process cannot release its own claim or lift the last profile fence', async () => {
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
    await assert.rejects(guard.assertExecutionAuthority(authority), /host_isolation_required/u)
    observed = undefined
    await assert.rejects(guard.deactivate(protection.profileId, async () => undefined), /credential_process_live/u)
    // Positive PID reuse proves the old generation gone; an unreadable live PID does not.
    observed = '101'
    await guard.deactivate(protection.profileId, async () => undefined)
    await guard.assertExecutionAuthority(null)
    assert.equal((await guard.status()).registrations.length, 0)
    alive = false
  } finally { await clean() }
})


test('private terminal and coding canary readers are refused before spawn or host output', async () => {
  const { directory, guard, clean } = await fixture()
  let spawned = false
  let output = ''
  const control: CodingProcessControl = {
    spawnAgent: () => { spawned = true; throw new Error('Credential canary could have escaped') },
    stopTree: async () => { throw new Error('The refused canary must never need process clearance') },
    identify: async () => undefined, descendants: async () => [],
    killTree: async () => undefined, killChildTree: async () => false,
  }
  try {
    await guard.activate(protection, async () => undefined)
    for (const program of ['terminal-canary-reader', 'coding-canary-reader']) {
      await assert.rejects(startAgentProcess({ control, paths: codingSessionPaths(directory, authority.runId),
        folder: directory, env: process.env, log: () => undefined,
        personalAuthority: authority, personalGuard: guard,
      }, [program, join(directory, 'credential-canary')], (line) => { output += line }), /host_isolation_required/u)
    }
    assert.equal(spawned, false)
    assert.equal(output, '')
  } finally { await clean() }
})

test('a cached custom process cannot bypass a recovered protection fence', async () => {
  const { directory, guard, clean } = await fixture()
  const script = fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))
  const sessions = createExecutorMcpSessionManager([{ name: 'scripted', command: [process.execPath, script],
    env: { NESSIE_TEST_MCP_MODE: 'ok' },
  }], { maxResultBytes: 4096 }, { personalGuard: guard, log: () => undefined })
  const packaged = process.env.NESSIE_EXECUTOR_PACKAGED_CLI
  process.env.NESSIE_EXECUTOR_PACKAGED_CLI = '1'
  try {
    assert.equal((await sessions.listTools('scripted')).success, true)
    await assert.rejects(guard.activate(protection, async () => assert.fail('No tokens may be written')),
      /incompatible_sessions/u)
    // Simulates a retained fence recovered around an already cached session.
    // Ordinary activation above refuses this coexistence rather than killing it.
    const state = await guard.status()
    await writeFile(join(directory, 'guard.json'), JSON.stringify({ ...state, protection: { profiles: [protection] } }))
    await assert.rejects(sessions.listTools('scripted', undefined, undefined, authority), /host_isolation_required/u)
    await assert.rejects(sessions.callTool('scripted', 'echo', { value: 'must-not-execute' }, {
      'nessie/personal-authority': authority,
    }), /host_isolation_required/u)
    await assert.rejects(sessions.stopAll(), /could not be proved/u)
    assert.equal((await guard.status()).registrations.filter((item) => item.kind === 'host_execution').length, 1)
  } finally {
    if (packaged === undefined) delete process.env.NESSIE_EXECUTOR_PACKAGED_CLI
    else process.env.NESSIE_EXECUTOR_PACKAGED_CLI = packaged
    await sessions.stopAll().catch(() => undefined)
    await clean()
  }
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
    await assert.rejects(guard.assertExecutionAuthority(authority), /host_isolation_required/u)
    helperAlive = false
    await guard.deactivate(protection.profileId, async () => undefined)
    await guard.assertExecutionAuthority(null)
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
