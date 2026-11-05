import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { createGuestWorkspaceLease, releaseGuestWorkspaceLease } from '../src/guest-workspace-lease.js'
import {
  materializeGuestRuntimeBundle,
  removeGuestRuntimeBundleSnapshot,
  verifyGuestRuntimeBundle,
} from '../src/guest-runtime-bundle.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { startGuestVmSession } from '../src/guest-vm-session.js'
import { stopSandboxWorkspace } from '../src/sandbox-workspace.js'
import { WINDOWS_GUEST_RESOURCES_SKIP, WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

test('a guest COW lease is exact-run, path-derived, and fences sandbox teardown', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-guest-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-guest-state-'))
  const runId = '00000000-0000-4000-8000-000000000109'
  try {
    await writeFile(join(root, 'base.txt'), 'host source')
    const lease = await createGuestWorkspaceLease(stateDir, { name: 'workspace', path: root }, {
      bindingFence: '1',
      commandId: '00000000-0000-4000-8000-000000000110',
      runId,
    })
    assert.equal(lease.runId, runId)
    assert.notEqual(lease.workspace, await realpath(root))
    assert.equal(await readFile(join(lease.workspace, 'base.txt'), 'utf8'), 'host source')
    await assert.rejects(stopSandboxWorkspace(stateDir, runId), /active guest lease/)
    await assert.rejects(
      releaseGuestWorkspaceLease(stateDir, { ...lease, leaseId: '00000000-0000-4000-8000-000000000000' }),
      /does not match/,
    )
    await releaseGuestWorkspaceLease(stateDir, lease)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('guest runtime bundles pin every browser and coding artifact without host fallback', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const bundle = await mkdtemp(join(tmpdir(), 'nessie-guest-runtime-'))
  const snapshotParent = await mkdtemp(join(tmpdir(), 'nessie-guest-runtime-snapshot-'))
  const browserPath = join(bundle, 'bin', 'browser')
  const tmuxPath = join(bundle, 'bin', 'tmux')
  const codexPath = join(bundle, 'bin', 'codex')
  try {
    if (process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
      await ensureOwnerOnlyStateDirectory(bundle)
      await ensureOwnerOnlyStateDirectory(snapshotParent)
      await ensureOwnerOnlyStateDirectory(join(bundle, 'bin'))
    } else {
      await mkdir(join(bundle, 'bin'), { mode: 0o700 })
      await chmod(join(bundle, 'bin'), 0o700)
    }
    await Promise.all([
      writeFile(browserPath, 'browser-runtime'),
      writeFile(tmuxPath, 'managed-tmux'),
      writeFile(codexPath, 'managed-codex'),
    ])
    await Promise.all([chmod(browserPath, 0o700), chmod(tmuxPath, 0o700), chmod(codexPath, 0o700)])
    const manifest = {
      entrypoints: { browser: 'bin/browser', codex: 'bin/codex', tmux: 'bin/tmux' },
      files: [
        { executable: true, path: 'bin/browser', sha256: createHash('sha256').update('browser-runtime').digest('hex') },
        { executable: true, path: 'bin/codex', sha256: createHash('sha256').update('managed-codex').digest('hex') },
        { executable: true, path: 'bin/tmux', sha256: createHash('sha256').update('managed-tmux').digest('hex') },
      ],
      version: 1,
    }
    await writeFile(join(bundle, 'nessie-guest-runtime.json'), JSON.stringify(manifest))
    await chmod(join(bundle, 'nessie-guest-runtime.json'), 0o600)
    const verified = await verifyGuestRuntimeBundle(bundle)
    assert.equal(verified.root, bundle)
    assert.equal(verified.entrypoints.browser, 'bin/browser')
    assert.equal(verified.entrypoints.tmux, 'bin/tmux')
    const snapshot = await materializeGuestRuntimeBundle(verified, join(snapshotParent, 'runtime'))
    assert.equal(await readFile(join(snapshot.root, 'bin', 'codex'), 'utf8'), 'managed-codex')
    await assert.rejects(writeFile(join(snapshot.root, 'bin', 'codex'), 'replaced'), /EACCES|EPERM/)
    await writeFile(codexPath, 'tampered')
    assert.equal(await readFile(join(snapshot.root, 'bin', 'codex'), 'utf8'), 'managed-codex')
    await assert.rejects(verifyGuestRuntimeBundle(bundle), /integrity check failed/)
    await assert.rejects(
      materializeGuestRuntimeBundle(verified, join(snapshotParent, 'changed-runtime')),
      /integrity check failed/,
    )
    await writeFile(join(bundle, 'nessie-guest-runtime.json'), JSON.stringify({
      ...manifest,
      entrypoints: { ...manifest.entrypoints, hidden: 'bin/codex' },
    }))
    await assert.rejects(verifyGuestRuntimeBundle(bundle), /manifest is malformed/)
    await removeGuestRuntimeBundleSnapshot(snapshot.root)
  } finally {
    await rm(bundle, { force: true, recursive: true })
    await rm(snapshotParent, { force: true, recursive: true })
  }
})

test('a guest VM session mounts a private runtime snapshot and keeps its token out of argv', { skip: WINDOWS_GUEST_RESOURCES_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-session-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-session-state-'))
  const runId = '00000000-0000-4000-8000-000000000121'
  const packagedWindows = process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'
  const resources = join(dirname(process.execPath), 'resources')
  const builderPath = packagedWindows ? join(resources, 'guest', 'build-initrd.exe') : join(stateDir, 'builder')
  const helperPath = packagedWindows ? join(resources, 'nessie-hyperv-bridge.exe') : join(stateDir, 'helper')
  const kernelPath = packagedWindows ? join(resources, 'guest', 'bzImage') : join(stateDir, 'kernel')
  const runtimeBundlePath = join(stateDir, 'guest-runtime')
  const codexAuthProfilePath = join(stateDir, 'codex-auth.json')
  try {
    if (packagedWindows) {
      await ensureOwnerOnlyStateDirectory(stateDir)
      await ensureOwnerOnlyStateDirectory(runtimeBundlePath)
      await ensureOwnerOnlyStateDirectory(join(runtimeBundlePath, 'bin'))
    }
    await writeFile(join(root, 'base.txt'), 'host source')
    await Promise.all([
      ...(packagedWindows ? [] : [writeFile(builderPath, 'builder'), writeFile(helperPath, 'helper'), writeFile(kernelPath, 'kernel')]),
      writeFile(codexAuthProfilePath, '{"auth_mode":"chatgpt"}'),
    ])
    await Promise.all([
      ...(packagedWindows ? [] : [chmod(builderPath, 0o700), chmod(helperPath, 0o700), chmod(kernelPath, 0o600)]),
      chmod(codexAuthProfilePath, 0o600),
    ])
    if (!packagedWindows) {
      await mkdir(join(runtimeBundlePath, 'bin'), { mode: 0o700, recursive: true })
      await chmod(runtimeBundlePath, 0o700)
    }
    const browserRuntime = 'browser-runtime'
    await writeFile(join(runtimeBundlePath, 'bin', 'browser'), browserRuntime)
    await chmod(join(runtimeBundlePath, 'bin', 'browser'), 0o700)
    await writeFile(join(runtimeBundlePath, 'nessie-guest-runtime.json'), JSON.stringify({
      entrypoints: { browser: 'bin/browser' },
      files: [{ executable: true, path: 'bin/browser', sha256: createHash('sha256').update(browserRuntime).digest('hex') }],
      version: 1,
    }))
    await chmod(join(runtimeBundlePath, 'nessie-guest-runtime.json'), 0o600)
    const lease = await createGuestWorkspaceLease(stateDir, { name: 'workspace', path: root }, {
      bindingFence: '1',
      commandId: '00000000-0000-4000-8000-000000000122',
      runId,
    })
    const calls: Array<{ argv: string[]; input: string; path: string }> = []
    let resolveClosed: (() => void) | undefined
    const session = await startGuestVmSession({
      codexAuthProfilePath,
      ...(packagedWindows ? {} : { egressPolicy: { allowedOrigins: ['https://app.example.test'] } }),
      guestInitrdBuilderPath: builderPath,
      guestRuntimeBundlePath: runtimeBundlePath,
      kernelPath,
      lease,
      stateDir,
      vmHelperPath: helperPath,
    }, {
      // The macOS backend, named explicitly: this suite exercises the shared
      // session pipeline, not the host's own sandbox detection.
      host: { platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 }, sandboxBackend: 'virtualization_framework', supervisor: 'service' },
      runProcess: async (call) => { calls.push(call) },
      launchProcess: async (call) => {
        calls.push(call)
        return {
          closed: new Promise<void>((resolvePromise) => { resolveClosed = resolvePromise }),
          actBrowser: async (action) => {
            assert.deepEqual(action, { action: 'click', nodeId: 9 })
            return { status: 'acted' as const }
          },
          closeCodingSession: async () => {},
          inspectRuntime: async () => ({ browser: true, claude: false, codex: false, tmux: false }),
          launchCodingSession: async () => {},
          observeCodingSession: async () => ({ agent: 'codex' as const, lifecycle: 'running' as const }),
          observeBrowser: async () => ({
            accessibilityTree: [{ name: 'Save', nodeId: 9, role: 'button' }],
            targets: [{ title: 'Guide', type: 'page' as const, url: 'https://app.example.test/guide' }],
          }),
          openBrowser: async (url) => {
            assert.equal(url, 'https://app.example.test/guide')
          },
          runCommand: async () => ({ exitCode: 0, output: '', success: true }),
          stop: async () => { resolveClosed?.() },
        }
      },
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].path, await realpath(builderPath))
    assert.deepEqual(calls[0].argv.slice(-1), ['--bootstrap-token-stdin'])
    const authProfileIndex = calls[0].argv.indexOf('--codex-auth')
    assert.equal(authProfileIndex >= 0, true)
    assert.equal(calls[0].argv[authProfileIndex + 1], await realpath(codexAuthProfilePath))
    assert.equal(calls[0].argv.includes('{"auth_mode":"chatgpt"}'), false)
    assert.equal(calls[1].path, await realpath(helperPath))
    assert.equal(calls[1].input, calls[0].input)
    assert.equal(calls[1].argv[0], 'session')
    assert.equal(calls[1].argv.includes(lease.workspace), true)
    const runtimeBundleIndex = calls[1].argv.indexOf('--runtime-bundle')
    assert.equal(runtimeBundleIndex >= 0, true)
    const mountedRuntime = calls[1].argv[runtimeBundleIndex + 1]!
    assert.notEqual(mountedRuntime, runtimeBundlePath)
    assert.equal(await readFile(join(mountedRuntime, 'bin', 'browser'), 'utf8'), browserRuntime)
    await writeFile(join(runtimeBundlePath, 'bin', 'browser'), 'changed-source-runtime')
    assert.equal(await readFile(join(mountedRuntime, 'bin', 'browser'), 'utf8'), browserRuntime)
    const runtimeDigestIndex = calls[1].argv.indexOf('--runtime-manifest-digest')
    assert.equal(runtimeDigestIndex >= 0, true)
    assert.match(calls[1].argv[runtimeDigestIndex + 1]!, /^sha256:[a-f0-9]{64}$/)
    assert.equal(calls[1].argv.includes(calls[1].input), false)
    const gatewayIndex = calls[1].argv.indexOf('--egress-gateway')
    if (packagedWindows) {
      assert.equal(gatewayIndex, -1)
    } else {
      assert.equal(gatewayIndex >= 0, true)
      assert.match(calls[1].argv[gatewayIndex + 1]!, /egress\.sock$/)
    }
    assert.deepEqual(await session.inspectRuntime(), { browser: true, claude: false, codex: false, tmux: false })
    if (packagedWindows) {
      await assert.rejects(session.openBrowser('https://app.example.test/guide'), /no browser egress/u)
    } else {
      await session.openBrowser('https://app.example.test/guide')
      await assert.rejects(session.openBrowser('https://blocked.example.test/'), /not allowed by local policy/)
    }
    assert.deepEqual(await session.observeBrowser(), {
      accessibilityTree: [{ name: 'Save', nodeId: 9, role: 'button' }],
      targets: [{ title: 'Guide', type: 'page', url: 'https://app.example.test/guide' }],
    })
    assert.deepEqual(await session.actBrowser({ action: 'click', nodeId: 9 }), { status: 'acted' })
    await session.stop()
    await session.closed
    await assert.rejects(releaseGuestWorkspaceLease(stateDir, lease), /unavailable/)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})
