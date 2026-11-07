import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ExecutorSessionRequestListSchema, type ExecutorSessionRequest } from '@nessie/executor-protocol'

import { planClaudeRequest } from '../src/coding-session/claude-requests.js'
import { planCodexRequest } from '../src/coding-session/codex-requests.js'
import { createPathRewriter } from '../src/coding-session/path-rewrite.js'
import { createProjector } from '../src/coding-session/projection.js'
import { SecretDestinationError, setDotenvLine, writeSecretToFolder } from '../src/coding-session/secret-destination.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'
import { answerProblem, SessionRequestBook, type SessionRequestDraft } from '../src/coding-session/session-request-book.js'
import { readSessionRequests, writeSessionRequests } from '../src/coding-session/session-request-file.js'
import { secretAskOf, secretOutcomeText } from '../src/coding-session/session-secret-mcp.js'

const projector = createProjector(createPathRewriter([{ name: 'work', paths: ['/home/ondre/work'] }], 'linux'))
const approval: SessionRequestDraft = {
  kind: 'command', title: 'Run pnpm test', command: 'pnpm test', cwd: '.', decisions: ['accept', 'decline'],
}
const question: SessionRequestDraft = {
  kind: 'question', title: 'Pick', decisions: ['decline', 'cancel'], questions: [
    { id: 'a', question: 'One?', options: [{ label: 'x' }, { label: 'y' }], multiSelect: false, allowCustomAnswer: false, secret: false },
    { id: 'b', question: 'Many?', options: [{ label: 'p' }], multiSelect: true, allowCustomAnswer: true, secret: false },
  ],
}
const silent = { answer: () => undefined, withdraw: () => undefined }

test('an answer must fit its request: pending, answerable, and of its own shape', () => {
  const book = new SessionRequestBook(() => undefined)
  const command = book.open(approval, silent)!
  const asked = book.open(question, silent)!
  const secret = book.open({ kind: 'secret', title: 'Provide a key', secretName: 'key', destination: '.env', decisions: ['decline'] }, silent)!
  const unanswerable = book.open({ ...approval, answerable: false }, silent)!
  assert.equal(answerProblem(command, { requestId: command.id, decision: 'accept' }), undefined)
  assert.equal(answerProblem(command, { requestId: command.id, decision: 'accept_for_session' }), 'answer_shape_mismatch',
    'only a decision the request offers')
  assert.equal(answerProblem(command, { requestId: command.id, secret: 'x' }), 'answer_shape_mismatch')
  assert.equal(answerProblem(unanswerable, { requestId: unanswerable.id, decision: 'accept' }), 'request_not_answerable')
  assert.equal(answerProblem(undefined, { requestId: 'gone', decision: 'accept' }), 'request_not_pending')
  const both = [{ questionId: 'a', values: ['x'] }, { questionId: 'b', values: ['p', 'free text'] }]
  assert.equal(answerProblem(asked, { requestId: asked.id, answers: both }), undefined)
  assert.equal(answerProblem(asked, { requestId: asked.id, answers: both.slice(0, 1) }), 'answer_shape_mismatch', 'every question')
  assert.equal(answerProblem(asked, { requestId: asked.id, answers: [{ questionId: 'a', values: ['z'] }, both[1]!] }),
    'answer_shape_mismatch', 'no custom answer where none is allowed')
  assert.equal(answerProblem(asked, { requestId: asked.id, answers: [{ questionId: 'a', values: ['x', 'y'] }, both[1]!] }),
    'answer_shape_mismatch', 'one value for a single choice')
  assert.equal(answerProblem(asked, { requestId: asked.id, decision: 'decline' }), undefined, 'a question may be turned down')
  assert.equal(answerProblem(secret, { requestId: secret.id, secret: 'value' }), undefined)
  assert.equal(answerProblem(secret, { requestId: secret.id, secretSaved: true }), undefined)
  assert.equal(answerProblem(secret, { requestId: secret.id, decision: 'cancel' }), 'answer_shape_mismatch')
  assert.equal(book.answer({ requestId: command.id, decision: 'accept' }), undefined)
  assert.equal(book.answer({ requestId: command.id, decision: 'accept' }), 'request_not_pending', 'a request is answered once')
  assert.equal(book.get(command.id)?.decision, 'accept', 'an answered approval says which decision was taken')
  assert.equal(book.answer({ requestId: asked.id, answers: both }), undefined)
  assert.equal(book.get(asked.id)?.decision, undefined, 'an answered question carries no decision')
})

test('the book lists pending first, keeps the most recent settled within the cap, and forgets the rest', () => {
  const published: ExecutorSessionRequest[][] = []
  const book = new SessionRequestBook((list) => published.push(list))
  const answered: string[] = []
  const opened = Array.from({ length: 20 }, () => book.open(approval, silent)!)
  for (const request of opened.slice(0, 18)) {
    book.answer({ requestId: request.id, decision: 'decline' })
    answered.push(request.id)
  }
  const list = book.list()
  assert.equal(list.length, 16)
  assert.deepEqual(list.slice(0, 2).map((entry) => entry.status), ['pending', 'pending'])
  assert.deepEqual(list.slice(2).map((entry) => entry.id), answered.slice(-14), 'the newest settled, newest last')
  assert.ok(ExecutorSessionRequestListSchema.safeParse(list).success)
  assert.equal(book.get(answered[0]!), undefined, 'an aged-out request is forgotten')
  assert.equal(book.withdrawAll('cancelled', 'turn_interrupted'), 2)
  assert.equal(book.hasPending(), false)
  assert.deepEqual(book.list().slice(-2).map((entry) => [entry.status, entry.reason]),
    [['cancelled', 'turn_interrupted'], ['cancelled', 'turn_interrupted']])
  assert.equal(published.at(-1)?.length, 16, 'every change is published')
})

test('a responder hears the answer or why the request ended, once', () => {
  const heard: string[] = []
  const book = new SessionRequestBook(() => undefined)
  const one = book.open(approval, { answer: (answer) => heard.push(`answer:${answer.decision}`),
    withdraw: (status, reason) => heard.push(`${status}:${reason}`) })!
  const two = book.open(approval, { answer: () => heard.push('never'), withdraw: (status, reason) => heard.push(`${status}:${reason}`) })!
  book.answer({ requestId: one.id, decision: 'accept' })
  book.withdraw(two.id, 'cancelled', 'provider_cancelled')
  book.withdraw(two.id, 'expired', 'provider_exited')
  book.withdrawAll('expired', 'provider_exited')
  assert.deepEqual(heard, ['answer:accept', 'cancelled:provider_cancelled'])
  assert.equal(book.open({ ...approval, title: '' }, silent), undefined, 'a draft the protocol refuses opens nothing')
  assert.equal(book.open({ ...approval, files: Array.from({ length: 65 }, () => ({ path: 'a', change: 'add' as const })) },
    silent), undefined)
})

test('what an earlier host left pending reads expired, on disk and when no host is alive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-requests-'))
  try {
    const paths = codingSessionPaths(dir, '0f0e0d0c-0b0a-4908-8706-050403020100')
    await mkdir(paths.dir, { recursive: true })
    const before = new SessionRequestBook(() => undefined)
    before.open(approval, silent)
    await writeSessionRequests(paths, before.list())
    assert.equal((await readSessionRequests(paths, true))[0]?.status, 'pending')
    const orphan = (await readSessionRequests(paths, false))[0]
    assert.deepEqual([orphan?.status, orphan?.reason], ['expired', 'executor_restarted'])
    let written: ExecutorSessionRequest[] = []
    const after = new SessionRequestBook((list) => { written = list }, await readSessionRequests(paths, true))
    assert.deepEqual([written[0]?.status, written[0]?.reason], ['expired', 'executor_restarted'])
    assert.equal(after.hasPending(), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a secret is written only inside the session folder, owner-only, never through a link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-secret-'))
  try {
    const folder = join(dir, 'work')
    const outside = join(dir, 'outside')
    await mkdir(folder)
    await mkdir(outside)
    const refused = async (destination: string, code = 'secret_destination_refused'): Promise<void> => {
      await assert.rejects(writeSecretToFolder({ folder, destination, value: 'v4lue-v4lue' }), (error: unknown) => (
        error instanceof SecretDestinationError && error.code === code && !error.message.includes('v4lue')))
    }
    for (const destination of ['../escape', 'a/../../escape', '/etc/passwd', 'C:\\x', '', '.', 'bad\u0000name']) {
      await refused(destination, 'secret_destination_invalid')
    }
    await symlink(outside, join(folder, 'linked'))
    await refused('linked/token')
    await symlink(join(outside, 'target'), join(folder, 'token-link'))
    await refused('token-link')
    await writeFile(join(outside, 'shared'), 'x')
    await link(join(outside, 'shared'), join(folder, 'hard'))
    await refused('hard')
    await mkdir(join(folder, 'dir'))
    await refused('dir')
    assert.deepEqual(await writeSecretToFolder({ folder, destination: 'config/keys/token.txt', value: 's3cret' }),
      { destination: 'config/keys/token.txt' })
    assert.equal(await readFile(join(folder, 'config/keys/token.txt'), 'utf8'), 's3cret')
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(folder, 'config/keys/token.txt'))).mode & 0o777, 0o600)
      assert.equal((await stat(join(folder, 'config'))).mode & 0o777, 0o700)
    }
    await writeFile(join(folder, '.env'), 'A=1\nexport TOKEN=old\n# keep me\nTOKEN=dup\n', { mode: 0o644 })
    await writeSecretToFolder({ folder, destination: '.env', value: 'new value "quoted"', envName: 'TOKEN' })
    assert.equal(await readFile(join(folder, '.env'), 'utf8'), 'A=1\nTOKEN="new value \\"quoted\\""\n# keep me\n')
    if (process.platform !== 'win32') assert.equal((await stat(join(folder, '.env'))).mode & 0o777, 0o600)
    assert.equal(await readFile(join(outside, 'shared'), 'utf8'), 'x', 'nothing outside the folder changed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dotenv line is set or appended, and every other line is kept', () => {
  assert.equal(setDotenvLine('', 'KEY', 'abc'), 'KEY=abc\n')
  assert.equal(setDotenvLine('A=1', 'KEY', 'abc'), 'A=1\nKEY=abc\n')
  assert.equal(setDotenvLine('KEY=old\r\nB=2\r\n', 'KEY', 'a b'), 'KEY="a b"\nB=2\n')
  assert.equal(setDotenvLine('  export KEY = old\n', 'KEY', 'line\nbreak'), 'KEY="line\\nbreak"\n')
  assert.equal(setDotenvLine('KEYS=1\n', 'KEY', 'v'), 'KEYS=1\nKEY=v\n', 'a longer name is another variable')
})

test('request_secret refuses what it cannot write and says only where a value went', () => {
  assert.deepEqual(secretAskOf({ name: 'Key', reason: 'Why', destination: '../x' }),
    { refused: new SecretDestinationError('secret_destination_invalid').message })
  assert.deepEqual(secretAskOf({ name: 'Key', reason: 'Why', destination: '.env', envName: 'BAD-NAME' }),
    { refused: 'envName must be a variable name such as STRIPE_SECRET_KEY.' })
  assert.deepEqual(secretAskOf({ name: '', reason: 'Why', destination: '.env' }), { refused: 'name and reason are required text.' })
  const ask = secretAskOf({ name: 'Key', reason: 'Why', destination: './config//.env', envName: 'KEY' })
  assert.ok(!('refused' in ask))
  assert.equal(ask.destination, 'config/.env')
  assert.match(secretOutcomeText(ask, { outcome: 'saved', destination: 'config/.env' }), /saved to config\/\.env/u)
  assert.match(secretOutcomeText(ask, { outcome: 'declined', reason: 'owner_declined' }), /did not provide Key/u)
})

test('Claude prompts become requests by tool; the session\'s own secret tool is allowed without asking', () => {
  const folder = '/home/ondre/work'
  const edit = planClaudeRequest({ requestId: 'r1', toolName: 'Edit',
    input: { file_path: '/home/ondre/work/src/a.ts', old_string: 'a', new_string: 'b' } }, projector, folder)
  assert.equal(edit.kind, 'ask')
  if (edit.kind !== 'ask') return
  assert.deepEqual([edit.draft.kind, edit.draft.title, edit.draft.files, edit.draft.diff],
    ['file_change', 'Edit src/a.ts', [{ path: 'src/a.ts', change: 'update' }], '- a\n+ b'])
  const cancelled = JSON.parse(edit.answer({ requestId: 'x', decision: 'cancel' }).line)
  assert.deepEqual(cancelled.response.response, { behavior: 'deny', message: 'The owner cancelled this and stopped the turn.',
    interrupt: true })
  const fetch = planClaudeRequest({ requestId: 'r2', toolName: 'WebFetch', input: { url: 'https://example.com' } }, projector, folder)
  assert.equal(fetch.kind === 'ask' && fetch.draft.kind, 'permission')
  const accepted = fetch.kind === 'ask' && JSON.parse(fetch.answer({ requestId: 'x', decision: 'accept_for_session' }).line)
  assert.deepEqual(accepted.response.response.updatedPermissions,
    [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }],
    'without suggestions, the tool itself, for this session only')
  const own = planClaudeRequest({ requestId: 'r3', toolName: 'mcp__nessie_session__request_secret', input: { name: 'k' } },
    projector, folder)
  assert.equal(own.kind, 'allow')
})

test('Codex requests: legacy shapes, wider permissions, and forms it can or cannot show', () => {
  const input = { projector, folder: '/home/ondre/work', fileChanges: () => [] }
  const legacy = planCodexRequest({ id: 1, method: 'execCommandApproval', params: {
    command: ['git', 'push'], cwd: '/home/ondre/work/sub', callId: 'c' } }, input)
  assert.equal(legacy.kind, 'ask')
  if (legacy.kind !== 'ask') return
  assert.equal(legacy.draft.cwd, 'sub')
  assert.deepEqual(legacy.answer({ requestId: 'x', decision: 'accept_for_session' }).result, { decision: 'approved_for_session' })
  assert.deepEqual(legacy.answer({ requestId: 'x', decision: 'cancel' }).result, { decision: 'abort' })
  const patch = planCodexRequest({ id: 2, method: 'applyPatchApproval', params: { callId: 'c', fileChanges: {
    '/home/ondre/work/new.ts': { type: 'add', content: 'x' }, '/home/ondre/work/old.ts': { type: 'update', unified_diff: '@@ -1 +1 @@' },
  } } }, input)
  assert.equal(patch.kind === 'ask' && patch.draft.title, 'Edit 2 files')
  const permissions = planCodexRequest({ id: 3, method: 'item/permissions/requestApproval', params: {
    permissions: { network: { enabled: true } }, reason: 'Download a package' } }, input)
  assert.equal(permissions.kind === 'ask' && permissions.draft.kind, 'permission')
  assert.deepEqual(permissions.kind === 'ask' && permissions.answer({ requestId: 'x', decision: 'decline' }).result,
    { permissions: {}, scope: 'turn' }, 'a decline grants nothing')
  const form = planCodexRequest({ id: 4, method: 'mcpServer/elicitation/request', params: { serverName: 'db', mode: 'form',
    message: 'Pick a region', requestedSchema: { properties: { region: { type: 'string', enum: ['eu', 'us'] },
      confirm: { type: 'boolean', title: 'Sure?' } } } } }, input)
  assert.equal(form.kind, 'ask')
  if (form.kind !== 'ask') return
  assert.deepEqual(form.draft.questions?.map((entry) => [entry.id, entry.options.map((option) => option.label)]),
    [['region', ['eu', 'us']], ['confirm', ['true', 'false']]])
  assert.deepEqual(form.answer({ requestId: 'x', answers: [{ questionId: 'region', values: ['eu'] },
    { questionId: 'confirm', values: ['true'] }] }).result, { action: 'accept', content: { region: 'eu', confirm: true } })
  const unshowable = planCodexRequest({ id: 5, method: 'mcpServer/elicitation/request', params: { serverName: 'db', mode: 'form',
    message: 'x', requestedSchema: { properties: { list: { type: 'array' } } } } }, input)
  assert.deepEqual(unshowable, { kind: 'reply', result: { action: 'decline' } })
  assert.deepEqual(planCodexRequest({ id: 6, method: 'mcpServer/elicitation/request', params: { serverName: 'db', mode: 'url',
    message: 'Sign in', url: 'https://example.com' } }, input), { kind: 'reply', result: { action: 'decline' } })
  assert.deepEqual(planCodexRequest({ id: 7, method: 'mcpServer/elicitation/request', params: { serverName: 'nessie_session',
    mode: 'form', message: 'Allow?', requestedSchema: { properties: {} } } }, input), { kind: 'reply', result: { action: 'accept' } })
  assert.deepEqual(planCodexRequest({ id: 8, method: 'item/tool/call', params: {} }, input), { kind: 'unsupported' })
})
