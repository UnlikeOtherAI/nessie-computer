import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { identityNames } from '../src/coding-session/host-identity.js'
import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { alive, createCodingHarness, waitUntil, type CodingHarness } from './coding-session-harness.js'

/**
 * The coding-sessions bridge as the daemon drives it: a real bridge process
 * started through `createExecutorMcpSessionManager`, detached session hosts,
 * and the scripted coding agent speaking Claude Code's and Codex's protocols.
 * The bridge holds nothing in memory, so killing it between any two calls
 * must change nothing a caller can see.
 */

const started = async (harness: CodingHarness, args: Record<string, unknown>): Promise<string> => {
  const answer = await harness.call('session_start', { agent: 'claude', root: 'work', ...args })
  assert.equal(answer.ok, true, JSON.stringify(answer.body))
  return answer.body.sessionId as string
}

const lastResultText = (body: Record<string, unknown>): string => (body.lastResult as { text: string } | undefined)?.text ?? ''

test('a session survives bridge restarts, and its turn ends in a result', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ idleTimeoutMs: 200 })
  try {
    // The turn is held open until the test has seen it: a bridge respawn and
    // the detached host's start race each other, and a timed turn could end
    // before the new bridge first answers, leaving `working` never observed.
    const sessionId = await started(harness, { prompt: '#hold=first first task' })
    await harness.restartBridge()
    const working = await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    assert.equal(working.turn, 1)
    await harness.restartBridge()
    // The turn ends while no bridge is running; the next bridge reads its result.
    await harness.release('first')
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    assert.match(lastResultText(done), /first task/)
    // What the session has cost across its turns, for a ticket's spend.
    assert.equal(done.totalCostUsd, 0.01)
    const listed = await harness.call('session_list', {})
    assert.deepEqual((listed.body.sessions as { sessionId: string }[]).map((entry) => entry.sessionId), [sessionId])
    assert.deepEqual(listed.body.agents, ['claude', 'codex', 'terminal'], 'the terminal is built in')
  } finally {
    await harness.cleanup()
  }
})

test('a follow-up written during a turn folds into that turn', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    // Held, not timed: the follow-up must reach the agent while the turn runs.
    const sessionId = await started(harness, { prompt: '#hold=parser build the parser' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    assert.equal((await harness.call('session_send', { sessionId, message: 'also add tests' })).ok, true)
    await waitUntil(async () => ((await harness.agents()).some((entry) =>
      entry.event === 'message' && entry.text === 'also add tests') ? true : undefined), 30_000, 'the agent to receive the follow-up')
    await harness.release('parser')
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    assert.match(lastResultText(done), /build the parser \| also add tests/)
    assert.equal(done.turn, 1)
  } finally {
    await harness.cleanup()
  }
})

test('interrupt stops the turn and the session takes the next message', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#sleep=60000 a very long job' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    assert.equal((await harness.call('session_interrupt', { sessionId })).body.interrupted, true)
    const stopped = await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted')
    assert.equal((stopped.lastResult as { subtype: string }).subtype, 'error_during_execution')
    await harness.call('session_send', { sessionId, message: 'something short instead' })
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    assert.match(lastResultText(done), /something short instead/)
    assert.equal(done.turn, 2)
    assert.equal((await harness.agents()).filter((entry) => entry.event === 'start').length, 1)
  } finally {
    await harness.cleanup()
  }
})

test('close kills the agent and the grandchild that escaped its group', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#fork #sleep=60000 work on it' })
    const grandchild = await waitUntil(async () => {
      const name = (await readdir(harness.recordDir)).find((entry) => entry.startsWith('grandchild-'))
      return name ? Number(name.slice('grandchild-'.length, -'.pid'.length)) : undefined
    }, 30_000, 'the grandchild')
    const agent = (await harness.agents()).find((entry) => entry.event === 'start')!.pid as number
    assert.equal(alive(grandchild), true)
    assert.equal((await harness.call('session_close', { sessionId })).body.status, 'closing')
    await harness.waitForStatus(sessionId, (body) => body.status === 'closed')
    await waitUntil(async () => (!alive(agent) && !alive(grandchild) ? true : undefined), 15_000, 'the tree to die')
    const refused = await harness.call('session_send', { sessionId, message: 'more' })
    assert.equal(refused.code, 'coding_session_closed')
  } finally {
    await harness.cleanup()
  }
})

test('a host killed with -9 reads as host_lost, and the next send resumes without a second agent', {
  timeout: 150_000,
}, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#sleep=120000 a long refactor' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    // Working precedes the agent's init. This case needs a durably confirmed transcript;
    // the following case checks replay of messages lost before that confirmation.
    await waitUntil(async () => {
      const state = JSON.parse(await readFile(
        join(harness.stateDir, 'sessions', sessionId, 'session.json'), 'utf8',
      )) as { agentSessionStarted?: boolean }
      return state.agentSessionStarted === true ? true : undefined
    }, 30_000, 'the agent session confirmation to be persisted')
    const lockPath = join(harness.stateDir, 'sessions', sessionId, 'host.lock')
    const host = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }
    const firstAgent = (await harness.agents()).find((entry) => entry.event === 'start')!
    // Windows hands a dead pid to a new process within seconds, so "stopped" is judged by pid and start time.
    const control = createCodingProcessControl()
    const firstIdentity = await control.identify(firstAgent.pid as number)
    assert.ok(firstIdentity?.startedAt, 'the first agent is running')
    process.kill(host.pid, 'SIGKILL')
    const lost = await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted')
    assert.equal(lost.reason, 'host_lost')
    assert.match(String(lost.pendingNotice), /host stopped/)
    await harness.call('session_send', { sessionId, message: 'carry on' })
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', undefined, 60_000)
    assert.match(lastResultText(done), /carry on/)
    const starts = (await harness.agents()).filter((entry) => entry.event === 'start')
    assert.equal(starts.length, 2)
    assert.equal(starts[1]!.resume, true)
    assert.equal(starts[1]!.sessionId, firstAgent.sessionId)
    const survivor = await control.identify(firstAgent.pid as number)
    const firstStillRunning = survivor?.startedAt === firstIdentity.startedAt
    assert.deepEqual([firstStillRunning, alive(starts[1]!.pid as number)], [false, true],
      'exactly one agent after the resume: the lost host\'s was stopped first')
  } finally {
    await harness.cleanup()
  }
})

test('a host lost before the agent confirmed its session hands every message to the next agent', {
  timeout: 240_000,
}, async () => {
  const harness = await createCodingHarness()
  try {
    // The agent has the task and says nothing, not even its init: the start has left the
    // inbox, and the session is unconfirmed.
    const sessionId = await started(harness, { prompt: '#quiet=gap the original task' })
    const session = join(harness.stateDir, 'sessions', sessionId)
    const inboxEmpty = (what: string) => waitUntil(async () => (
      (await readdir(join(session, 'inbox'))).some((name) => name.endsWith('.json')) ? undefined : true), 30_000, what)
    const agentsHave = (count: number, what: string) => waitUntil(async () => (
      (await harness.agents()).filter((entry) => entry.event === 'message').length === count ? true : undefined), 60_000, what)
    const killHost = async (): Promise<void> => {
      process.kill((JSON.parse(await readFile(join(session, 'host.lock'), 'utf8')) as { pid: number }).pid, 'SIGKILL')
      const lost = await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted')
      assert.equal(lost.reason, 'host_lost')
    }
    await agentsHave(1, 'the agent to receive the task')
    await inboxEmpty('the start to leave the inbox')
    await killHost()
    await harness.call('session_send', { sessionId, message: 'carry on' })
    // The next agent has both, says nothing either, and its host goes the same way.
    await agentsHave(2, 'the next agent to receive both')
    await inboxEmpty('the follow-up to leave the inbox')
    await killHost()
    await harness.call('session_send', { sessionId, message: 'and more' })
    await waitUntil(async () => ((await harness.agents()).filter((entry) => entry.event === 'start').length === 3 ? true : undefined),
      60_000, 'the third agent')
    await harness.release('gap')
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', undefined, 60_000)
    assert.match(lastResultText(done), /the original task\s+carry on\s+and more/u,
      'nothing an agent was given before it confirmed its session is lost with it, however many go')
    const starts = (await harness.agents()).filter((entry) => entry.event === 'start')
    for (const next of starts.slice(1)) {
      assert.equal(next.resume, false, 'an id the agent never confirmed is not resumed')
      assert.equal(starts.filter((entry) => entry.sessionId === next.sessionId).length, 1, 'nor claimed again')
    }
    const state = JSON.parse(await readFile(join(session, 'session.json'), 'utf8')) as Record<string, unknown>
    assert.equal(state.agentSessionStarted, true)
    assert.equal(state.firstPrompt, undefined, 'once confirmed, the first message is the agent\'s own transcript\'s to keep')
  } finally {
    await harness.cleanup()
  }
})

test('a start its host died holding, before its agent was ready, reaches the next agent once', { timeout: 150_000 }, async () => {
  // Every agent holds its `initialize` answer until the test lets it go, as a Claude that is slow to boot does.
  const harness = await createCodingHarness({ agentEnv: { inheritUserSession: false, set: { NESSIE_SCRIPTED_HOLD_INIT: 'boot' } } })
  try {
    const sessionId = await started(harness, { prompt: 'the original task' })
    const session = join(harness.stateDir, 'sessions', sessionId)
    // The first message is on disk, flushed with the agent's identity, and the start is still in the inbox.
    await waitUntil(async () => {
      const state = JSON.parse(await readFile(join(session, 'session.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>
      return state.agentIdentity !== undefined && state.firstPrompt === 'the original task' ? true : undefined
    }, 60_000, 'the booting agent to be recorded')
    assert.ok((await readdir(join(session, 'inbox'))).some((name) => name.endsWith('.json')), 'the start is still waiting')
    process.kill((JSON.parse(await readFile(join(session, 'host.lock'), 'utf8')) as { pid: number }).pid, 'SIGKILL')
    await harness.release('boot')
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', undefined, 60_000)
    assert.equal(done.turn, 1)
    const messages = (await harness.agents()).filter((entry) => entry.event === 'message').map((entry) => entry.text)
    assert.deepEqual(messages, ['the original task'], 'the start again is the first message itself, never a copy in front of it')
  } finally {
    await harness.cleanup()
  }
})

test('codex keeps one app-server per session, its turns share one thread, and a failed turn says why',
  { timeout: 120_000 }, async () => {
    const harness = await createCodingHarness()
    try {
      const sessionId = await started(harness, { agent: 'codex', prompt: 'first change' })
      const first = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
      assert.match(lastResultText(first), /Codex done: first change/)
      const sent = await harness.call('session_send', { sessionId, message: 'second change' })
      // The turn it was sent at, so a caller that never read the session knows turn 2 is the answer.
      assert.deepEqual([sent.body.status, sent.body.turn], ['waiting_for_input', 1])
      const second = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2)
      assert.match(lastResultText(second), /Codex done: second change/)
      const codex = (await harness.agents()).filter((entry) => entry.agent === 'codex')
      assert.equal(codex.filter((entry) => entry.event === 'start').length, 1, 'one app-server serves both turns')
      const threads = codex.filter((entry) => entry.event === 'thread')
      assert.deepEqual(threads.map((entry) => [entry.resume, entry.sandbox, entry.approvalPolicy]),
        [[false, 'read-only', 'on-request']], 'the reviewed default stance: read-only, asking before leaving it')
      assert.ok((threads[0]!.configKeys as string[]).includes('mcp_servers.nessie_session.command'),
        'the session\'s request_secret server is added beside the owner\'s own')
      const failing = await started(harness, { agent: 'codex', prompt: '#codexfail anything' })
      const failed = await harness.waitForStatus(failing, (body) => body.status === 'waiting_for_input')
      const result = failed.lastResult as { isError: boolean; subtype: string; text: string }
      assert.equal(result.isError, true)
      assert.equal(result.subtype, 'error')
      assert.match(result.text, /usage limit/)
    } finally {
      await harness.cleanup()
    }
  })

test('an idle codex app-server is ended, and the next message resumes its thread', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ codingSessions: { idleMinutes: 0.02 } })
  try {
    const sessionId = await started(harness, { agent: 'codex', prompt: 'first change' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    await waitUntil(async () => ((await harness.agents()).some((entry) => entry.agent === 'codex' && entry.event === 'exit')
      ? true : undefined), 30_000, 'the idle app-server to end')
    await harness.call('session_send', { sessionId, message: 'second change' })
    const second = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2)
    assert.match(lastResultText(second), /Codex done: second change/)
    const threads = (await harness.agents()).filter((entry) => entry.agent === 'codex' && entry.event === 'thread')
    assert.deepEqual(threads.map((entry) => entry.resume), [false, true])
    assert.equal(threads[1]!.threadId, threads[0]!.threadId)
  } finally {
    await harness.cleanup()
  }
})

test('a CLI whose --help lacks a flag the adapter passes is refused before it starts', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ agentEnv: { inheritUserSession: false, set: { NESSIE_SCRIPTED_HELP: 'older' } } })
  try {
    const sessionId = await started(harness, { prompt: 'anything' })
    const failed = await harness.waitForStatus(sessionId, (body) => body.status === 'failed')
    assert.equal(failed.reason, 'agent_outdated')
    assert.deepEqual((await harness.agents()).filter((entry) => entry.event === 'start'), [], 'no agent process started')
  } finally {
    await harness.cleanup()
  }
})

test('no host path, no account data and no OS user or host name reach any answer', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#path #deny #test #secret #identity report back' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    const events = await harness.call('session_status', { sessionId, detail: 'events', cursor: '0.0.0' })
    const kinds = (events.body.events as { kind: string }[]).map((event) => event.kind)
    assert.ok(kinds.includes('tool') && kinds.includes('result') && kinds.includes('user'))
    const review = await harness.call('session_review', { sessionId })
    assert.equal((review.body.lastTest as { exitCode: number }).exitCode, 3)
    assert.equal(review.body.branch, 'main')
    assert.equal(review.body.totalCostUsd, 0.01, 'a review\'s status states what the session has cost')
    await harness.call('session_list', {})
    const all = harness.outputs.join('\n')
    assert.match(all, /<work>\/README\.md/)
    assert.match(all, /<host path>/)
    assert.match(all, /GH_TOKEN=<secret>/)
    const [user] = identityNames([userInfo().username])
    const [host] = identityNames([hostname()])
    // A login matching a host alias is redacted as <host>; either placeholder hides the user.
    if (user && host) assert.match(all, /got '<(?:user|host)>@<host>\.\(none\)'/u)
    const names = [user, host].filter((name): name is string => name !== undefined)
    const forbidden = [
      harness.root, harness.dir, homedir(), tmpdir(), 'person@example.com', 'Private Org', 'Private Docs',
      // A token the agent printed, and a value the configuration set, never leave the host.
      `ghp_${'Z9y8'.repeat(9)}`, 'from-config',
      // Nor do the OS user and host names git and a shell prompt print (a generic or two-letter one is left alone).
      ...names,
    ]
    for (const value of forbidden) {
      for (const spelling of new Set([value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\'), value.toLowerCase()])) {
        assert.equal(all.includes(spelling), false, `an answer carried ${spelling}`)
      }
    }
    const denials = events.body.permissionDenials as { tool: string; summary: string }[]
    assert.deepEqual(denials, [{ tool: 'Bash', summary: 'git push --force' }])
  } finally {
    await harness.cleanup()
  }
})
