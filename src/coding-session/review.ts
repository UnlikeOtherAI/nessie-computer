import { access, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isInsideDirectory } from '../workspace-paths.js'
import { runCommand, type CommandRunner } from './agent-env.js'
import type { PathRewriter } from './path-rewrite.js'
import type { CodingSessionState } from './types.js'

/**
 * What a session actually changed, read with git alone: read-only commands,
 * no shell, no optional locks, a 20-second budget for the whole review.
 *
 * The coding agent usually works in a worktree of its own, so the review looks
 * beyond the session's folder at every worktree created under the root since
 * the session started. `gh pr view` adds each branch's pull request when `gh`
 * is installed. Every string in the answer has been through the rewriter,
 * branch names and the keys of `pullRequests` included (a branch is often
 * named after its author, and the bridge's last pass rewrites values, not
 * keys) — in every segment, since `feature/ondre/fix` is a name and not a
 * folder the model resolves; `gh` is still asked about each branch by its
 * real name. A pull
 * request's URL gets the path rules only: its owner is the repository's
 * (`github.com/ondre/app`), which is often spelled like the OS user, and the
 * link is the one thing in the review a person follows.
 *
 * A caller that already knows the pull request names it by URL, and gets
 * `pullRequest` beside the branch lookup: the coding agent usually deletes a
 * merged branch and its worktree, so the lookup by branch finds nothing just
 * when the answer is MERGED. It is the same `gh pr view`, within the same
 * budget, projected and rewritten the same way; one gh cannot answer says so
 * (`unavailable`) rather than leaving the field out.
 */
const REVIEW_BUDGET_MS = 20_000
const DIFF_STAT_LINES = 60
const COMMIT_LINES = 30

type Git = (args: string[], cwd: string) => Promise<string | undefined>

const gitRunner = (
  run: CommandRunner, deadline: number, env: NodeJS.ProcessEnv = process.env,
): Git => async (args, cwd) => {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return undefined
  const outcome = await run('git', ['--no-pager', ...args], {
    cwd, timeoutMs: Math.min(remaining, 10_000),
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  })
  return outcome.code === 0 ? outcome.stdout : undefined
}

type Worktree = { path: string; head?: string; branch?: string }

const parseWorktrees = (text: string): Worktree[] => text.split(/\r?\n\r?\n/u).flatMap((block) => {
  const lines = block.split(/\r?\n/u)
  const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
  if (!path) return []
  const head = lines.find((line) => line.startsWith('HEAD '))?.slice(5)
  const branch = lines.find((line) => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//u, '')
  return [{ path, ...(head ? { head } : {}), ...(branch ? { branch } : {}) }]
})

const canonical = async (path: string): Promise<string> => realpath(path).catch(() => path)

/** Recorded by the host before the agent's first turn: where "since the session started" begins. */
export const gitStartSnapshot = async (
  folder: string, run: CommandRunner = runCommand,
): Promise<Pick<CodingSessionState, 'baseCommit' | 'branch' | 'worktreesAtStart'>> => {
  const git = gitRunner(run, Date.now() + 10_000)
  const [head, branch, worktrees] = await Promise.all([
    git(['rev-parse', 'HEAD'], folder),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], folder),
    git(['worktree', 'list', '--porcelain'], folder),
  ])
  return {
    ...(head?.trim() ? { baseCommit: head.trim() } : {}),
    ...(branch?.trim() ? { branch: branch.trim() } : {}),
    worktreesAtStart: await Promise.all(parseWorktrees(worktrees ?? '').map((entry) => canonical(entry.path))),
  }
}

const porcelainCounts = (text: string | undefined): { uncommitted: number; untracked: number } | undefined => {
  if (text === undefined) return undefined
  const entries = text.split('\0').filter(Boolean)
  const untracked = entries.filter((entry) => entry.startsWith('??')).length
  return { uncommitted: entries.length - untracked, untracked }
}

type CheckCounts = Record<string, number>

/** One `gh pr view`, of a branch by its real name or of a pull request by its URL. */
const pullRequest = async (
  run: CommandRunner, target: string, cwd: string, deadline: number, rewriter: PathRewriter,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | undefined> => {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return undefined
  const outcome = await run('gh', ['pr', 'view', target, '--json', 'url,state,mergeable,statusCheckRollup'], {
    cwd, timeoutMs: Math.min(remaining, 10_000),
    env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  if (outcome.missing) return { unavailable: 'gh_missing' }
  if (outcome.code !== 0) return undefined
  try {
    const parsed = JSON.parse(outcome.stdout) as {
      url?: unknown; state?: unknown; mergeable?: unknown; statusCheckRollup?: unknown
    }
    const checks: CheckCounts = {}
    for (const check of Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : []) {
      const entry = check as { conclusion?: unknown; state?: unknown; status?: unknown }
      const key = String(entry.conclusion || entry.state || entry.status || 'unknown').toLowerCase().slice(0, 30)
      checks[key] = (checks[key] ?? 0) + 1
    }
    return {
      url: typeof parsed.url === 'string' ? rewriter.rewritePaths(parsed.url).slice(0, 300) : undefined,
      state: typeof parsed.state === 'string' ? parsed.state.slice(0, 30) : undefined,
      mergeable: typeof parsed.mergeable === 'string' ? parsed.mergeable.slice(0, 30) : undefined,
      checks,
    }
  } catch {
    return undefined
  }
}

export const reviewCodingSession = async (input: {
  folder: string
  rootCanonical: string
  rewriter: PathRewriter
  state: CodingSessionState | undefined
  /** The person's login-like environment, so `git` and `gh` are the ones they use. */
  env?: NodeJS.ProcessEnv
  /** A pull request to look up by URL, already checked against `GITHUB_PULL_REQUEST_URL`. */
  pullRequest?: string
  run?: CommandRunner
}): Promise<Record<string, unknown>> => {
  const run = input.run ?? runCommand
  const env = input.env ?? process.env
  const deadline = Date.now() + REVIEW_BUDGET_MS
  const git = gitRunner(run, deadline, env)
  const rewrite = (text: string): string => input.rewriter.rewrite(text)
  const branchName = (text: string): string => input.rewriter.rewriteBranch(text)
  const lines = (text: string | undefined, max: number): string[] | undefined => text === undefined
    ? undefined
    : text.split(/\r?\n/u).filter((line) => line.trim()).slice(0, max).map((line) => rewrite(line).slice(0, 200))
  const base = input.state?.baseCommit
  const [branch, commits, diffStat, status, worktreeList, indexLock, named] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], input.folder),
    base ? git(['log', '--oneline', '--no-decorate', `-n${COMMIT_LINES}`, `${base}..HEAD`], input.folder) : undefined,
    base ? git(['diff', '--stat', base], input.folder) : git(['diff', '--stat'], input.folder),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], input.folder),
    git(['worktree', 'list', '--porcelain'], input.folder),
    git(['rev-parse', '--git-path', 'index.lock'], input.folder),
    // Beside git, not after it: the one answer a merged, deleted branch cannot give.
    input.pullRequest === undefined
      ? undefined
      : pullRequest(run, input.pullRequest, input.folder, deadline, input.rewriter, env),
  ])
  // A git the agent's tree was killed in mid-commit leaves index.lock behind, and every later git command fails on it.
  const indexLocked = indexLock?.trim()
    ? await access(resolve(input.folder, indexLock.trim())).then(() => true, () => false)
    : false
  const atStart = new Set((input.state?.worktreesAtStart ?? []).map((path) => path.toLowerCase()))
  const worktrees: Record<string, unknown>[] = []
  const worktreeBranches: string[] = []
  for (const worktree of parseWorktrees(worktreeList ?? '')) {
    const path = await canonical(worktree.path)
    if (atStart.has(path.toLowerCase()) || !isInsideDirectory(input.rootCanonical, path)) continue
    const [ahead, counts] = await Promise.all([
      base ? git(['rev-list', '--count', `${base}..HEAD`], path) : undefined,
      git(['status', '--porcelain=v1', '-z'], path),
    ])
    if (worktree.branch) worktreeBranches.push(worktree.branch)
    worktrees.push({
      path: rewrite(path),
      ...(worktree.branch ? { branch: branchName(worktree.branch) } : {}),
      ...(ahead?.trim() ? { commitsSinceStart: Number(ahead.trim()) } : {}),
      ...porcelainCounts(counts),
    })
    if (worktrees.length >= 10) break
  }
  const branches = [...new Set([branch?.trim(), ...worktreeBranches])]
    .filter((name): name is string => !!name && name !== 'HEAD')
  const pullRequests: Record<string, unknown> = {}
  for (const name of branches.slice(0, 5)) {
    const found = await pullRequest(run, name, input.folder, deadline, input.rewriter, env)
    if (found?.unavailable) break
    if (found) pullRequests[branchName(name)] = found
  }
  return {
    branch: branch?.trim() ? branchName(branch.trim()) : null,
    baseCommit: base ?? null,
    commitsSinceStart: lines(commits, COMMIT_LINES) ?? [],
    diffStat: lines(diffStat, DIFF_STAT_LINES) ?? [],
    ...porcelainCounts(status),
    worktreesCreatedSinceStart: worktrees,
    pullRequests,
    ...(input.pullRequest === undefined ? {} : {
      pullRequest: named && named.unavailable === undefined
        ? named
        // gh missing, or gh answering nothing it could parse in time: said, with the one asked about.
        : { url: input.rewriter.rewritePaths(input.pullRequest), unavailable: named?.unavailable ?? 'lookup_failed' },
    }),
    lastTest: input.state?.lastTest ?? null,
    ...(indexLocked ? { staleIndexLock: true } : {}),
    ...(Date.now() > deadline ? { incomplete: 'review_budget_exhausted' } : {}),
  }
}
