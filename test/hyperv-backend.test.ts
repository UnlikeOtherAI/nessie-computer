import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import type { GuestChannelListener } from '../src/firecracker/index.js'
import { newGuestVmSessionId, type GuestVmBackendStartInput } from '../src/guest-vm-backend.js'
import {
  bootDiskTree,
  createHyperVBackend,
  guestVmDiskLocations,
  hyperVSessionBootArgs,
  powerShellArgv,
  BOOT_DISK_INITRD_PATH,
  BOOT_DISK_LOADER_PATH,
  GUEST_SCSI_ATTACH_ORDER,
  HYPERV_BUILTIN_BOOT_ARGS,
  HYPERV_SCRIPTS,
} from '../src/hyperv/index.js'
import { encodeGuestFrame } from './firecracker-fake.js'

const VM_ID = '1d2b3c4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const SECTOR = 512

type ScriptCall = { argv: string[]; path: string }

/**
 * Stands a resource root up the way the installer does: the four pinned
 * scripts, the bridge beside them, and a manifest recording each script's real
 * digest. Nothing is faked about the pinning — the store hashes these exact
 * bytes.
 */
const stageResources = async (): Promise<{ digests: Record<string, string>; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-hyperv-'))
  await mkdir(join(root, 'scripts'), { mode: 0o700, recursive: true })
  const digests: Record<string, string> = {}
  for (const name of HYPERV_SCRIPTS) {
    const body = `# ${name}\n`
    await writeFile(join(root, 'scripts', name), body)
    digests[`scripts/${name}`] = createHash('sha256').update(body).digest('hex')
  }
  await writeFile(join(root, 'nessie-hyperv-bridge'), '')
  return { digests, root }
}

const stageSession = async (root: string): Promise<GuestVmBackendStartInput> => {
  const sessionDirectory = join(root, 'session')
  await mkdir(join(sessionDirectory, 'runtime'), { mode: 0o700, recursive: true })
  await mkdir(join(sessionDirectory, 'work'), { mode: 0o700, recursive: true })
  const kernelPath = join(root, 'bzImage')
  const initrdPath = join(root, 'guest-initrd')
  await writeFile(kernelPath, Buffer.alloc(4096))
  await writeFile(initrdPath, Buffer.alloc(4096))
  return {
    bootstrapToken: randomBytes(32).toString('base64url'),
    consolePath: join(sessionDirectory, 'console'),
    initrdPath,
    kernelPath,
    readyTimeoutMs: 10_000,
    resources: { memoryMiB: 4_096, vcpuCount: 2 },
    runtimeManifestDigest: `sha256:${'a'.repeat(64)}`,
    runtimeSnapshotPath: join(sessionDirectory, 'runtime'),
    sessionDirectory,
    sessionId: newGuestVmSessionId(),
    vmHelperPath: join(root, 'nessie-hyperv-bridge'),
    workspacePath: join(sessionDirectory, 'work'),
  }
}

/**
 * A named pipe and a Unix socket are the same object to `net`, so the transport
 * seam is exercised over a real socket rather than a mock: the fake guest below
 * dials it exactly as the bridge would. Only the name differs — `net` listens
 * on nothing but a `\\.\pipe\…` name on Windows — and a listen that fails
 * rejects rather than leaving the start waiting for a guest that never dials.
 */
const localListener = (directory: string): {
  listen: GuestChannelListener
  pathFor: (port: number) => string
} => {
  const pathFor = (port: number): string => (process.platform === 'win32'
    ? `\\\\.\\pipe\\${basename(directory)}-${port}`
    : join(directory, `${port}.sock`))
  return {
    listen: async (_prefix, port, onConnection) => {
      const socketPath = pathFor(port)
      const server: Server = createServer({ noDelay: true }, onConnection)
      await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.off('error', reject)
          server.on('error', () => undefined)
          resolvePromise()
        })
      })
      return {
        close: () => new Promise((resolvePromise) => { server.close(() => resolvePromise()) }),
        socketPath,
      }
    },
    pathFor,
  }
}

const stageBackend = async (): Promise<{
  calls: ScriptCall[]
  guests: Socket[]
  input: GuestVmBackendStartInput
  listen: GuestChannelListener
  resources: { digests: Record<string, string>; root: string }
  runScript: (call: { argv: string[]; path: string; timeoutMs: number }) => Promise<string>
}> => {
  const resources = await stageResources()
  const input = await stageSession(resources.root)
  const sockets = await mkdtemp(join(tmpdir(), 'nessie-hyperv-pipes-'))
  const local = localListener(sockets)
  const calls: ScriptCall[] = []
  const guests: Socket[] = []
  return {
    calls,
    guests,
    input,
    listen: local.listen,
    resources,
    runScript: async ({ argv, path }) => {
      calls.push({ argv, path })
      const script = argv[argv.indexOf('-File') + 1] ?? ''
      if (script.endsWith('create.ps1')) return JSON.stringify({ vmId: VM_ID })
      if (script.endsWith('start.ps1')) {
        // The guest boots and dials the control channel, exactly as it does
        // through the bridge on a real machine.
        const guest = createConnection({ path: local.pathFor(49_152) })
        guests.push(guest)
        guest.once('error', () => undefined)
        guest.once('connect', () => guest.write(encodeGuestFrame({
          kind: 'hello',
          payload: '',
          requestId: randomUUID(),
          sessionToken: input.bootstrapToken,
          version: 1,
        })))
      }
      return ''
    },
  }
}

const startBackend = async (staged: Awaited<ReturnType<typeof stageBackend>>): Promise<
  Awaited<ReturnType<ReturnType<typeof createHyperVBackend>['start']>>
> => {
  const backend = createHyperVBackend({
    // The boot disk is not stubbed: `buildGuestBootImage` writes a real FAT32
    // volume here, so the VHD wrapper and `Convert-VHD` see what a session does.
    digests: staged.resources.digests,
    hostProbe: { exists: async () => true },
    images: {
      builderPath: '/sbin/mkfs.ext4',
      identity: { gid: 1_000, uid: 1_000 },
      spawnProcess: async ({ argv }) => {
        await writeFile(argv[argv.length - 2]!, Buffer.alloc(2 * SECTOR))
      },
    },
    listenPort: staged.listen,
    runScript: staged.runScript,
    spawnBridge: () => ({ kill: () => true, exitCode: 0, signalCode: null } as never),
    systemRoot: 'C:\\Windows',
  })
  assert.equal(backend.kind, 'hyperv')
  return backend.start(staged.input)
}

test('the Hyper-V backend drives create, start, stop and remove as pinned scripts', async () => {
  const staged = await stageBackend()
  const session = await startBackend(staged)
  try {
    const scripts = staged.calls.map(
      (call) => (call.argv[call.argv.indexOf('-File') + 1] ?? '').split(/[/\\]/).pop(),
    )
    assert.deepEqual(scripts, ['create.ps1', 'start.ps1'])
    const create = staged.calls[0]!
    // Windows PowerShell, and the four flags that make a script run without a
    // profile, without a prompt, and without the execution policy in the way.
    assert.ok(create.path.endsWith('powershell.exe'))
    assert.deepEqual(create.argv.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    // Never a composed command string: every value is its own argv element.
    assert.equal(create.argv.some((value) => /[;&|`]/.test(value)), false)
    const parameters = new Map<string, string>()
    for (let index = 6; index < create.argv.length; index += 2) {
      parameters.set(create.argv[index]!, create.argv[index + 1]!)
    }
    assert.equal(parameters.get('-MemoryMiB'), '4096')
    assert.equal(parameters.get('-VcpuCount'), '2')
    assert.ok(parameters.get('-VmName')?.startsWith('nessie-executor-'))
    for (const disk of ['-BootDiskVhd', '-RuntimeDiskVhd', '-WorkspaceDiskVhd', '-DraftDiskVhd']) {
      assert.ok(parameters.get(disk)?.endsWith('.vhd'), `${disk} must be a fixed VHD`)
    }
  } finally {
    await session.stop()
    for (const guest of staged.guests) guest.destroy()
  }
  // Stop closes the control channel first and only then turns the machine off;
  // remove always follows, so no disk of a finished session survives.
  const after = staged.calls
    .map((call) => (call.argv[call.argv.indexOf('-File') + 1] ?? '').split(/[/\\]/).pop())
    .slice(2)
  assert.deepEqual(after, ['stop.ps1', 'remove.ps1'])
  const stop = staged.calls[2]!
  assert.equal(stop.argv[stop.argv.indexOf('-Mode') + 1], 'turnoff')
})

test('a script whose bytes are not the pinned ones is refused before anything is created', async () => {
  const staged = await stageBackend()
  await writeFile(join(staged.resources.root, 'scripts', 'create.ps1'), '# tampered\n')
  await assert.rejects(startBackend(staged), /does not match the signed package/)
  assert.deepEqual(staged.calls, [])
})

test('the block share images and the boot disk are named and ordered once', () => {
  assert.deepEqual(GUEST_SCSI_ATTACH_ORDER.map((entry) => entry.driveId), ['runtime', 'workspace', 'draft'])
  assert.deepEqual(GUEST_SCSI_ATTACH_ORDER.map((entry) => entry.label), [
    'nessie-runtime',
    'nessie-work',
    'nessie-draft',
  ])
  assert.deepEqual(GUEST_SCSI_ATTACH_ORDER.map((entry) => entry.readOnly), [true, true, false])
  // The boot disk is location 0 and the three shares follow it, with no gaps.
  assert.deepEqual(
    guestVmDiskLocations({
      bootVhdPath: 'boot.vhd',
      draftVhdPath: 'draft.vhd',
      runtimeVhdPath: 'runtime.vhd',
      workspaceVhdPath: 'workspace.vhd',
    }),
    [
      { controllerLocation: 0, path: 'boot.vhd' },
      { controllerLocation: 1, path: 'runtime.vhd' },
      { controllerLocation: 2, path: 'workspace.vhd' },
      { controllerLocation: 3, path: 'draft.vhd' },
    ],
  )
})

test('the boot disk names the two paths a generation 2 firmware reads', () => {
  const tree = bootDiskTree({ initrd: Buffer.alloc(1), kernel: Buffer.alloc(2) })
  // The removable-media default path a UEFI firmware boots with no NVRAM entry,
  // and the initrd the compiled-in command line names beside it.
  assert.equal(BOOT_DISK_LOADER_PATH, 'EFI/BOOT/BOOTX64.EFI')
  assert.equal(BOOT_DISK_INITRD_PATH, 'EFI/BOOT/initrd.img')
  const efi = tree[0]!
  assert.equal(efi.kind === 'directory' && efi.name, 'EFI')
  const boot = efi.kind === 'directory' ? efi.children[0]! : efi
  assert.deepEqual(
    boot.kind === 'directory' ? boot.children.map((child) => child.name) : [],
    ['BOOTX64.EFI', 'initrd.img'],
  )
})

test('the built-in command line matches the kernel the package builds', async () => {
  const configuration = await readFile(
    new URL('../guest/kernel/config', import.meta.url),
    'utf8',
  )
  // The kernel's CONFIG_CMDLINE escapes each backslash; the value itself is the
  // one the backend states, and a drift between the two is a guest that boots
  // with no arguments at all.
  const declared = /^CONFIG_CMDLINE="(.*)"$/m.exec(configuration)?.[1]
  assert.equal(declared?.replace(/\\\\/g, '\\'), HYPERV_BUILTIN_BOOT_ARGS)
  assert.ok(configuration.includes('CONFIG_EFI_STUB=y'))
  assert.ok(configuration.includes('CONFIG_HYPERV_VSOCKETS=y'))
  assert.ok(configuration.includes('CONFIG_HYPERV_STORAGE=y'))
  // The guest never mounts the boot disk, so it needs no FAT driver.
  assert.ok(configuration.includes('# CONFIG_VFAT_FS is not set'))
})

test('a session states its own arguments in the initrd, because the firmware states none', () => {
  const withGateway = hyperVSessionBootArgs({ egress: true, runtimeManifestDigest: 'sha256:abc' })
  assert.equal(
    withGateway,
    'nessie.runtime_manifest=sha256:abc nessie.runtime=1 nessie.workspace=1 nessie.shares=block nessie.egress=1',
  )
  // A command session has no gateway and must not be told it has one.
  assert.equal(
    hyperVSessionBootArgs({ egress: false, runtimeManifestDigest: 'sha256:abc' }).includes('nessie.egress'),
    false,
  )
  // The built-in half says where to find this half, and nothing else per-session.
  assert.ok(HYPERV_BUILTIN_BOOT_ARGS.includes('nessie.args=initrd'))
  assert.equal(HYPERV_BUILTIN_BOOT_ARGS.includes('nessie.runtime_manifest'), false)
})

test('a script parameter that could break out of its own argument is refused', () => {
  assert.throws(() => powerShellArgv('/s/create.ps1', [['VmName', 'a\nb']]), /parameter value is invalid/)
  assert.throws(() => powerShellArgv('/s/create.ps1', [['VmName', 'a\0b']]), /parameter value is invalid/)
  assert.throws(() => powerShellArgv('/s/create.ps1', [['Vm Name', 'a']]), /parameter name is invalid/)
})
