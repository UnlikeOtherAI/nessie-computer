import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  describeKelpie,
  kelpieDescribeCommand,
  kelpieDescriptionFromJson,
  kelpieDeviceFromDescribeEntry,
  stopKelpieDescribes,
} from '../src/kelpie-detect.js'

const OBSERVED = '2026-09-17T10:00:00.000Z'

const fullEntry = {
  address: '192.168.1.42',
  display: { height: 2556, width: 1179 },
  engine: 'webkit',
  id: 'kelpie-ios-9f2a',
  lastSeenAt: '2026-09-17T09:59:58.000Z',
  model: 'iPhone 17 Pro',
  name: "Ondrej's iPhone",
  paired: true,
  platform: 'ios',
  port: 51_873,
  runtimeMode: 'gui',
  version: '0.1.3',
}

test('reads every fact Kelpie advertises about an instance', () => {
  const device = kelpieDeviceFromDescribeEntry(fullEntry, OBSERVED)
  assert.ok(device)
  assert.equal(device.id, 'kelpie-ios-9f2a')
  assert.equal(device.name, "Ondrej's iPhone")
  assert.equal(device.model, 'iPhone 17 Pro')
  assert.equal(device.platform, 'ios')
  assert.equal(device.runtimeMode, 'gui')
  assert.equal(device.engine, 'webkit')
  assert.equal(device.version, '0.1.3')
  assert.equal(device.address, '192.168.1.42')
  assert.equal(device.port, 51_873)
  assert.deepEqual(device.display, { height: 2556, width: 1179 })
  assert.equal(device.paired, true)
  assert.equal(device.lastSeenAt, '2026-09-17T09:59:58.000Z')
})

test('a port is never assumed — every instance states its own', () => {
  // Kelpie instances pick their own port, so two on one network differ. A
  // reader that defaulted a port would point at the wrong browser.
  const first = kelpieDeviceFromDescribeEntry({ ...fullEntry, port: 51_873 }, OBSERVED)
  const second = kelpieDeviceFromDescribeEntry(
    { ...fullEntry, id: 'kelpie-mac-1', port: 8_390 },
    OBSERVED,
  )
  assert.equal(first?.port, 51_873)
  assert.equal(second?.port, 8_390)
  const portless = kelpieDeviceFromDescribeEntry(
    { ...fullEntry, port: undefined },
    OBSERVED,
  )
  assert.equal(portless, undefined, 'an instance with no port is not reachable and is dropped')
})

test('an entry missing an identity or an address is dropped, never defaulted', () => {
  for (const missing of ['id', 'name', 'address'] as const) {
    const entry: Record<string, unknown> = { ...fullEntry }
    delete entry[missing]
    assert.equal(
      kelpieDeviceFromDescribeEntry(entry, OBSERVED),
      undefined,
      `an entry with no ${missing} must be dropped`,
    )
  }
})

test('an unpaired instance reports as unpaired rather than being hidden', () => {
  // Kelpie refuses every automation method until a person pairs on the device,
  // so a discoverable-but-undrivable instance is a real state a person acts on.
  const device = kelpieDeviceFromDescribeEntry({ ...fullEntry, paired: false }, OBSERVED)
  assert.ok(device)
  assert.equal(device.paired, false)
})

test('a missing pairing fact reads as unpaired, not as paired', () => {
  const entry: Record<string, unknown> = { ...fullEntry }
  delete entry.paired
  assert.equal(kelpieDeviceFromDescribeEntry(entry, OBSERVED)?.paired, false)
})

test('unknown fields from a newer Kelpie are tolerated', () => {
  const device = kelpieDeviceFromDescribeEntry(
    { ...fullEntry, somethingNessieHasNeverHeardOf: { deeply: ['nested'] } },
    OBSERVED,
  )
  assert.ok(device, 'a field we do not know must not cost us the whole instance')
  assert.equal(device.id, 'kelpie-ios-9f2a')
})

test('falls back to the observation time when an instance states no last-seen', () => {
  const entry: Record<string, unknown> = { ...fullEntry }
  delete entry.lastSeenAt
  assert.equal(kelpieDeviceFromDescribeEntry(entry, OBSERVED)?.lastSeenAt, OBSERVED)
})

test('reads a whole describe document, with the CLI version', () => {
  // The real grammar `kelpie describe --json` emits: instances live under
  // `discovery`, beside the mDNS state and the scan budget.
  const description = kelpieDescriptionFromJson(JSON.stringify({
    cli: { path: '/opt/homebrew/bin/kelpie', version: '0.1.11' },
    discovery: {
      deviceCount: 2,
      devices: [fullEntry, { ...fullEntry, id: 'kelpie-mac-1', platform: 'macos' }],
      mdns: 'ok',
      scanTimeoutMs: 3_000,
    },
    schemaVersion: 1,
  }), OBSERVED)
  assert.equal(description?.cliVersion, '0.1.11')
  assert.equal(description?.devices.length, 2)
})

test('an installed Kelpie that found nothing reports an empty list, not absence', () => {
  // The two are different facts downstream: an empty list says "nothing is on
  // this network", absence says "this Kelpie could not tell me".
  const description = kelpieDescriptionFromJson(
    JSON.stringify({ discovery: { deviceCount: 0, devices: [], mdns: 'ok' }, schemaVersion: 1 }),
    OBSERVED,
  )
  assert.deepEqual(description?.devices, [])
})

test('a Kelpie that could not browse mDNS reports absence, never an empty network', () => {
  // It has not found nothing; it has not looked. Reporting [] here would tell
  // a person there are no browsers on their network, which is the one thing
  // this Kelpie cannot know.
  const description = kelpieDescriptionFromJson(
    JSON.stringify({
      discovery: { deviceCount: 0, devices: [], mdns: 'unavailable' },
      schemaVersion: 1,
    }),
    OBSERVED,
  )
  assert.equal(description, undefined)
})

test('a document that is not a describe document yields absence', () => {
  assert.equal(kelpieDescriptionFromJson('not json at all', OBSERVED), undefined)
  assert.equal(kelpieDescriptionFromJson('[]', OBSERVED), undefined)
  assert.equal(kelpieDescriptionFromJson('{"schemaVersion":1}', OBSERVED), undefined)
})

test('a network of more Kelpies than the wire carries truncates here', () => {
  const many = Array.from({ length: 50 }, (_, index) => ({ ...fullEntry, id: `kelpie-${index}` }))
  const description = kelpieDescriptionFromJson(
    JSON.stringify({ discovery: { devices: many, mdns: 'ok' }, schemaVersion: 1 }),
    OBSERVED,
  )
  assert.equal(description?.devices.length, 32)
})

test('describe runs the program the policy named, never a kelpie of its own', async () => {
  const seen: Array<readonly string[]> = []
  await describeKelpie(
    { command: ['/opt/kelpie/bin/kelpie', 'mcp'], name: 'kelpie' },
    {
      run: async (command) => {
        seen.push(command)
        return {
          ok: true,
          stdout: JSON.stringify({ discovery: { devices: [], mdns: 'ok' }, schemaVersion: 1 }),
        }
      },
    },
  )
  assert.deepEqual(seen, [['/opt/kelpie/bin/kelpie', 'describe', '--json', '--scan-timeout', '5000']])
})

test('describe is the policy’s own command with its trailing mcp replaced', () => {
  assert.deepEqual(kelpieDescribeCommand(['kelpie', 'mcp']), ['kelpie', 'describe', '--json', '--scan-timeout', '5000'])
  // A `node <script>` command keeps its script: describing `node` itself is
  // what detection used to do, and `node describe` is not Kelpie.
  assert.deepEqual(
    kelpieDescribeCommand(['node', 'C:/kelpie/packages/cli/bin/kelpie.js', 'mcp']),
    ['node', 'C:/kelpie/packages/cli/bin/kelpie.js', 'describe', '--json', '--scan-timeout', '5000'],
  )
  // Global flags stay, so an alias-pinned policy describes the same browser
  // its MCP session drives.
  assert.deepEqual(
    kelpieDescribeCommand(['node', 'kelpie.js', '--browser', 'probe', 'mcp']),
    ['node', 'kelpie.js', '--browser', 'probe', 'describe', '--json', '--scan-timeout', '5000'],
  )
})

test('a command that does not end in mcp is not described, and says nothing about instances', async () => {
  assert.equal(kelpieDescribeCommand(['kelpie', 'mcp', '--http']), undefined)
  assert.equal(kelpieDescribeCommand(['kelpie-mcp']), undefined)
  assert.equal(kelpieDescribeCommand(['mcp']), undefined)
  let ran = false
  const description = await describeKelpie(
    { command: ['kelpie-mcp'], name: 'kelpie' },
    { run: async () => { ran = true; return { ok: false } } },
  )
  assert.equal(description, undefined)
  assert.equal(ran, false, 'nothing is spawned for a command whose grammar is unknown')
})

// The real process runs below: the command shapes a policy actually names,
// through the same program resolution and environment the MCP session uses.
const FAKE_KELPIE = fileURLToPath(new URL('./fixtures/fake-kelpie-cli.mjs', import.meta.url))

test('a `node <script> mcp` command is described through its script', async () => {
  const description = await describeKelpie({ command: [process.execPath, FAKE_KELPIE, 'mcp'], name: 'kelpie' })
  assert.equal(description?.cliVersion, '0.1.12')
  assert.deepEqual(description?.devices.map((device) => device.id), ['kelpie-mac-1'])
})

test('an alias-pinned command describes that alias’s browser', async () => {
  const description = await describeKelpie({
    command: [process.execPath, FAKE_KELPIE, '--browser', 'probe', 'mcp'],
    name: 'kelpie',
  })
  // What Kelpie reports for a Windows browser today: found only through its
  // loopback probe, no display size, and never paired.
  assert.deepEqual(description?.devices, [{
    address: '127.0.0.1',
    display: { height: 0, width: 0 },
    id: 'local:127.0.0.1:8420',
    lastSeenAt: '2026-09-22T21:37:56.146Z',
    model: 'home=unset leak=unset',
    name: 'probe',
    paired: false,
    platform: 'windows',
    port: 8420,
    version: '0.1.1',
  }])
})

test('describe sees the environment the MCP session sees, not the daemon’s', async () => {
  const previous = process.env.NESSIE_TEST_DAEMON_ONLY
  process.env.NESSIE_TEST_DAEMON_ONLY = 'leaked'
  try {
    const description = await describeKelpie({
      command: [process.execPath, FAKE_KELPIE, 'mcp'],
      env: { KELPIE_HOME: 'alias-store' },
      name: 'kelpie',
    })
    assert.equal(description?.devices[0]?.model, 'home=alias-store leak=unset')
  } finally {
    if (previous === undefined) delete process.env.NESSIE_TEST_DAEMON_ONLY
    else process.env.NESSIE_TEST_DAEMON_ONLY = previous
  }
})

test('a program that is not installed yields absence rather than a throw', async () => {
  const description = await describeKelpie({
    command: [join(tmpdir(), `no-such-kelpie-${process.pid}`), 'mcp'],
    name: 'kelpie',
  })
  assert.equal(description, undefined)
})

test('a describe that outlives its budget is stopped and yields absence', async () => {
  const started = Date.now()
  const description = await describeKelpie(
    { command: [process.execPath, '-e', 'setTimeout(() => undefined, 30000)', 'mcp'], name: 'kelpie' },
    { timeoutMs: 300 },
  )
  assert.equal(description, undefined)
  assert.ok(Date.now() - started < 10_000, 'the budget, not the program, decides when detection gives up')
})

test('a kelpie.cmd shim is described on Windows', {
  skip: process.platform === 'win32'
    ? false
    : 'A .cmd shim only runs through cmd.exe, which exists only on Windows.',
}, async () => {
  // npm installs a global CLI on Windows as exactly this kind of shim, and
  // `execFile` refuses one outright (EINVAL on Node 24).
  const directory = await mkdtemp(join(tmpdir(), 'nessie-kelpie-shim-'))
  try {
    const shim = join(directory, 'kelpie.cmd')
    await writeFile(shim, `@"${process.execPath}" "${FAKE_KELPIE}" %*\r\n`)
    const description = await describeKelpie({ command: [shim, '--browser', 'probe', 'mcp'], name: 'kelpie' })
    assert.deepEqual(description?.devices.map((device) => [device.id, device.name]), [['local:127.0.0.1:8420', 'probe']])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

const HANGING_KELPIE = fileURLToPath(new URL('./fixtures/hanging-kelpie-cli.mjs', import.meta.url))

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Runs `command` as a Kelpie whose describe hangs and that starts a sleeping
 * process of its own, lets detection stop it for its budget, and answers the
 * two pids with those still running a moment after describe answered.
 */
const describeHangingTree = async (
  command: (directory: string) => Promise<string[]>,
  env: Record<string, string> = {},
): Promise<{ description: unknown; running: number[]; started: number[] }> => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-kelpie-hang-'))
  const pidFile = join(directory, 'kelpie.pid')
  const childPidFile = join(directory, 'child.pid')
  const started: number[] = []
  try {
    const description = await describeKelpie(
      {
        command: await command(directory),
        env: { ...env, NESSIE_TEST_CHILD_PID_FILE: childPidFile, NESSIE_TEST_PID_FILE: pidFile },
        name: 'kelpie',
      },
      { timeoutMs: 5_000 },
    )
    for (const file of [pidFile, childPidFile]) started.push(Number.parseInt(await readFile(file, 'utf8'), 10))
    assert.ok(started.every(Number.isSafeInteger), 'the hanging Kelpie and its child both started')
    // Describe answers once the tree is signalled; an exit can take a moment to show.
    const deadline = Date.now() + 2_000
    while (started.some(isRunning) && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 100) })
    }
    return { description, running: started.filter(isRunning), started }
  } finally {
    for (const pid of started) if (isRunning(pid)) process.kill(pid)
    await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('a describe stopped through a kelpie.cmd shim leaves no Kelpie process behind, nor one it started', {
  skip: process.platform === 'win32'
    ? false
    : 'Only a .cmd shim puts cmd.exe between the daemon and Kelpie.',
  timeout: 60_000,
}, async () => {
  // Killing the shim's cmd.exe alone left the Kelpie under it running, one
  // more orphan with every report sweep; a process of Kelpie's own sits one
  // level further down.
  const { description, running } = await describeHangingTree(async (directory) => {
    const shim = join(directory, 'kelpie.cmd')
    await writeFile(shim, `@"${process.execPath}" "${HANGING_KELPIE}" %*\r\n`)
    return [shim, 'mcp']
  })
  assert.equal(description, undefined)
  assert.deepEqual(running, [], 'the Kelpie under the shim and its child were stopped with it')
})

test('a describe stopped for its budget ends the process Kelpie started too', { timeout: 60_000 }, async () => {
  // Kelpie killed alone leaves its own child running with describe's stdout
  // open — on POSIX in the daemon's process group, where nothing ends it.
  const { description, running } = await describeHangingTree(async () => [process.execPath, HANGING_KELPIE, 'mcp'])
  assert.equal(description, undefined)
  assert.deepEqual(running, [], 'Kelpie and the process it started were both stopped')
})

test('a describe that exited while a process it started holds its output has that process stopped too', {
  skip: process.platform === 'win32'
    ? 'On Windows a descendant of an exited describe is out of reach without a Job Object.'
    : false,
  timeout: 60_000,
}, async () => {
  // Describe's pipes never close, so the budget runs out on a describe that has
  // already exited: its own pid is gone, but its process group is not.
  const { description, running } = await describeHangingTree(
    async () => [process.execPath, HANGING_KELPIE, 'mcp'], { NESSIE_TEST_EXIT_EARLY: '1' },
  )
  assert.equal(description, undefined)
  assert.deepEqual(running, [], 'what was left of describe\'s group was stopped')
})

test('the daemon\'s shutdown stops a describe still in flight, tree and all', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-kelpie-shutdown-'))
  const pidFiles = [join(directory, 'kelpie.pid'), join(directory, 'child.pid')]
  const started: number[] = []
  try {
    const describing = describeKelpie({
      command: [process.execPath, HANGING_KELPIE, 'mcp'],
      env: { NESSIE_TEST_PID_FILE: pidFiles[0]!, NESSIE_TEST_CHILD_PID_FILE: pidFiles[1]! },
      name: 'kelpie',
    }, { timeoutMs: 60_000 })
    const deadline = Date.now() + 20_000
    while (started.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 100) })
      const read = await Promise.all(pidFiles.map((file) => readFile(file, 'utf8').catch(() => '')))
      if (read.every(Boolean)) started.push(...read.map((text) => Number.parseInt(text, 10)))
    }
    assert.equal(started.length, 2, 'the hanging Kelpie and its child both started')
    const stoppedAt = Date.now()
    await stopKelpieDescribes()
    assert.equal(await describing, undefined)
    assert.ok(Date.now() - stoppedAt < 15_000, 'long before its own budget')
    const gone = Date.now() + 2_000
    while (started.some(isRunning) && Date.now() < gone) await new Promise((resolve) => { setTimeout(resolve, 100) })
    assert.deepEqual(started.filter(isRunning), [])
  } finally {
    for (const pid of started) if (isRunning(pid)) process.kill(pid)
    await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('a Kelpie too old to describe itself yields absence rather than an empty inventory', async () => {
  const description = await describeKelpie(
    { command: ['kelpie', 'mcp'], name: 'kelpie' },
    { run: async () => ({ ok: false }) },
  )
  assert.equal(description, undefined)
})
