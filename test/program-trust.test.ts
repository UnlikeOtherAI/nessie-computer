import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  localCommandPolicyOf, localCommandPolicyPermits, localTerminalCommandDecision, localTerminalCommandRefusal,
  newLocalCommandPolicy, pairedLocalCommandPolicy, parseLocalCommandPolicy, type LocalCommandPolicy,
} from '../src/command-policy.js'
import { allProgramTrust, programDefaults } from '../src/program-trust.js'
import {
  UNLIKEOTHERAI_MAC_REQUIREMENT, UNLIKEOTHERAI_WINDOWS_PUBLISHER, verifiedUnlikeOtherAiProgram,
  windowsSignatureNamesUnlikeOtherAi, type SignatureCommandRunner,
} from '../src/program-trust-signature.js'
import { WINDOWS_SYMLINK_SKIP } from './windows-prerequisites.js'

const none = { unlikeotherai: false, claudeCode: false, codex: false, t3Code: false }
const noPrograms: LocalCommandPolicy = { mode: 'allowlist', allowlist: [], denylist: [], trusted: none }

/**
 * The signing platform these tests exercise on this host: the PATH lookup and
 * the verifier share one platform, and a Windows host's folders are Windows
 * paths. Each fake answers as that platform's checker would.
 */
const signing: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'darwin'
const exe = signing === 'win32' ? '.exe' : ''

/** A folder holding executable files, as a PATH entry would. */
const binFolder = async (...names: string[]): Promise<{ dir: string; file: (name: string) => string;
  done: () => Promise<void> }> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-trust-')))
  for (const name of names) {
    await writeFile(join(dir, `${name}${exe}`), '#!/bin/sh\nexit 0\n')
    await chmod(join(dir, `${name}${exe}`), 0o755)
  }
  return { dir, file: (name) => join(dir, `${name}${exe}`), done: () => rm(dir, { force: true, recursive: true }) }
}

/** A signature checker that passes only for the listed files, recording what it was asked. */
const fakeVerifier = (signed: readonly string[]) => {
  const calls: Array<{ file: string; args: readonly string[]; checked: string }> = []
  const run: SignatureCommandRunner = async (file, args, env) => {
    const checked = signing === 'win32' ? env.NESSIE_PROGRAM_TRUST_PATH! : args.at(-1)!
    calls.push({ file, args, checked })
    if (signing === 'darwin') return { code: signed.includes(checked) ? 0 : 3, stdout: '' }
    return { code: 0, stdout: JSON.stringify(signed.includes(checked)
      ? { status: 'Valid', subject: UNLIKEOTHERAI_WINDOWS_PUBLISHER } : { status: 'NotSigned', subject: '' }) }
  }
  return { calls, run, options: { platform: signing, run, systemRoot: 'C:\\Windows' } }
}

test('a new pairing trusts the four built-ins and nothing else; existing teams keep allow-all', () => {
  assert.deepEqual(pairedLocalCommandPolicy(), {
    mode: 'allowlist', allowlist: [], denylist: [], trusted: allProgramTrust(),
  })
  assert.deepEqual(localCommandPolicyOf({ descriptor: {} }), newLocalCommandPolicy())
  assert.equal(newLocalCommandPolicy().trusted, undefined)
})

test('trusted entries parse exactly, and round-trip through configuration', () => {
  const policy = { mode: 'allowlist', allowlist: ['git *'], denylist: [], trusted: { ...none, codex: true } }
  assert.deepEqual(parseLocalCommandPolicy(policy), policy)
  assert.throws(() => parseLocalCommandPolicy({ ...policy, trusted: { codex: true } }), /Invalid local command policy/)
  assert.throws(() => parseLocalCommandPolicy({ ...policy, trusted: { ...none, claude: true } }))
  assert.throws(() => parseLocalCommandPolicy({ ...policy, trusted: { ...none, codex: 'yes' } }))
  assert.throws(() => parseLocalCommandPolicy({ ...policy, trusted: null }))
})

test('the built-in names start in a terminal by name, through PATH; a path or another name does not', () => {
  const policy = pairedLocalCommandPolicy()
  for (const argv of [['claude'], ['claude', '--continue'], ['codex', 'exec', 'x'], ['t3']]) {
    assert.equal(localTerminalCommandRefusal(policy, argv, 'linux'), undefined, argv.join(' '))
  }
  assert.equal(localTerminalCommandRefusal(policy, ['Claude.exe'], 'win32'), undefined)
  assert.equal(localTerminalCommandRefusal(policy, ['CODEX'], 'darwin'), undefined)
  assert.equal(localTerminalCommandRefusal(policy, ['/tmp/x/claude'], 'linux'), 'path_needs_allow_all')
  assert.equal(localTerminalCommandRefusal(policy, ['bash'], 'linux'), 'not_allowlisted')
  assert.equal(localTerminalCommandRefusal(policy, ['claude-code'], 'linux'), 'not_allowlisted')
  const codexOnly = { ...policy, trusted: { ...none, codex: true } }
  assert.equal(localTerminalCommandRefusal(codexOnly, ['claude'], 'linux'), 'not_allowlisted')
  assert.equal(localTerminalCommandRefusal(codexOnly, ['codex'], 'linux'), undefined)
})

test('the denylist wins over every trusted entry and every signature', async () => {
  const policy = { ...pairedLocalCommandPolicy(), denylist: ['claude *', 'kelpie *'] }
  assert.equal(localTerminalCommandRefusal(policy, ['claude', '-p'], 'linux'), 'denied')
  assert.equal(localCommandPolicyPermits({ descriptor: {}, commandPolicy: policy }, 'claude', ['-p']), false)
  const bin = await binFolder('kelpie')
  try {
    const verifier = fakeVerifier([bin.file('kelpie')])
    const decision = await localTerminalCommandDecision(policy, ['kelpie', 'mcp'],
      { ...verifier.options, env: { PATH: bin.dir } })
    assert.deepEqual(decision, { allowed: false, refusal: 'denied' })
    assert.equal(verifier.calls.length, 0, 'a denied program is never even looked at')
  } finally { await bin.done() }
})

test('an allowlist with no rules and nothing trusted is an enforced "No programs"', async () => {
  const state = { descriptor: {}, commandPolicy: noPrograms }
  for (const program of ['git', 'claude', 'codex', 't3', 'sh']) {
    assert.equal(localCommandPolicyPermits(state, program, []), false, program)
    assert.equal(localTerminalCommandRefusal(noPrograms, [program], 'linux'), 'not_allowlisted', program)
  }
  const bin = await binFolder('signed-tool')
  try {
    const verifier = fakeVerifier([bin.file('signed-tool')])
    assert.deepEqual(await localTerminalCommandDecision(noPrograms, ['signed-tool'],
      { ...verifier.options, env: { PATH: bin.dir } }), { allowed: false, refusal: 'not_allowlisted' })
    assert.equal(verifier.calls.length, 0, 'with UnlikeOtherAI off no signature is checked')
  } finally { await bin.done() }
})

test('the guest command lane admits the trusted names but never by signature', () => {
  const state = { descriptor: {}, commandPolicy: pairedLocalCommandPolicy() }
  assert.equal(localCommandPolicyPermits(state, 'claude', ['-p', 'hi']), true)
  assert.equal(localCommandPolicyPermits(state, 'codex', []), true)
  assert.equal(localCommandPolicyPermits(state, 't3', ['--help']), true)
  assert.equal(localCommandPolicyPermits(state, 'kelpie', ['mcp']), false)
  assert.equal(localCommandPolicyPermits(state, 'git', ['status']), false)
})

test('a program signed by UnlikeOtherAI starts from the exact verified file', async () => {
  const bin = await binFolder('nessie-tool')
  try {
    const file = bin.file('nessie-tool')
    const verifier = fakeVerifier([file])
    const separator = signing === 'win32' ? ';' : ':'
    const decision = await localTerminalCommandDecision(pairedLocalCommandPolicy(), ['nessie-tool', '--json'],
      { ...verifier.options, env: { PATH: `relative${separator}${bin.dir}` } })
    assert.deepEqual(decision, { allowed: true, argv: [file, '--json'] })
    assert.equal(verifier.calls.length, 1)
    assert.equal(verifier.calls[0]!.checked, file)
    if (signing === 'darwin') {
      assert.deepEqual(verifier.calls[0], {
        file: '/usr/bin/codesign', args: ['--verify', '--strict', '-R', UNLIKEOTHERAI_MAC_REQUIREMENT, file], checked: file,
      })
    }
  } finally { await bin.done() }
})

test('a spoofed name never counts as UnlikeOtherAI: only the signature decides', async () => {
  const bin = await binFolder('kelpie', 'nessie-executor', 'UnlikeOtherAI')
  try {
    const verifier = fakeVerifier([])
    for (const name of ['kelpie', 'nessie-executor', 'UnlikeOtherAI']) {
      const decision = await localTerminalCommandDecision(pairedLocalCommandPolicy(), [name],
        { ...verifier.options, env: { PATH: bin.dir } })
      assert.deepEqual(decision, { allowed: false, refusal: 'not_allowlisted' }, name)
    }
    const absolute = await localTerminalCommandDecision(pairedLocalCommandPolicy(), [bin.file('kelpie')],
      { ...verifier.options, env: {} })
    assert.deepEqual(absolute, { allowed: false, refusal: 'path_needs_allow_all' })
    assert.equal(verifier.calls.length, 4, 'each candidate was put to the signature check, and each failed')
  } finally { await bin.done() }
})

test('a signed program reached through a symbolic link is verified and started as its target', {
  skip: WINDOWS_SYMLINK_SKIP,
}, async () => {
  const bin = await binFolder('real-tool')
  try {
    const target = bin.file('real-tool')
    const links = join(bin.dir, 'links')
    await mkdir(links)
    await symlink(target, join(links, 'tool'))
    const verifier = fakeVerifier([target])
    const decision = await localTerminalCommandDecision(pairedLocalCommandPolicy(), [join(links, 'tool')],
      { ...verifier.options, env: {} })
    assert.deepEqual(decision, { allowed: true, argv: [target] })
  } finally { await bin.done() }
})

test('Windows asks Authenticode for the exact UnlikeOtherAI publisher', async () => {
  const bin = await binFolder('tool')
  try {
    const file = bin.file('tool')
    const seen: Array<{ file: string; env: NodeJS.ProcessEnv }> = []
    const answer = (stdout: string): SignatureCommandRunner => async (program, _args, env) => {
      seen.push({ file: program, env })
      return { code: 0, stdout }
    }
    const valid = JSON.stringify({ status: 'Valid', subject: UNLIKEOTHERAI_WINDOWS_PUBLISHER })
    assert.equal(await verifiedUnlikeOtherAiProgram(file, { platform: 'win32', systemRoot: 'C:\\Windows',
      run: answer(valid) }), file)
    assert.equal(seen[0]!.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.equal(seen[0]!.env.NESSIE_PROGRAM_TRUST_PATH, file, 'the path travels as data, never as script')
    for (const stdout of [
      JSON.stringify({ status: 'Valid', subject: 'CN=UnlikeOtherAI s.r.o.' }),
      JSON.stringify({ status: 'Valid', subject: `${UNLIKEOTHERAI_WINDOWS_PUBLISHER}, OU=Other` }),
      JSON.stringify({ status: 'HashMismatch', subject: UNLIKEOTHERAI_WINDOWS_PUBLISHER }),
      JSON.stringify({ status: 'NotSigned', subject: '' }),
      'not json',
    ]) {
      assert.equal(windowsSignatureNamesUnlikeOtherAi(stdout), false, stdout)
      assert.equal(await verifiedUnlikeOtherAiProgram(file, { platform: 'win32', systemRoot: 'C:\\Windows',
        run: answer(stdout) }), undefined, stdout)
    }
    assert.equal(await verifiedUnlikeOtherAiProgram(file, { platform: 'win32', systemRoot: undefined,
      run: answer(valid) }), undefined, 'no system root, no PowerShell to trust')
  } finally { await bin.done() }
})

test('Linux has no verifiable signature, so UnlikeOtherAI covers nothing there', async () => {
  const bin = await binFolder('tool')
  try {
    const run: SignatureCommandRunner = async () => { throw new Error('nothing to run on Linux') }
    assert.equal(await verifiedUnlikeOtherAiProgram(bin.file('tool'), { platform: 'linux', run }), undefined)
    assert.deepEqual(await localTerminalCommandDecision(pairedLocalCommandPolicy(), ['tool'],
      { platform: 'linux', env: { PATH: bin.dir }, run }), { allowed: false, refusal: 'not_allowlisted' })
  } finally { await bin.done() }
  assert.deepEqual(programDefaults('linux').map(({ id, available }) => [id, available]), [
    ['unlikeotherai', false], ['claudeCode', true], ['codex', true], ['t3Code', true],
  ])
  assert.deepEqual(programDefaults('darwin')[0], { id: 'unlikeotherai', verifiedBy: 'signature', available: true })
  assert.deepEqual(programDefaults('win32').slice(1).map(({ program }) => program), ['claude', 'codex', 't3'])
})

test('a missing or non-file program is never verified', async () => {
  const bin = await binFolder()
  try {
    const run: SignatureCommandRunner = async () => ({ code: 0, stdout: '' })
    assert.equal(await verifiedUnlikeOtherAiProgram(join(bin.dir, 'absent'), { platform: signing, run }), undefined)
    assert.equal(await verifiedUnlikeOtherAiProgram(bin.dir, { platform: signing, run }), undefined)
  } finally { await bin.done() }
})
