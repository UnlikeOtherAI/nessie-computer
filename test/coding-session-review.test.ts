import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runCommand } from '../src/coding-session/agent-env.js'
import { rewriteCodingAnswer } from '../src/coding-session/bridge-server.js'
import { pullRequestArgument } from '../src/coding-session/bridge-tools.js'
import { createPathRewriter } from '../src/coding-session/path-rewrite.js'
import { gitStartSnapshot, reviewCodingSession } from '../src/coding-session/review.js'
import { initialCodingSessionState } from '../src/coding-session/types.js'
import { createCodingHarness, initRepository, OWNER_B } from './coding-session-harness.js'

/** The review over a real git repository: what changed since the session started, worktrees included. */
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
  cwd, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' },
})

test('the review reports commits, diff, uncommitted work and the worktrees created since the start', { timeout: 60_000 }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-coding-review-')))
  try {
    const root = join(dir, 'repo')
    await initRepository(root)
    await writeFile(join(root, '.git', 'info', 'exclude'), '.worktrees/\n')
    const existing = join(root, '.worktrees', 'before')
    git(root, ['worktree', 'add', '-q', '-b', 'before', existing])
    const snapshot = await gitStartSnapshot(root)
    assert.match(snapshot.baseCommit ?? '', /^[0-9a-f]{40}$/u)
    assert.equal(snapshot.branch, 'main')
    assert.equal(snapshot.worktreesAtStart?.length, 2)
    await writeFile(join(root, 'feature.ts'), 'export const a = 1\n')
    git(root, ['add', 'feature.ts'])
    git(root, ['commit', '-q', '-m', 'add the feature'])
    await writeFile(join(root, 'README.md'), 'changed\n')
    await writeFile(join(root, 'scratch.txt'), 'untracked\n')
    const created = join(root, '.worktrees', 'agent-work')
    git(root, ['worktree', 'add', '-q', '-b', 'agent/fix', created])
    await writeFile(join(created, 'wip.ts'), 'x\n')
    const state = { ...initialCodingSessionState('2026-09-22T00:00:00.000Z'), ...snapshot, lastTest: { command: 'pnpm test', exitCode: 0 } }
    const review = await reviewCodingSession({
      folder: root, rootCanonical: root, state, run: undefined,
      rewriter: createPathRewriter([{ name: 'repo', paths: [root] }, { name: undefined, paths: [dir] }]),
    })
    assert.equal(review.branch, 'main')
    assert.deepEqual((review.commitsSinceStart as string[]).map((line) => line.replace(/^[0-9a-f]+ /u, '')), ['add the feature'])
    assert.ok((review.diffStat as string[]).some((line) => line.includes('feature.ts')))
    assert.equal(review.uncommitted, 1)
    assert.equal(review.untracked, 1)
    assert.deepEqual(review.worktreesCreatedSinceStart, [{
      path: '<repo>/.worktrees/agent-work', branch: 'agent/fix', commitsSinceStart: 1, uncommitted: 0, untracked: 1,
    }])
    assert.deepEqual(review.lastTest, { command: 'pnpm test', exitCode: 0 })
    assert.equal(JSON.stringify(review).includes(dir), false)
    assert.equal(review.staleIndexLock, undefined)
    // A git killed mid-commit leaves index.lock behind; the review says so, since every later git fails on it.
    await writeFile(join(root, '.git', 'index.lock'), '')
    const locked = await reviewCodingSession({
      folder: root, rootCanonical: root, state, rewriter: createPathRewriter([{ name: 'repo', paths: [root] }]),
    })
    assert.equal(locked.staleIndexLock, true)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('branch names and pull-request keys read <user>, while gh is asked by the real name', async () => {
  const worktree = join(tmpdir(), 'nessie-review-wt')
  const asked: string[] = []
  const review = await reviewCodingSession({
    folder: tmpdir(), rootCanonical: tmpdir(),
    state: { ...initialCodingSessionState('2026-09-23T00:00:00.000Z'), baseCommit: 'a'.repeat(40), worktreesAtStart: [] },
    rewriter: createPathRewriter([], process.platform, { users: ['ondre'], hosts: ['Minis'] }),
    run: async (file, args) => {
      const joined = args.join(' ')
      if (file === 'gh') {
        asked.push(args[2]!)
        return { code: 0, missing: false, stdout: JSON.stringify({ url: 'https://github.com/acme/app/pull/7', state: 'OPEN', statusCheckRollup: [] }) }
      }
      const stdout = joined.includes('--abbrev-ref') ? 'ondre/fix\n'
        : joined.includes('worktree list') ? `worktree ${worktree}\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/feature/ondre/wip\n\n`
          : joined.includes('log --oneline') ? 'abc1234 ondre fixed the build on Minis\n' : ''
      return { code: 0, missing: false, stdout }
    },
  })
  assert.equal(review.branch, '<user>/fix')
  assert.deepEqual(review.commitsSinceStart, ['abc1234 <user> fixed the build on <host>'])
  // A name in the middle of a branch is no folder of a relative path: it is rewritten too.
  assert.equal((review.worktreesCreatedSinceStart as { branch: string }[])[0]?.branch, 'feature/<user>/wip')
  assert.deepEqual(Object.keys(review.pullRequests as object), ['<user>/fix', 'feature/<user>/wip'])
  assert.deepEqual(asked, ['ondre/fix', 'feature/ondre/wip'])
  assert.equal(JSON.stringify(review).toLowerCase().includes('ondre'), false)
})

test('a pull request\'s URL keeps an owner spelled like the OS user, through the review and the last pass', async () => {
  const rewriter = createPathRewriter([], process.platform, { users: ['ondre'], hosts: ['Minis'] })
  const review = await reviewCodingSession({
    folder: tmpdir(), rootCanonical: tmpdir(), rewriter,
    state: { ...initialCodingSessionState('2026-09-23T00:00:00.000Z'), baseCommit: 'a'.repeat(40), worktreesAtStart: [] },
    run: async (file, args) => (file === 'gh'
      ? { code: 0, missing: false, stdout: JSON.stringify({ url: 'https://github.com/ondre/app/pull/7', state: 'OPEN', statusCheckRollup: [] }) }
      : { code: 0, missing: false, stdout: args.includes('--abbrev-ref') ? 'ondre-fix\n' : '' }),
  })
  type Answer = { branch: string; pullRequests: Record<string, { url: string }> }
  const answer = rewriteCodingAnswer(review, rewriter) as Answer
  assert.equal(answer.branch, '<user>-fix')
  assert.deepEqual(Object.values(answer.pullRequests).map((entry) => entry.url), ['https://github.com/ondre/app/pull/7'])
})

test('a pull request named by URL still reports its state after its branch was merged and deleted', { timeout: 60_000 }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-coding-review-pr-')))
  try {
    const root = join(dir, 'repo')
    await initRepository(root)
    await writeFile(join(root, '.git', 'info', 'exclude'), '.worktrees/\n')
    const snapshot = await gitStartSnapshot(root)
    // The coding agent's worktree and branch, merged and then deleted, as its CLAUDE.md tells it to.
    const created = join(root, '.worktrees', 'agent-work')
    git(root, ['worktree', 'add', '-q', '-b', 'agent/fix', created])
    await writeFile(join(created, 'fix.ts'), 'export const fixed = true\n')
    git(created, ['add', 'fix.ts'])
    git(created, ['commit', '-q', '-m', 'fix it'])
    git(root, ['worktree', 'remove', '--force', created])
    git(root, ['branch', '-D', 'agent/fix'])
    const url = 'https://github.com/ondre/app/pull/7'
    const asked: string[] = []
    const review = await reviewCodingSession({
      folder: root, rootCanonical: root, pullRequest: url,
      state: { ...initialCodingSessionState('2026-09-24T00:00:00.000Z'), ...snapshot },
      rewriter: createPathRewriter([{ name: 'repo', paths: [root] }], process.platform, { users: ['ondre'], hosts: [] }),
      // Real git; gh answers for the URL alone, as it does once the branch is gone.
      run: async (file, args, options) => {
        if (file !== 'gh') return runCommand(file, args, options)
        asked.push(args[2]!)
        assert.deepEqual(args.slice(3), ['--json', 'url,state,mergeable,statusCheckRollup'])
        if (args[2] !== url) return { code: 1, missing: false, stdout: '' }
        return {
          code: 0, missing: false,
          stdout: JSON.stringify({
            url, state: 'MERGED', mergeable: 'UNKNOWN',
            statusCheckRollup: Array.from({ length: 14 }, () => ({ conclusion: 'SUCCESS' })),
          }),
        }
      },
    })
    assert.deepEqual(review.worktreesCreatedSinceStart, [], 'the worktree is gone')
    assert.deepEqual(review.pullRequests, {}, 'the branch lookup finds nothing: main has no pull request')
    assert.deepEqual(asked.sort(), [url, 'main'].sort())
    assert.deepEqual(review.pullRequest, { url, state: 'MERGED', mergeable: 'UNKNOWN', checks: { success: 14 } })
    // The URL keeps its repository owner, spelled like the OS user, through the bridge's last pass.
    const answered = rewriteCodingAnswer(review, createPathRewriter([], process.platform, { users: ['ondre'], hosts: [] }))
    assert.equal((answered as { pullRequest: { url: string } }).pullRequest.url, url)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('a pull request gh cannot answer for is said to be unavailable, never left out', async () => {
  const url = 'https://github.com/acme/app/pull/12'
  type Outcome = { code: number | null; missing: boolean; stdout: string }
  const reviewedWith = async (gh: Outcome) => (await reviewCodingSession({
    folder: tmpdir(), rootCanonical: tmpdir(), pullRequest: url, state: undefined,
    rewriter: createPathRewriter([]),
    run: async (file) => (file === 'gh' ? gh : { code: 0, missing: false, stdout: '' }),
  })).pullRequest
  assert.deepEqual(await reviewedWith({ code: null, missing: true, stdout: '' }), { url, unavailable: 'gh_missing' })
  const failed = { url, unavailable: 'lookup_failed' }
  assert.deepEqual(await reviewedWith({ code: 1, missing: false, stdout: 'no pull requests found' }), failed)
  assert.deepEqual(await reviewedWith({ code: 0, missing: false, stdout: 'not json' }), failed)
  // Asked about nothing, the review has no such field at all.
  const plain = await reviewCodingSession({
    folder: tmpdir(), rootCanonical: tmpdir(), state: undefined, rewriter: createPathRewriter([]),
    run: async () => ({ code: 0, missing: false, stdout: '' }),
  })
  assert.equal('pullRequest' in plain, false)
})

test('only a github.com pull request URL is accepted, and nothing gh could read as an option', () => {
  for (const good of [
    'https://github.com/UnlikeOtherAI/Nessie/pull/670',
    'https://github.com/a/b.c_d-e/pull/1',
    'https://github.com/o-o/.github/pull/9999999999',
  ]) {
    assert.equal(pullRequestArgument(good), good)
  }
  for (const bad of [
    'http://github.com/o/r/pull/1', 'https://github.com.evil.example/o/r/pull/1', 'https://gitlab.com/o/r/pull/1',
    'https://github.com/o/r/pull/1/files', 'https://github.com/o/r/pull/1?x=1', 'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pulls/1', 'https://github.com/-o/r/pull/1', 'https://github.com/o/../pull/1',
    'https://github.com/o/r/issues/1', 'https://user@github.com/o/r/pull/1', '--repo=o/r', ' https://github.com/o/r/pull/1',
    `https://github.com/${'o'.repeat(40)}/r/pull/1`, 7, null, {},
  ]) {
    assert.throws(() => pullRequestArgument(bad), { code: 'coding_session_invalid_arguments' }, JSON.stringify(bad))
  }
})

test('the bridge\'s session_review takes a pull request URL and refuses anything else', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'open a pull request' })
    const sessionId = started.body.sessionId as string
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    for (const pullRequest of ['https://gitlab.com/o/r/pull/1', 'https://github.com/o/r/pull/1 --web', 12]) {
      const refused = await harness.call('session_review', { sessionId, pullRequest })
      assert.equal(refused.code, 'coding_session_invalid_arguments', JSON.stringify(pullRequest))
    }
    // Somebody else's session is not theirs to ask about, whatever they name.
    const url = 'https://github.com/example-owner/example-repo/pull/1'
    assert.equal((await harness.call('session_review', { sessionId, pullRequest: url }, { owner: OWNER_B })).code,
      'coding_session_not_found')
    // The harness gives the review a PATH with git alone: gh is missing, or, where found, finds no such pull request.
    const answer = await harness.call('session_review', { sessionId, pullRequest: url })
    assert.equal(answer.ok, true, JSON.stringify(answer.body))
    const named = answer.body.pullRequest as { url: string; unavailable?: string }
    assert.equal(named.url, url)
    assert.ok(named.unavailable === 'gh_missing' || named.unavailable === 'lookup_failed', JSON.stringify(named))
    assert.deepEqual(answer.body.pullRequests, {})
  } finally {
    await harness.cleanup()
  }
})

test('the review runs git and gh in the environment it is given, never the bridge\'s minimal one', async () => {
  const seen: { file: string; env?: NodeJS.ProcessEnv }[] = []
  await reviewCodingSession({
    folder: tmpdir(), rootCanonical: tmpdir(), state: undefined,
    rewriter: createPathRewriter([]),
    env: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/person' },
    run: async (file, args, options) => {
      seen.push({ file, ...(options?.env ? { env: options.env } : {}) })
      return { code: 0, missing: false, stdout: file === 'git' && args.includes('--abbrev-ref') ? 'feature\n' : '' }
    },
  })
  const git = seen.find((call) => call.file === 'git')!
  assert.equal(git.env?.PATH, '/opt/homebrew/bin:/usr/bin')
  assert.deepEqual([git.env?.GIT_OPTIONAL_LOCKS, git.env?.GIT_TERMINAL_PROMPT], ['0', '0'])
  const gh = seen.find((call) => call.file === 'gh')!
  assert.equal(gh.env?.PATH, '/opt/homebrew/bin:/usr/bin', 'Homebrew\'s gh is found the way the person finds it')
  assert.equal(gh.env?.GH_PROMPT_DISABLED, '1')
})
