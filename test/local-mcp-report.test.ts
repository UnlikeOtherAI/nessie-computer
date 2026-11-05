import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createLocalMcpReporter } from '../src/local-mcp-report.js'
import type { ExecutorMcpSessionManager, ExecutorMcpProbeOutcome } from '../src/mcp-session-manager.js'

const sessionsAnswering = (
  outcomes: Record<string, ExecutorMcpProbeOutcome>,
  onProbe?: (server: string) => void,
): ExecutorMcpSessionManager => ({
  callTool: async () => ({}),
  listTools: async () => ({}),
  probe: async (server) => {
    onProbe?.(server)
    return outcomes[server] ?? { available: false, reason: 'not_probed' }
  },
  stopAll: async () => undefined,
})

test('an executor naming no server reports an empty array, never absence', async () => {
  // Absence means a daemon too old to report at all. An executor that reports
  // and names nothing is a different, knowable fact.
  const reporter = createLocalMcpReporter([], sessionsAnswering({}))
  try {
    assert.deepEqual(reporter.current(), [])
  } finally {
    reporter.stop()
  }
})

test('before the first sweep the report is absent, not an invented empty one', () => {
  const reporter = createLocalMcpReporter(
    [{ command: ['kelpie', 'mcp'], name: 'kelpie' }],
    sessionsAnswering({}),
  )
  try {
    assert.equal(reporter.current(), undefined)
  } finally {
    reporter.stop()
  }
})

test('an unavailable server carries the reason that tells a person what to do', async () => {
  const reporter = createLocalMcpReporter(
    [{ command: ['/nonexistent/kelpie', 'mcp'], name: 'kelpie' }],
    sessionsAnswering({ kelpie: { available: false, reason: 'not_installed' } }),
  )
  try {
    const report = await reporter.refresh()
    assert.equal(report.length, 1)
    assert.equal(report[0]!.available, false)
    assert.equal(report[0]!.reason, 'not_installed')
    assert.ok(report[0]!.observedAt, 'every status states when it was observed')
    assert.equal(
      report[0]!.kelpieDevices,
      undefined,
      'a Kelpie that is not installed was never probed for instances',
    )
  } finally {
    reporter.stop()
  }
})

test('an available non-Kelpie server is never enumerated for instances', async () => {
  const reporter = createLocalMcpReporter(
    [{ command: ['other-server'], name: 'other' }],
    sessionsAnswering({
      other: {
        available: true,
        catalogDigest: `sha256:${'a'.repeat(64)}`,
        serverVersion: '2.0.0',
        toolCount: 4,
      },
    }),
  )
  try {
    const report = await reporter.refresh()
    assert.equal(report[0]!.available, true)
    assert.equal(report[0]!.toolCount, 4)
    assert.equal(report[0]!.kelpieDevices, undefined)
  } finally {
    reporter.stop()
  }
})

test('every named server is probed, and one slow server does not hide another', async () => {
  const probed: string[] = []
  const reporter = createLocalMcpReporter(
    [
      { command: ['kelpie', 'mcp'], name: 'kelpie' },
      { command: ['other'], name: 'other' },
    ],
    sessionsAnswering(
      {
        kelpie: { available: false, reason: 'launch_failed' },
        other: { available: false, reason: 'handshake_failed' },
      },
      (server) => probed.push(server),
    ),
  )
  try {
    const report = await reporter.refresh()
    assert.deepEqual(probed.sort(), ['kelpie', 'other'])
    assert.deepEqual(
      report.map((status) => [status.server, status.reason]).sort(),
      [['kelpie', 'launch_failed'], ['other', 'handshake_failed']],
    )
  } finally {
    reporter.stop()
  }
})

test('a Kelpie whose describe throws costs only its own inventory, never the sweep', async () => {
  const reporter = createLocalMcpReporter(
    [
      { command: ['kelpie.cmd', 'mcp'], name: 'kelpie' },
      { command: ['other'], name: 'other' },
    ],
    sessionsAnswering({
      kelpie: { available: true, catalogDigest: `sha256:${'b'.repeat(64)}`, toolCount: 94 },
      other: { available: false, reason: 'handshake_failed' },
    }),
    {
      // What `execFile` did with a `.cmd` shim on Node 24: throw before any
      // process started, which rejected the whole sweep for every server.
      describe: () => { throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }) },
    },
  )
  try {
    const report = await reporter.refresh()
    const kelpie = report.find((status) => status.server === 'kelpie')
    assert.equal(kelpie?.available, true)
    assert.equal(kelpie?.toolCount, 94)
    assert.equal(kelpie?.kelpieDevices, undefined, 'not probed for instances, never an empty network')
    assert.equal(report.find((status) => status.server === 'other')?.reason, 'handshake_failed')
  } finally {
    reporter.stop()
  }
})

test('two refreshes at once join one sweep rather than racing probes', async () => {
  let probes = 0
  const reporter = createLocalMcpReporter(
    [{ command: ['kelpie', 'mcp'], name: 'kelpie' }],
    sessionsAnswering(
      { kelpie: { available: false, reason: 'not_installed' } },
      () => { probes += 1 },
    ),
  )
  try {
    await Promise.all([reporter.refresh(), reporter.refresh(), reporter.refresh()])
    assert.equal(probes, 1, 'a second caller joins the sweep in flight')
  } finally {
    reporter.stop()
  }
})
