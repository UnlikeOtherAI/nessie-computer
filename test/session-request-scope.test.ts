import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { codexPermissionsWithinRoots, insideReviewedRoots } from '../src/coding-session/approval-scope.js'
import { planClaudeRequest, type ClaudeRequestPlan } from '../src/coding-session/claude-requests.js'
import { planCodexRequest, shownCommand, type CodexRequestPlan } from '../src/coding-session/codex-requests.js'
import { createPathRewriter } from '../src/coding-session/path-rewrite.js'
import { createProjector } from '../src/coding-session/projection.js'
import { PARTIAL_TITLE } from '../src/coding-session/request-drafts.js'

/**
 * How far an owner's approval reaches (`approval-scope.ts`), and that nothing
 * the owner could not read whole can be approved (`request-drafts.ts`).
 */

const folder = '/home/ondre/work/app'
const roots = ['/home/ondre/work']
const projector = createProjector(createPathRewriter([{ name: 'work', paths: roots }], 'linux'))

const asked = (plan: ClaudeRequestPlan | CodexRequestPlan) => {
  assert.equal(plan.kind, 'ask')
  return plan as Extract<typeof plan, { kind: 'ask' }>
}

const claude = (toolName: string, input: Record<string, unknown>, suggestions?: unknown[]) => asked(planClaudeRequest({
  requestId: 'r', toolName, input, ...(suggestions ? { suggestions } : {}) }, projector, folder, roots))

const sessionRules = (plan: Extract<ClaudeRequestPlan, { kind: 'ask' }>): unknown => (
  JSON.parse(plan.answer({ requestId: 'x', decision: 'accept_for_session' }).line).response.response.updatedPermissions
)

test('Claude: for the session means a concrete rule — Claude\'s own or the exact command — never a bare tool', () => {
  const exact = claude('Bash', { command: 'pnpm test' })
  assert.deepEqual(exact.draft.decisions, ['accept', 'accept_for_session', 'decline', 'cancel'])
  assert.deepEqual(sessionRules(exact), [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test' }],
    behavior: 'allow', destination: 'session' }], 'the command the owner read, and nothing wider')

  const bare = claude('Bash', { command: 'pnpm test' }, [
    { type: 'addRules', rules: [{ toolName: 'Bash' }, { toolName: 'Bash', ruleContent: '*' }], behavior: 'allow',
      destination: 'localSettings' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
  ])
  assert.deepEqual(sessionRules(bare), sessionRules(exact), 'a bare or match-anything rule, a mode or a replacement is dropped')

  const suggested = claude('Bash', { command: 'pnpm test --filter x' }, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }], behavior: 'allow', destination: 'projectSettings' },
  ])
  assert.deepEqual(sessionRules(suggested), [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
    behavior: 'allow', destination: 'session' }], 'Claude\'s own concrete rule, for this session only')

  const pattern = claude('Bash', { command: 'rm -rf build/*' })
  assert.deepEqual(pattern.draft.decisions, ['accept', 'decline', 'cancel'], 'a `*` would make the exact command a pattern')

  const fetch = claude('WebFetch', { url: 'https://example.com' }, [{ type: 'addRules',
    rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' }])
  assert.equal(fetch.draft.decisions?.includes('accept_for_session'), true)
  const read = claude('Read', { file_path: '/etc/hosts' }, [{ type: 'addRules',
    rules: [{ toolName: 'Read', ruleContent: '//etc/**' }], behavior: 'allow', destination: 'session' }])
  assert.deepEqual(read.draft.decisions, ['accept', 'decline', 'cancel'], 'a path rule reaches further than one request shows')
})

test('Claude: extra directories are kept only inside a reviewed folder', () => {
  const plan = claude('Read', { file_path: '/home/ondre/work/lib/a.ts' }, [{ type: 'addDirectories',
    directories: ['/home/ondre/work/lib', '/home/ondre/.ssh', '../../../etc', '../shared'], destination: 'session' }])
  assert.deepEqual(sessionRules(plan), [{ type: 'addDirectories',
    directories: ['/home/ondre/work/lib', '../shared'], destination: 'session' }])
  const outside = claude('Read', { file_path: '/etc/hosts' }, [{ type: 'addDirectories', directories: ['/etc'],
    destination: 'session' }])
  assert.deepEqual(outside.draft.decisions, ['accept', 'decline', 'cancel'])
})

test('a real folder that links out of a reviewed folder is outside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-scope-'))
  try {
    const root = join(dir, 'root')
    await mkdir(join(root, 'inside'), { recursive: true })
    await mkdir(join(dir, 'outside'))
    await symlink(join(dir, 'outside'), join(root, 'link'))
    assert.equal(insideReviewedRoots(join(root, 'inside'), [root]), true, 'whichever way the root is spelled')
    assert.equal(insideReviewedRoots(join(root, 'link'), [root]), false)
    assert.equal(insideReviewedRoots('relative/path', [root]), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('nothing the owner could not read whole can be approved, and the title says why', () => {
  const long = `node -e "${'x '.repeat(8_100)}"`
  const command = claude('Bash', { command: long })
  assert.deepEqual(command.draft.decisions, ['decline', 'cancel'])
  assert.equal(command.draft.title.startsWith(PARTIAL_TITLE), true)
  assert.equal(command.draft.title.length <= 300, true)

  const edit = claude('Edit', { file_path: '/home/ondre/work/app/a.ts', old_string: 'a', new_string: 'b '.repeat(16_500) })
  assert.deepEqual(edit.draft.decisions, ['decline', 'cancel'], 'a diff cut to fit')

  const multi = claude('MultiEdit', { file_path: '/home/ondre/work/app/a.ts',
    edits: [{ old_string: 'one', new_string: 'two' }, { old_string: 'three', new_string: 'four' }] })
  assert.equal(multi.draft.diff, '- one\n+ two\n- three\n+ four', 'every edit is shown')
  assert.equal(multi.draft.decisions?.includes('accept'), true)

  const blind = claude('NotebookEdit', { notebook_path: '/home/ondre/work/app/n.ipynb', cell_id: 'c1' })
  assert.deepEqual(blind.draft.decisions, ['decline', 'cancel'], 'a change whose content was not given')

  const input = { projector, folder, roots, fileChanges: () => [] }
  const many = asked(planCodexRequest({ id: 1, method: 'applyPatchApproval', params: { fileChanges: Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`${folder}/f${index}.ts`, { type: 'delete' }])) } }, input))
  assert.deepEqual(many.draft.decisions, ['decline', 'cancel'], 'more files than a request can list')
  const permission = asked(planCodexRequest({ id: 2, method: 'item/permissions/requestApproval', params: { cwd: folder,
    permissions: { network: { enabled: true }, fileSystem: { read: [`${folder}/${'deep/'.repeat(3_400)}`],
      write: null } } } }, input))
  assert.deepEqual(permission.draft.decisions, ['decline', 'cancel'], 'an input cut to fit')
})

test('Codex: the owner reads the exact command, never its display parse', () => {
  const input = { projector, folder, roots, fileChanges: () => [] }
  const plan = asked(planCodexRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: {
    command: `/bin/zsh -lc 'cd /tmp && rm -rf x'`, cwd: folder, commandActions: [{ type: 'unknown', command: 'rm -rf x' }],
    availableDecisions: ['accept', 'decline'] } }, input))
  assert.equal(plan.draft.command, 'cd <host path> && rm -rf x', 'the whole script, its host paths hidden as everywhere')
  assert.equal(shownCommand(`bash -lc 'echo '\\''hi'\\'''`), `echo 'hi'`)
  assert.equal(shownCommand(`bash -lc 'a' && b`), `bash -lc 'a' && b`, 'anything but one quoted script is shown as is')
  const legacy = asked(planCodexRequest({ id: 2, method: 'execCommandApproval', params: {
    command: ['bash', '-lc', "git commit -m 'it works'"], cwd: folder } }, input))
  assert.equal(legacy.draft.command, "git commit -m 'it works'")
})

test('Codex: a permissions request is granted for its turn, and only inside the reviewed folders', () => {
  const input = { projector, folder, roots, fileChanges: () => [] }
  const ask = (permissions: unknown) => asked(planCodexRequest({ id: 1, method: 'item/permissions/requestApproval',
    params: { cwd: folder, reason: 'Needs it', permissions } }, input))
  const network = ask({ network: { enabled: true }, fileSystem: null })
  assert.deepEqual(network.draft.decisions, ['accept', 'decline', 'cancel'], 'never for the session')
  assert.deepEqual(network.answer({ requestId: 'x', decision: 'accept' }).result,
    { permissions: { network: { enabled: true } }, scope: 'turn' })
  const inside = ask({ network: null, fileSystem: { read: null, write: ['../shared', `${folder}/out`],
    entries: [{ path: { type: 'special', value: { kind: 'project_roots', subpath: 'dist' } }, access: 'write' },
      { path: { type: 'special', value: { kind: 'root' } }, access: 'deny' }] } })
  assert.deepEqual(inside.answer({ requestId: 'x', decision: 'accept' }).result.scope, 'turn')
  for (const outside of [
    { fileSystem: { write: ['/home/ondre/.ssh'], read: null } },
    { fileSystem: { read: null, write: null, entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }] } },
    { fileSystem: { read: null, write: null, entries: [{ path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'write' }] } },
    { fileSystem: { read: null, write: null, entries: [{ path: { type: 'glob_pattern', pattern: '**' }, access: 'read' }] } },
    { fileSystem: { read: null, write: null, entries: [{ path: { type: 'special',
      value: { kind: 'project_roots', subpath: '../..' } }, access: 'write' }] } },
    { macos: { automation: true } },
  ]) {
    const plan = ask(outside)
    assert.deepEqual(plan.draft.decisions, ['decline', 'cancel'], JSON.stringify(outside))
    assert.match(plan.draft.title, /outside the reviewed folders/u)
    assert.deepEqual(plan.answer({ requestId: 'x', decision: 'accept' }).result, { permissions: {}, scope: 'turn' })
  }
  assert.equal(codexPermissionsWithinRoots({ network: { enabled: true } }, folder, roots), true)
})

test('Codex: a file change shows every file\'s diff, and one that grants a write root is approved once only', () => {
  const changes = [{ path: `${folder}/a.ts`, change: 'update' as const, diff: '@@ -1 +1 @@\n-a\n+b' },
    { path: `${folder}/gone.ts`, change: 'delete' as const }]
  const input = { projector, folder, roots, fileChanges: () => changes }
  const plan = asked(planCodexRequest({ id: 1, method: 'item/fileChange/requestApproval', params: { itemId: 'i' } }, input))
  assert.equal(plan.draft.diff, '--- a.ts (update)\n@@ -1 +1 @@\n-a\n+b\n--- gone.ts (delete)')
  assert.deepEqual(plan.draft.decisions, ['accept', 'accept_for_session', 'decline', 'cancel'])
  const root = asked(planCodexRequest({ id: 2, method: 'item/fileChange/requestApproval', params: {
    itemId: 'i', grantRoot: '/home/ondre' } }, input))
  assert.deepEqual(root.draft.decisions, ['accept', 'decline', 'cancel'])
  const unseen = asked(planCodexRequest({ id: 3, method: 'item/fileChange/requestApproval', params: { itemId: 'i' } },
    { ...input, fileChanges: () => [{ path: `${folder}/a.ts`, change: 'update' as const }] }))
  assert.deepEqual(unseen.draft.decisions, ['decline', 'cancel'], 'a change whose diff Codex did not give')
  const legacy = asked(planCodexRequest({ id: 4, method: 'applyPatchApproval', params: { fileChanges: {
    [`${folder}/new.ts`]: { type: 'add', content: 'x\ny' } } } }, input))
  assert.equal(legacy.draft.diff, '--- new.ts (add)\n+ x\n+ y')
})
