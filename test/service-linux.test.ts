import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCommand } from '../src/cli-arguments.js'
import {
  disableExecutorService,
  enableExecutorService,
  executorServiceStatus,
} from '../src/service-linux.js'
import { executorServiceStateRoot, type ExecutorServiceEnvironment } from '../src/service-environment.js'

type RecordedCommand = { args: string[]; file: string }

type Harness = {
  commands: RecordedCommand[]
  environment: ExecutorServiceEnvironment
  output: string[]
}

const harness = (overrides: Partial<ExecutorServiceEnvironment> = {}): Harness => {
  const commands: RecordedCommand[] = []
  const output: string[] = []
  const environment: ExecutorServiceEnvironment = {
    confirm: async () => true,
    home: '/home/person',
    interactive: true,
    listStateDirectories: async () => ['executor-one'],
    loadPairedState: async () => undefined,
    platform: 'linux',
    run: async (file, args) => {
      commands.push({ args, file })
      return { code: 0, stdout: '' }
    },
    username: 'person',
    verifyPackagedRuntime: async () => undefined,
    write: (line) => output.push(line),
    ...overrides,
  }
  return { commands, environment, output }
}

/**
 * The service module runs only on Linux and joins its unit and state paths
 * with that host's separators, so the cases that compare those paths are
 * staged only where they would ever be produced. The rest run everywhere.
 */
const LINUX_PATHS = process.platform === 'win32'
  ? 'The systemd unit and XDG state paths are Linux paths, joined with the separators of the host that runs them.'
  : false

const rejects = async (action: Promise<unknown>): Promise<string> => {
  try {
    await action
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  assert.fail('expected a refusal')
}

test('the parser accepts the service commands without a state directory', () => {
  assert.deepEqual(parseCommand(['enable', 'executor-one']), {
    assumeYes: false,
    executorId: 'executor-one',
    kind: 'enable',
  })
  assert.deepEqual(parseCommand(['enable', 'executor-one', '--yes']), {
    assumeYes: true,
    executorId: 'executor-one',
    kind: 'enable',
  })
  assert.deepEqual(parseCommand(['disable', 'executor-one']), {
    executorId: 'executor-one',
    kind: 'disable',
  })
  assert.deepEqual(parseCommand(['status']), { kind: 'status' })
  assert.deepEqual(parseCommand(['status', 'executor-one']), {
    executorId: 'executor-one',
    kind: 'status',
  })
  assert.deepEqual(parseCommand(['status', '--state-root', '/home/person/state']), {
    kind: 'status',
    stateRoot: '/home/person/state',
  })
  assert.throws(() => parseCommand(['enable']), /Usage: nessie-executor/)
  assert.throws(() => parseCommand(['disable', '--yes']), /Usage: nessie-executor/)
})

test('enable verifies pairing and the packaged runtime before touching systemd', { skip: LINUX_PATHS }, async () => {
  const order: string[] = []
  const { commands, environment } = harness({
    loadPairedState: async (stateDir) => {
      assert.equal(stateDir, '/home/person/.local/state/nessie-executor/executor-one')
      order.push('state')
    },
    verifyPackagedRuntime: async () => {
      order.push('runtime')
    },
  })
  await enableExecutorService({ assumeYes: true, executorId: 'executor-one' }, environment)
  assert.deepEqual(order, ['state', 'runtime'])
  assert.deepEqual(commands, [
    { args: ['--user', 'daemon-reload'], file: 'systemctl' },
    { args: ['--user', 'enable', '--now', 'nessie-executor@executor-one.service'], file: 'systemctl' },
    { args: ['enable-linger'], file: 'loginctl' },
  ])
})

test('enable names the pairing failure instead of leaking a bare filesystem error', async () => {
  const { commands, environment } = harness({
    loadPairedState: async () => {
      throw new Error("ENOENT: no such file or directory, lstat '/home/person/.local/state/nessie-executor/gone'")
    },
  })
  const message = await rejects(enableExecutorService({ assumeYes: true, executorId: 'gone' }, environment))
  assert.match(message, /^Team gone has no usable settings in/)
  assert.match(message, /Add this computer to the team first/)
  assert.deepEqual(commands, [])
})

test('an unverifiable packaged runtime stops enable before any systemd call', async () => {
  const { commands, environment } = harness({
    verifyPackagedRuntime: async () => {
      throw new Error('The Nessie Computer runtime failed verification: nessie-executor-runtime is not owned by root.')
    },
  })
  const message = await rejects(enableExecutorService({ assumeYes: true, executorId: 'executor-one' }, environment))
  assert.match(message, /failed verification/)
  assert.deepEqual(commands, [])
})

test('enable explains lingering and refuses without a TTY unless --yes is given', async () => {
  const { commands, environment, output } = harness({ interactive: false })
  const message = await rejects(enableExecutorService({ assumeYes: false, executorId: 'executor-one' }, environment))
  assert.match(message, /Run it again with --yes/)
  assert.deepEqual(commands, [])
  assert.ok(output.some((line) => line.includes('after you log out')))
})

test('a declined confirmation changes nothing', async () => {
  const { commands, environment } = harness({ confirm: async () => false })
  const message = await rejects(enableExecutorService({ assumeYes: false, executorId: 'executor-one' }, environment))
  assert.equal(message, 'Nothing was changed.')
  assert.deepEqual(commands, [])
})

test('a systemd failure names the command and its exit status', async () => {
  const { environment } = harness({
    run: async (file, args) => (
      args.includes('enable') ? { code: 1, stdout: '' } : { code: 0, stdout: '' }
    ),
  })
  const message = await rejects(enableExecutorService({ assumeYes: true, executorId: 'executor-one' }, environment))
  assert.equal(
    message,
    'systemctl --user enable --now nessie-executor@executor-one.service exited with status 1.',
  )
})

test('enable refuses a state directory the unit template would not read', async () => {
  const { environment } = harness()
  const message = await rejects(enableExecutorService(
    { assumeYes: true, executorId: 'executor-one', stateDir: '/srv/elsewhere' },
    environment,
  ))
  assert.match(message, /would start a different team/)
  await enableExecutorService(
    { assumeYes: true, executorId: 'executor-one', stateDir: '/home/person/.local/state/nessie-executor/executor-one' },
    environment,
  )
})

test('a malformed executor id is refused before it becomes a unit name', async () => {
  const { environment } = harness()
  assert.match(
    await rejects(enableExecutorService({ assumeYes: true, executorId: '../../etc' }, environment)),
    /malformed/,
  )
  assert.match(await rejects(disableExecutorService({ executorId: 'a b' }, environment)), /malformed/)
  assert.match(
    await rejects(enableExecutorService({ assumeYes: true, executorId: 'x'.repeat(129) }, environment)),
    /malformed/,
  )
})

test('these commands are Linux-only and say so elsewhere', async () => {
  const { commands, environment } = harness({ platform: 'darwin' })
  assert.match(
    await rejects(enableExecutorService({ assumeYes: true, executorId: 'executor-one' }, environment)),
    /works only on Linux \(this computer runs darwin\)/,
  )
  assert.match(await rejects(disableExecutorService({ executorId: 'executor-one' }, environment)), /only on Linux/)
  assert.match(await rejects(executorServiceStatus({}, environment)), /only on Linux/)
  assert.deepEqual(commands, [])
})

test('disable stops and disables the unit and never touches lingering', async () => {
  const { commands, environment, output } = harness()
  await disableExecutorService({ executorId: 'executor-one' }, environment)
  assert.deepEqual(commands, [
    { args: ['--user', 'disable', '--now', 'nessie-executor@executor-one.service'], file: 'systemctl' },
  ])
  assert.ok(output.some((line) => line.includes('Lingering is unchanged')))
})

test('status reports paired executors, unit state, and lingering as plain lines', { skip: LINUX_PATHS }, async () => {
  const { environment, output } = harness({
    listStateDirectories: async (stateRoot) => {
      assert.equal(stateRoot, '/home/person/.local/state/nessie-executor')
      return ['executor-one', 'executor-two']
    },
    run: async (_file, args) => {
      if (args.includes('Linger')) return { code: 0, stdout: 'Linger=yes\n' }
      if (!args.includes('is-active')) return { code: 0, stdout: 'enabled\n' }
      const first = args.includes('nessie-executor@executor-one.service')
      // `systemctl is-active` answers "inactive" with exit status 3.
      return first ? { code: 0, stdout: 'active\n' } : { code: 3, stdout: 'inactive\n' }
    },
  })
  await executorServiceStatus({}, environment)
  assert.deepEqual(output, [
    'state root: /home/person/.local/state/nessie-executor',
    'linger: yes',
    'team executor-one: active=active enabled=enabled autorestart=on',
    'team executor-two: active=inactive enabled=enabled autorestart=on',
  ])
})

test('status says so when nothing is paired, and refuses an unpaired named executor', { skip: LINUX_PATHS }, async () => {
  const { environment, output } = harness({
    listStateDirectories: async () => [],
    run: async () => ({ code: 1, stdout: '' }),
  })
  await executorServiceStatus({}, environment)
  assert.deepEqual(output, [
    'state root: /home/person/.local/state/nessie-executor',
    'linger: unknown',
    'No teams on this computer.',
  ])
  assert.match(
    await rejects(executorServiceStatus({ executorId: 'executor-one' }, environment)),
    /No team with id/,
  )
})

test('the service state root is the documented XDG state path', { skip: LINUX_PATHS }, () => {
  assert.equal(executorServiceStateRoot('/home/person'), '/home/person/.local/state/nessie-executor')
})
