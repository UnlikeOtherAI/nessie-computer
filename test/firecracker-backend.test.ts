import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createFirecrackerBackend,
  guestBootArgs,
  GUEST_BLOCK_DEVICE_ORDER,
} from '../src/firecracker/index.js'
import { GUEST_IMAGE_LABELS } from '../src/guest-images.js'
import { newGuestVmSessionId, type GuestVmBackendStartInput } from '../src/guest-vm-backend.js'
import { createFakeFirecracker } from './firecracker-fake.js'

/** The daemon is never root, so /dev/kvm access is the only host gate. */
const KVM_PRESENT = { access: async (): Promise<void> => undefined }
const KVM_ABSENT = {
  access: async (): Promise<void> => { throw new Error('EACCES') },
}

const IDENTITY = { gid: 1_000, uid: 1_000 }

/**
 * A session needs the host this backend runs on: its API and vsock sockets
 * are Unix sockets under a directory it proves owner-only by mode bits, and
 * Windows offers neither. The checks that need no session run everywhere.
 */
const LINUX_HOST_ONLY = process.platform === 'win32'
  ? 'Firecracker sessions need Unix sockets under a directory proved owner-only by mode bits; Windows offers neither.'
  : false

type StagedImages = { argv: string[][] }

/**
 * A stand-in for `mkfs.ext4` that records the argv and creates the image file,
 * so the backend's drive configuration is exercised without e2fsprogs. The
 * real builder is proven separately in guest-images.test.ts.
 */
const stageImageBuilder = (): {
  images: StagedImages
  spawnProcess: (input: { argv: string[]; path: string }) => Promise<void>
} => {
  const images: StagedImages = { argv: [] }
  return {
    images,
    spawnProcess: async ({ argv }) => {
      images.argv.push(argv)
      await writeFile(argv[argv.length - 2]!, '')
    },
  }
}

const stageRuntime = async (): Promise<{
  firecrackerPath: string
  input: (token: string, egressPath?: string) => GuestVmBackendStartInput
  root: string
}> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-firecracker-'))
  const resources = join(root, 'resources')
  await mkdir(resources, { mode: 0o700, recursive: true })
  const firecrackerPath = join(resources, 'firecracker')
  await writeFile(firecrackerPath, '#!/bin/sh\n')
  await chmod(firecrackerPath, 0o700)
  const kernelPath = join(root, 'vmlinux')
  const initrdPath = join(root, 'initrd')
  await writeFile(kernelPath, 'kernel')
  await writeFile(initrdPath, 'initrd')
  const sessionDirectory = join(root, 'session')
  await mkdir(join(sessionDirectory, 'runtime'), { mode: 0o700, recursive: true })
  await mkdir(join(sessionDirectory, 'work'), { mode: 0o700, recursive: true })
  return {
    firecrackerPath,
    input: (bootstrapToken, egressGatewaySocketPath) => ({
      bootstrapToken,
      consolePath: join(sessionDirectory, 'console'),
      ...(egressGatewaySocketPath ? { egressGatewaySocketPath } : {}),
      initrdPath,
      kernelPath,
      readyTimeoutMs: 10_000,
      resources: { memoryMiB: 4_096, vcpuCount: 2 },
      runtimeManifestDigest: `sha256:${'a'.repeat(64)}`,
      runtimeSnapshotPath: join(sessionDirectory, 'runtime'),
      sessionDirectory,
      sessionId: newGuestVmSessionId(),
      vmHelperPath: firecrackerPath,
      workspacePath: join(sessionDirectory, 'work'),
    }),
    root,
  }
}

test('the Firecracker backend runs without a jailer, as the daemon itself', { skip: LINUX_HOST_ONLY }, async () => {
  const staged = await stageRuntime()
  const bootstrapToken = randomBytes(32).toString('base64url')
  const { fake, spawnProcess } = createFakeFirecracker({ bootstrapToken })
  const builder = stageImageBuilder()
  try {
    const backend = createFirecrackerBackend({
      hostProbe: KVM_PRESENT,
      images: { builderPath: '/sbin/mkfs.ext4', identity: IDENTITY, spawnProcess: builder.spawnProcess },
      spawnProcess,
    })
    assert.equal(backend.kind, 'firecracker')
    const started = staged.input(bootstrapToken)
    const session = await backend.start(started)

    // The Firecracker binary itself is spawned — no jailer, no chroot, no root.
    assert.equal(fake.firecrackerPath, staged.firecrackerPath)
    assert.deepEqual(fake.firecrackerArgv, [
      '--api-sock', join(fake.socketDirectory, 'api.sock'),
      '--id', started.sessionId,
    ])
    // Default seccomp stays on: the disabling flag is never passed.
    assert.equal(fake.firecrackerArgv.includes('--no-seccomp'), false)
    assert.equal(fake.firecrackerArgv.some((value) => /[;&|]/.test(value)), false)
    assert.equal(fake.consolePath, started.consolePath)

    // The exact configuration sequence, and no network interface at all.
    assert.deepEqual(fake.calls.map((call) => call.path), [
      '/boot-source',
      '/machine-config',
      '/vsock',
      '/drives/runtime',
      '/drives/workspace',
      '/drives/draft',
      '/actions',
    ])
    assert.deepEqual(fake.calls[0].body, {
      boot_args: guestBootArgs({ egress: false, runtimeManifestDigest: started.runtimeManifestDigest }),
      initrd_path: started.initrdPath,
      kernel_image_path: started.kernelPath,
    })
    assert.deepEqual(fake.calls[2].body, { guest_cid: 3, uds_path: join(fake.socketDirectory, 'v.sock') })

    // Every share is a block device because Firecracker has no virtio-fs, and
    // only the draft is writable.
    assert.deepEqual(fake.calls.slice(3, 6).map((call) => call.body), [
      {
        drive_id: 'runtime',
        is_read_only: true,
        is_root_device: false,
        path_on_host: join(started.sessionDirectory, 'images', 'runtime.img'),
      },
      {
        drive_id: 'workspace',
        is_read_only: true,
        is_root_device: false,
        path_on_host: join(started.sessionDirectory, 'images', 'workspace.img'),
      },
      {
        drive_id: 'draft',
        is_read_only: false,
        is_root_device: false,
        path_on_host: join(started.sessionDirectory, 'images', 'draft.img'),
      },
    ])
    // Each image carries the label the guest checks against the attach order.
    assert.deepEqual(
      builder.images.argv.map((argv) => argv[argv.indexOf('-L') + 1]),
      GUEST_BLOCK_DEVICE_ORDER.map((device) => device.label),
    )

    // The guest's own frames reach the shared control client unchanged.
    assert.deepEqual(await session.inspectRuntime(), {
      browser: true,
      claude: false,
      codex: true,
      tmux: true,
    })

    await session.stop()
    assert.deepEqual(fake.calls.at(-1)?.body, { action_type: 'SendCtrlAltDel' })
    await assert.rejects(stat(fake.socketDirectory), /ENOENT/)
    await assert.rejects(stat(join(started.sessionDirectory, 'images')), /ENOENT/)
  } finally {
    await fake.stop()
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('the guest is told its shares are block devices, and never on macOS', async () => {
  const digest = `sha256:${'b'.repeat(64)}`
  const args = guestBootArgs({ egress: true, runtimeManifestDigest: digest })
  assert.equal(args.includes('nessie.shares=block'), true)
  assert.equal(args.includes('nessie.egress=1'), true)
  assert.equal(args.includes('rdinit=/init'), true)
  assert.equal(args.includes('console=ttyS0'), true)
  assert.equal(guestBootArgs({ egress: false, runtimeManifestDigest: digest }).includes('nessie.egress'), false)
  assert.deepEqual(
    GUEST_BLOCK_DEVICE_ORDER.map((device) => device.label),
    [GUEST_IMAGE_LABELS.runtime, GUEST_IMAGE_LABELS.workspace, GUEST_IMAGE_LABELS.draft],
  )
})

test('a session with forced egress boots with both guest channels listening', { skip: LINUX_HOST_ONLY }, async () => {
  const staged = await stageRuntime()
  const bootstrapToken = randomBytes(32).toString('base64url')
  const { fake, spawnProcess } = createFakeFirecracker({ bootstrapToken })
  const builder = stageImageBuilder()
  const gatewayDirectory = await mkdtemp(join(tmpdir(), 'nessie-egress-'))
  try {
    const backend = createFirecrackerBackend({
      hostProbe: KVM_PRESENT,
      images: { builderPath: '/sbin/mkfs.ext4', identity: IDENTITY, spawnProcess: builder.spawnProcess },
      spawnProcess,
    })
    const started = staged.input(bootstrapToken, join(gatewayDirectory, 'egress.sock'))
    const session = await backend.start(started)
    assert.equal((await stat(join(fake.socketDirectory, 'v.sock_49152'))).isSocket(), true)
    assert.equal((await stat(join(fake.socketDirectory, 'v.sock_49153'))).isSocket(), true)
    await session.stop()
  } finally {
    await fake.stop()
    await rm(gatewayDirectory, { force: true, recursive: true })
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a guest that never presents its control hello fails the session closed and cleans up', { skip: LINUX_HOST_ONLY }, async () => {
  const staged = await stageRuntime()
  const bootstrapToken = randomBytes(32).toString('base64url')
  const { fake, spawnProcess } = createFakeFirecracker({ bootGuest: false, bootstrapToken })
  const builder = stageImageBuilder()
  try {
    const backend = createFirecrackerBackend({
      hostProbe: KVM_PRESENT,
      images: { builderPath: '/sbin/mkfs.ext4', identity: IDENTITY, spawnProcess: builder.spawnProcess },
      spawnProcess,
    })
    const started = { ...staged.input(bootstrapToken), readyTimeoutMs: 250 }
    await assert.rejects(backend.start(started), /executor/i)
    await assert.rejects(stat(fake.socketDirectory), /ENOENT/)
    await assert.rejects(stat(join(started.sessionDirectory, 'images')), /ENOENT/)
  } finally {
    await fake.stop()
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a guest presenting the wrong bootstrap token is refused before any control byte is served', { skip: LINUX_HOST_ONLY }, async () => {
  const staged = await stageRuntime()
  const bootstrapToken = randomBytes(32).toString('base64url')
  // The guest speaks a well-formed hello carrying somebody else's token.
  const { fake, spawnProcess } = createFakeFirecracker({ bootstrapToken: randomBytes(32).toString('base64url') })
  const builder = stageImageBuilder()
  try {
    const backend = createFirecrackerBackend({
      hostProbe: KVM_PRESENT,
      images: { builderPath: '/sbin/mkfs.ext4', identity: IDENTITY, spawnProcess: builder.spawnProcess },
      spawnProcess,
    })
    const started = { ...staged.input(bootstrapToken), readyTimeoutMs: 2_000 }
    await assert.rejects(backend.start(started), /control authentication|timed out/i)
  } finally {
    await fake.stop()
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a host whose /dev/kvm is unreachable is refused with the group remedy named', async () => {
  const staged = await stageRuntime()
  try {
    const backend = createFirecrackerBackend({ hostProbe: KVM_ABSENT })
    await assert.rejects(
      backend.start(staged.input(randomBytes(32).toString('base64url'))),
      /kvm group/,
    )
  } finally {
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a missing Firecracker binary is named rather than guessed at', async () => {
  const staged = await stageRuntime()
  try {
    await rm(staged.firecrackerPath)
    const backend = createFirecrackerBackend({ hostProbe: KVM_PRESENT })
    await assert.rejects(
      backend.start(staged.input(randomBytes(32).toString('base64url'))),
      /Firecracker binary is not installed/,
    )
  } finally {
    await rm(staged.root, { force: true, recursive: true })
  }
})
