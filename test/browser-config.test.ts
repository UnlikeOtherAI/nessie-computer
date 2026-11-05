import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  configureExecutorBrowserSandbox,
  configureExecutorCodexSandbox,
  configureExecutorLocalPolicy,
} from '../src/pair.js'
import type { ExecutorHost } from '../src/host-platform.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { loadExecutorState, saveExecutorState } from '../src/state-store.js'
import { WINDOWS_GUEST_RESOURCES_SKIP } from './windows-prerequisites.js'

const exec = promisify(execFile)

// The configure paths now ask the host what sandbox it can start, so these
// policy tests pin a host with one instead of depending on the machine that
// happens to run them.
const sandboxHost: ExecutorHost = {
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  sandboxBackend: 'virtualization_framework',
  supervisor: 'desktop',
}

const initialState = (workspaceRoot: string) => ({
  apiBaseUrl: 'https://api.example.test',
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['file.list', 'file.read', 'file.write', 'workspace.review', 'sandbox.stop'],
    profiles: ['workspace_sandbox'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000221',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
})

const secureRuntimeFixture = async (stateDir: string, runtimeBundlePath: string): Promise<void> => {
  if (process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
    await ensureOwnerOnlyStateDirectory(stateDir)
    await ensureOwnerOnlyStateDirectory(runtimeBundlePath)
    await ensureOwnerOnlyStateDirectory(join(runtimeBundlePath, 'bin'))
    return
  }
  await mkdir(join(runtimeBundlePath, 'bin'), { mode: 0o700, recursive: true })
  await chmod(runtimeBundlePath, 0o700)
}

const vmArtifactFixture = (stateDir: string): {
  builderPath: string
  helperPath: string
  kernelPath: string
  writes: Array<Promise<void>>
} => {
  if (process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
    const resources = join(dirname(process.execPath), 'resources')
    return {
      builderPath: join(resources, 'guest', 'build-initrd.exe'),
      helperPath: join(resources, 'nessie-hyperv-bridge.exe'),
      kernelPath: join(resources, 'guest', 'bzImage'),
      writes: [],
    }
  }
  const builderPath = join(stateDir, 'build-initrd')
  const helperPath = join(stateDir, 'vm-helper')
  const kernelPath = join(stateDir, 'kernel')
  return {
    builderPath,
    helperPath,
    kernelPath,
    writes: [
      writeFile(builderPath, 'builder').then(() => chmod(builderPath, 0o700)),
      writeFile(helperPath, 'helper').then(() => chmod(helperPath, 0o700)),
      writeFile(kernelPath, 'kernel').then(() => chmod(kernelPath, 0o600)),
    ],
  }
}

test('Codex configuration stores only an owner-private source path and a pinned runtime', { skip: WINDOWS_GUEST_RESOURCES_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-codex-config-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-codex-workspace-'))
  const runtimeBundlePath = join(stateDir, 'guest-runtime')
  const { builderPath, helperPath, kernelPath, writes: artifactWrites } = vmArtifactFixture(stateDir)
  const authProfilePath = join(stateDir, 'codex-auth.json')
  try {
    await secureRuntimeFixture(stateDir, runtimeBundlePath)
    const codexRuntime = 'codex-runtime'
    const tmuxRuntime = 'tmux-runtime'
    await Promise.all([
      ...artifactWrites,
      writeFile(authProfilePath, '{"auth_mode":"chatgpt"}'),
      writeFile(join(runtimeBundlePath, 'bin', 'codex'), codexRuntime),
      writeFile(join(runtimeBundlePath, 'bin', 'tmux'), tmuxRuntime),
    ])
    await Promise.all([
      chmod(authProfilePath, 0o600),
      chmod(join(runtimeBundlePath, 'bin', 'codex'), 0o700),
      chmod(join(runtimeBundlePath, 'bin', 'tmux'), 0o700),
    ])
    await writeFile(join(runtimeBundlePath, 'nessie-guest-runtime.json'), JSON.stringify({
      entrypoints: { codex: 'bin/codex', tmux: 'bin/tmux' },
      files: [
        { executable: true, path: 'bin/codex', sha256: createHash('sha256').update(codexRuntime).digest('hex') },
        { executable: true, path: 'bin/tmux', sha256: createHash('sha256').update(tmuxRuntime).digest('hex') },
      ],
      version: 1,
    }))
    await chmod(join(runtimeBundlePath, 'nessie-guest-runtime.json'), 0o600)

    const state = initialState(workspaceRoot)
    await saveExecutorState(stateDir, state)
    const configured = await configureExecutorCodexSandbox(stateDir, state, {
      codexAuthProfilePath: authProfilePath,
      guestInitrdBuilderPath: builderPath,
      guestRuntimeBundlePath: runtimeBundlePath,
      kernelPath,
      vmHelperPath: helperPath,
    }, sandboxHost)
    assert.deepEqual(configured.codexSandbox, {
      codexAuthProfilePath: await realpath(authProfilePath),
      guestInitrdBuilderPath: await realpath(builderPath),
      guestRuntimeBundlePath: runtimeBundlePath,
      kernelPath: await realpath(kernelPath),
      vmHelperPath: await realpath(helperPath),
    })
    assert.deepEqual(configured.descriptor, {
      ...state.descriptor,
      operationKeys: [
        'file.list',
        'file.read',
        'file.write',
        'workspace.review',
        'sandbox.stop',
        'coding.launch',
        'coding.observe',
      ],
      profiles: ['workspace_sandbox', 'coding_session'],
      revision: 2,
    })
    assert.deepEqual(await loadExecutorState(stateDir), configured)

    if (process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
      await exec('icacls', [authProfilePath, '/grant', '*S-1-1-0:R'])
    } else {
      await chmod(authProfilePath, 0o644)
    }
    await assert.rejects(
      configureExecutorCodexSandbox(stateDir, configured, {
        codexAuthProfilePath: authProfilePath,
        guestInitrdBuilderPath: builderPath,
        guestRuntimeBundlePath: runtimeBundlePath,
        kernelPath,
        vmHelperPath: helperPath,
      }),
      /Codex auth profile must be owner-private/,
    )
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('browser configuration verifies owner-controlled guest artifacts before enabling the exact browser bundle', { skip: WINDOWS_GUEST_RESOURCES_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-config-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-workspace-'))
  const runtimeBundlePath = join(stateDir, 'guest-runtime')
  const { builderPath, helperPath, kernelPath, writes: artifactWrites } = vmArtifactFixture(stateDir)
  try {
    await secureRuntimeFixture(stateDir, runtimeBundlePath)
    const browserRuntime = 'browser-runtime'
    await Promise.all([
      ...artifactWrites,
      writeFile(join(runtimeBundlePath, 'bin', 'browser'), browserRuntime),
    ])
    await Promise.all([
      chmod(join(runtimeBundlePath, 'bin', 'browser'), 0o700),
    ])
    await writeFile(join(runtimeBundlePath, 'nessie-guest-runtime.json'), JSON.stringify({
      entrypoints: { browser: 'bin/browser' },
      files: [{
        executable: true,
        path: 'bin/browser',
        sha256: createHash('sha256').update(browserRuntime).digest('hex'),
      }],
      version: 1,
    }))
    await chmod(join(runtimeBundlePath, 'nessie-guest-runtime.json'), 0o600)

    const state = initialState(workspaceRoot)
    await saveExecutorState(stateDir, state)
    await assert.rejects(
      configureExecutorLocalPolicy(stateDir, state, ['browser.open'], undefined, sandboxHost),
      /browser\.open, browser\.observe, and browser\.act must be enabled together/,
    )
    await assert.rejects(
      configureExecutorLocalPolicy(
        stateDir, state, ['browser.open', 'browser.observe', 'browser.act'], undefined, sandboxHost,
      ),
      /Configure the owner-only browser VM and allowed origins/,
    )
    await assert.rejects(
      configureExecutorLocalPolicy(stateDir, state, [
        'browser.connected.open',
        'browser.connected.observe',
        'browser.connected.act',
        'sandbox.stop',
      ]),
      /private-run disclosure gate/,
    )

    const configured = await configureExecutorBrowserSandbox(stateDir, state, {
      allowedOrigins: ['https://console.example.test', 'https://app.example.test'],
      guestInitrdBuilderPath: builderPath,
      guestRuntimeBundlePath: runtimeBundlePath,
      kernelPath,
      vmHelperPath: helperPath,
    }, sandboxHost)
    assert.deepEqual(configured.browserSandbox?.allowedOrigins, [
      'https://app.example.test',
      'https://console.example.test',
    ])
    assert.deepEqual(configured.descriptor.operationKeys, [
      'file.list',
      'file.read',
      'file.write',
      'workspace.review',
      'sandbox.stop',
      'browser.open',
      'browser.observe',
      'browser.act',
    ])
    assert.equal(configured.descriptor.revision, 2)
    assert.deepEqual(await loadExecutorState(stateDir), configured)
    await assert.rejects(
      configureExecutorLocalPolicy(
        stateDir, configured, ['browser.open', 'browser.observe', 'browser.act'], undefined, sandboxHost,
      ),
      /require sandbox\.stop/,
    )
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})
