import assert from 'node:assert/strict'
import { hostname, userInfo } from 'node:os'
import { test } from 'node:test'

import { ExecutorCodingSessionSummarySchema } from '@nessie/executor-protocol'

import { rewriteCodingAnswer } from '../src/coding-session/bridge-server.js'
import { identityNames, readHostIdentity } from '../src/coding-session/host-identity.js'
import { createPathRewriter, HOST_PATH_PLACEHOLDER } from '../src/coding-session/path-rewrite.js'
import { createProjector, exitCodeFromToolResult, looksLikeTestCommand } from '../src/coding-session/projection.js'

const windows = createPathRewriter([
  { name: 'nessie', paths: ['C:/Users/ondre/Projects/Nessie', 'C:\\Users\\ondre\\Projects\\Nessie'] },
  { name: undefined, paths: ['C:\\Users\\ondre', 'C:\\Users\\ondre\\AppData\\Local\\Temp'] },
], 'win32')

const linux = createPathRewriter([
  { name: 'app', paths: ['/home/ondre/src/app'] },
  { name: undefined, paths: ['/home/ondre', '/tmp'] },
], 'linux')

const mac = createPathRewriter([
  { name: 'app', paths: ['/Users/ondre/src/app', '/private/var/folders/x/app'] },
  { name: undefined, paths: ['/Users/ondre'] },
], 'darwin')

test('every Windows spelling of a root becomes <root>/relative', () => {
  for (const spelling of [
    'C:\\Users\\ondre\\Projects\\Nessie\\src\\index.ts',
    'C:/Users/ondre/Projects/Nessie/src/index.ts',
    'c:\\users\\ONDRE\\projects\\nessie\\src\\index.ts',
    '\\\\?\\C:\\Users\\ondre\\Projects\\Nessie\\src\\index.ts',
    '//?/C:/Users/ondre/Projects/Nessie/src/index.ts',
    '/c/Users/ondre/Projects/Nessie/src/index.ts',
    '/mnt/c/Users/ondre/Projects/Nessie/src/index.ts',
    'C:\\\\Users\\\\ondre\\\\Projects\\\\Nessie\\\\src\\\\index.ts',
  ]) {
    assert.equal(windows.rewrite(`edited ${spelling} ok`), 'edited <nessie>/src/index.ts ok', spelling)
  }
  assert.equal(windows.rewrite('cd C:\\Users\\ondre\\Projects\\Nessie'), 'cd <nessie>')
  // A sibling that merely starts with the root's name is not the root.
  assert.equal(windows.rewrite('C:\\Users\\ondre\\Projects\\NessieOld\\a.ts'), HOST_PATH_PLACEHOLDER)
})

test('every other absolute path becomes <host path>, and ordinary text survives', () => {
  assert.equal(windows.rewrite('memory at C:\\Users\\ondre\\.claude\\projects\\x'), `memory at ${HOST_PATH_PLACEHOLDER}`)
  assert.equal(windows.rewrite('D:\\secrets\\key.pem and ~/.claude/settings.json'), `${HOST_PATH_PLACEHOLDER} and ${HOST_PATH_PLACEHOLDER}`)
  assert.equal(windows.rewrite('\\\\server\\share\\file.txt'), HOST_PATH_PLACEHOLDER)
  assert.equal(windows.rewrite('taskkill /T /F and see https://example.com/a/b/c'), 'taskkill /T /F and see https://example.com/a/b/c')
  assert.equal(windows.rewrite('GET /api/runs/:id/cancel returned 404'), 'GET /api/runs/:id/cancel returned 404')
  assert.equal(linux.rewrite('wrote /home/ondre/src/app/lib/x.ts'), 'wrote <app>/lib/x.ts')
  assert.equal(linux.rewrite('cache in /home/ondre/.cache/pnpm and /var/tmp/x'), `cache in ${HOST_PATH_PLACEHOLDER} and ${HOST_PATH_PLACEHOLDER}`)
  assert.equal(linux.rewrite('/home/ondre/SRC/app/x'), HOST_PATH_PLACEHOLDER, 'Linux paths are case-sensitive: not the root')
  assert.equal(linux.rewrite('src/components/Foo.tsx and a/b'), 'src/components/Foo.tsx and a/b')
  assert.equal(mac.rewrite('/private/var/folders/x/app/README.md'), '<app>/README.md')
  assert.equal(mac.rewrite('/users/ONDRE/src/app/README.md'), '<app>/README.md', 'macOS compares case-insensitively')
})

test('a directory name with spaces leaves no tail of itself behind', () => {
  assert.equal(windows.rewrite('read C:\\Users\\Other Person\\AppData\\x.json now'), `read ${HOST_PATH_PLACEHOLDER} now`)
  assert.equal(windows.rewrite('ran C:\\Program Files\\Git\\bin\\bash.exe -lc'), `ran ${HOST_PATH_PLACEHOLDER} -lc`)
  assert.equal(linux.rewrite('wrote /home/jane doe/x and left'), `wrote ${HOST_PATH_PLACEHOLDER} and left`)
  assert.equal(windows.rewrite('edited C:\\Users\\ondre\\Projects\\Nessie\\My Docs\\a.md'), 'edited <nessie>/My Docs/a.md')
  // Prose after a path is still prose.
  assert.equal(windows.rewrite('see D:\\work\\a.ts and b.ts'), `see ${HOST_PATH_PLACEHOLDER} and b.ts`)
})

test('credentials read <secret>, whether the host knows the value or only its shape', () => {
  const projector = createProjector(windows)
  projector.redactSecrets(['configured-secret-value', 'short'])
  const token = `ghp_${'A1b2'.repeat(9)}`
  assert.equal(projector.toolInput('Bash', { command: `export GH_TOKEN=${token}` }), 'export GH_TOKEN=<secret>')
  assert.equal(projector.toolResult(`${token}\n`, false), '<secret>')
  assert.equal(projector.toolInput('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx" https://x' }), // gitleaks:allow -- synthetic test value, never a credential
    'curl -H "Authorization: Bearer <secret>" https://x')
  assert.equal(projector.line(`key sk-ant-api03-${'x'.repeat(30)} and AKIAABCDEFGHIJKLMNOP`, 300), 'key <secret> and <secret>') // gitleaks:allow -- synthetic test value, never a credential
  assert.equal(projector.line(`jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4`, 300), 'jwt <secret>')
  assert.equal(projector.line('DB_PASSWORD="hunter2hunter2" API_KEY: abcdef123', 300), 'DB_PASSWORD=<secret> API_KEY: <secret>')
  assert.equal(projector.text('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----', 300), '<secret>')
  assert.equal(projector.line('uses configured-secret-value; short stays', 300), 'uses <secret>; short stays')
  assert.equal(projector.line('git status and pnpm test passed', 300), 'git status and pnpm test passed')
})

test('each event kind keeps its allowlisted fields at their caps, rewritten', () => {
  const projector = createProjector(windows)
  assert.equal(projector.toolInput('Bash', { command: 'cd C:\\Users\\ondre\\Projects\\Nessie && pnpm test', description: 'x' }), 'cd <nessie> && pnpm test')
  assert.equal(projector.toolInput('Edit', { file_path: 'C:\\Users\\ondre\\Projects\\Nessie\\a.ts', old_string: 'secret' }), '<nessie>/a.ts')
  assert.equal(projector.toolInput('Grep', { pattern: 'TODO', path: 'C:\\Users\\ondre\\Projects\\Nessie' }), 'TODO in <nessie>')
  assert.equal(projector.toolInput('TodoWrite', { todos: [1, 2, 3] }), '3 items')
  assert.equal(projector.toolInput('Bash', { command: 'x'.repeat(1_000) }).length, 300)
  assert.equal(projector.toolResult([{ type: 'text', text: 'y'.repeat(5_000) }], false).length, 300)
  assert.equal(projector.toolResult('z'.repeat(5_000), true).length, 1_000)
  assert.equal(projector.text(`line one\nline two ${'w'.repeat(3_000)}`, 2_000).startsWith('line one\nline two'), true)
  assert.deepEqual(projector.denials([
    { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'rm -rf C:\\Users\\ondre\\Projects\\Nessie' } },
    { nonsense: true },
  ]), [{ tool: 'Bash', summary: 'rm -rf <nessie>' }])
})

test('an account redaction covers every later string, and only real values become one', () => {
  const projector = createProjector(windows)
  projector.redact([undefined, 42, 'ab', '   '])
  assert.equal(projector.line('ab 42 stays', 100), 'ab 42 stays')
  projector.redact(['owner@example.com', "owner@example.com's Organization"])
  assert.equal(
    projector.text("OWNER@example.com's Organization, owner@example.com, C:\\Users\\ondre\\x", 200),
    `<account>, <account>, ${HOST_PATH_PLACEHOLDER}`,
  )
  assert.equal(projector.toolInput('Bash', { command: 'git config user.email owner@example.com' }), 'git config user.email <account>')
})

const identity = { users: ['ondre'], hosts: ['Minis', 'Minis.local'] }
const named = createPathRewriter([
  { name: 'nessie', paths: ['C:\\Users\\ondre\\Projects\\Nessie'] },
  { name: undefined, paths: ['C:\\Users\\ondre'] },
], 'win32', identity)

test('the OS user and host read <user> and <host> in what git, npm and a shell print', () => {
  const projector = createProjector(named)
  assert.equal(
    projector.toolResult("Exit code 128\nAuthor identity unknown\nfatal: unable to auto-detect email address (got 'ondre@Minis.(none)')", true),
    "Exit code 128 Author identity unknown fatal: unable to auto-detect email address (got '<user>@<host>.(none)')",
  )
  assert.equal(projector.line('npm notice Logged in as ondre on https://registry.npmjs.org/.', 200),
    'npm notice Logged in as <user> on https://registry.npmjs.org/.')
  assert.equal(projector.line('ONDRE@MINIS MINGW64 ~/Projects/Nessie (main)\n$ whoami\nminis\\ondre', 200),
    `<user>@<host> MINGW64 ${HOST_PATH_PLACEHOLDER} (main) $ whoami <host>\\<user>`)
  assert.equal(projector.line('ssh ondre@minis.local uptime', 200), 'ssh <user>@<host> uptime', 'the FQDN is one host')
  // Paths first: a path under the root keeps its root, and the profile is still a host path.
  assert.equal(projector.line('edited C:\\Users\\ondre\\Projects\\Nessie\\src\\ondre.ts and C:\\Users\\ondre\\x', 200),
    `edited <nessie>/src/<user>.ts and ${HOST_PATH_PLACEHOLDER}`)
})

test('only whole words are names, and a name that is an ordinary word or too short is left alone', () => {
  const words = createPathRewriter([], 'linux', { users: ['dan', 'jo', 'root'], hosts: ['mini', 'localhost'] })
  assert.equal(words.rewrite('redundant Dante danced; minimal minis minion'), 'redundant Dante danced; minimal minis minion')
  assert.equal(words.rewrite('Dan pushed from mini, dan_x stays, dan-x does not'), '<user> pushed from <host>, dan_x stays, <user>-x does not')
  assert.equal(words.rewrite('jo ran it as root on localhost:3000'), 'jo ran it as root on localhost:3000')
  // Placeholders already written, and session ids, are never rewritten again.
  const awkward = createPathRewriter([{ name: 'repo', paths: ['/home/repo/src'] }, { name: undefined, paths: ['/home/repo'] }], 'linux', {
    users: ['repo', 'account'], hosts: ['host', 'cafe'],
  })
  assert.equal(awkward.rewrite('wrote /home/repo/src/a.ts and /home/repo/b as repo on host'), 'wrote <repo>/a.ts and <host path> as <user> on <host>')
  assert.equal(awkward.rewrite('<account> in session 1234abcd-cafe-4000-8000-000000000000'), '<account> in session 1234abcd-cafe-4000-8000-000000000000')
})

test('the names come from the OS and the environment, each once, in short and domain forms', () => {
  const { users, hosts } = readHostIdentity({
    USERNAME: 'Ondre', USER: 'ondre', LOGNAME: 'x', COMPUTERNAME: 'ONDREJS-WORKSTATION', USERDNSDOMAIN: 'CORP.EXAMPLE.COM',
  }, 'win32')
  assert.equal(users.filter((name) => name.toLowerCase() === 'ondre').length, 1, 'one entry however it is cased')
  assert.equal(users.includes('x'), false, 'too short')
  // The whole name, its NetBIOS form and its domain form.
  for (const name of ['ONDREJS-WORKSTATION', 'ONDREJS-WORKSTA', 'ONDREJS-WORKSTATION.CORP.EXAMPLE.COM']) {
    assert.ok(hosts.includes(name), name)
  }
  // What the OS itself answers arrives however bare the environment is.
  const bare = readHostIdentity({}, 'linux')
  assert.ok(identityNames([userInfo().username]).every((name) => bare.users.includes(name)))
  assert.ok(identityNames([hostname(), hostname().split('.')[0]]).every((name) => bare.hosts.includes(name)))
})

test('elsewhere the FQDN comes from /etc/hosts and the resolver search domains, so no DNS domain is left over', () => {
  const files: Record<string, string> = {
    '/etc/hosts': '127.0.0.1 localhost\n127.0.1.1 minis.corp.acme.com minis # this machine\n10.0.0.2 other.corp.acme.com other\n',
    '/etc/resolv.conf': 'nameserver 10.0.0.1\nsearch lab.acme.net .\n',
  }
  const { hosts } = readHostIdentity({ COMPUTERNAME: 'minis' }, 'linux', (path) => files[path])
  const folded = hosts.map((name) => name.toLowerCase())
  for (const name of ['minis', 'minis.corp.acme.com', 'minis.lab.acme.net']) assert.ok(folded.includes(name), name)
  assert.equal(hosts.some((name) => name.startsWith('other')), false, 'only this machine\'s own names')
  const rewriter = createPathRewriter([], 'linux', { users: ['ondre'], hosts })
  assert.equal(rewriter.rewrite("unable to auto-detect email address (got 'ondre@minis.corp.acme.com')"),
    "unable to auto-detect email address (got '<user>@<host>')")
  // The home directory's own name is not a user name: under a container it is `app` or `workspace`.
  const { users } = readHostIdentity({ USER: 'someone-else' }, 'linux', () => undefined)
  assert.deepEqual(users, identityNames([userInfo().username, 'someone-else']))
})

test('a name any machine may carry is no one\'s, and a whole relative path segment is a folder, not a name', () => {
  // The usual CI, container and cloud defaults, and the coding agents' own names.
  const defaults = createPathRewriter([], 'linux', { users: ['node', 'runner', 'ubuntu', 'claude'], hosts: ['api', 'build', 'web'] })
  for (const text of ['Read src/api/x.ts', 'node --test a.ts', 'Ubuntu 24.04 on build', 'agent claude via web/api']) {
    assert.equal(defaults.rewrite(text), text)
  }
  const person = createPathRewriter([{ name: 'app', paths: ['/home/ondre/src/app'] }, { name: undefined, paths: ['/home/ondre'] }], 'linux', {
    users: ['ondre'], hosts: ['minis'],
  })
  assert.equal(person.rewrite('Edit src/ondre/x.ts and /home/ondre/src/app/ondre/y.ts'), 'Edit src/ondre/x.ts and <app>/ondre/y.ts')
  assert.equal(person.rewrite('opened https://github.com/ondre/app/pull/7'), 'opened https://github.com/ondre/app/pull/7')
  // Two separators are a URL's host or a UNC server; a segment with no separator after it is prose.
  assert.equal(person.rewrite('http://minis/ondre/x and minis\\ondre from whoami, ondre/wip'), 'http://<host>/ondre/x and <host>\\<user> from whoami, <user>/wip')
  assert.equal(person.rewritePaths('ondre on minis at /home/ondre/x'), `ondre on minis at ${HOST_PATH_PLACEHOLDER}`, 'the path rules alone')
})

test('a segment of an absolute path the path rules leave alone is still a name, and so is one in a branch', () => {
  const person = createPathRewriter([{ name: 'app', paths: ['/home/ondre/src/app'] }, { name: undefined, paths: ['/home/ondre'] }], 'linux', {
    users: ['ondre'], hosts: ['minis'],
  })
  // No host directory the path rules name (`/data`, `/scratch`, `/home2`): the names are all there is to rewrite.
  assert.equal(person.rewrite('cp /data/ondre/in.csv . && ls /scratch/minis/ondre/ /home2/ondre/x'),
    'cp /data/<user>/in.csv . && ls /scratch/<host>/<user>/ /home2/<user>/x')
  // However the absolute path is written, and whatever stands before it.
  for (const [text, expected] of [
    ['//fileserver/share/ondre/notes.txt', '//fileserver/share/<user>/notes.txt'],
    ['\\\\fileserver\\share\\ondre\\notes.txt', HOST_PATH_PLACEHOLDER],
    ['file:///data/ondre/x', 'file:///data/<user>/x'],
    ['~other/ondre/x', '~other/<user>/x'],
    ['D:data\\ondre\\x', 'D:data\\<user>\\x'],
    ['C:\\Users\\ondre\\x', HOST_PATH_PLACEHOLDER],
    ['(/data/ondre/x), --out=/data/ondre/x, cwd:/data/ondre/x', '(/data/<user>/x), --out=/data/<user>/x, cwd:/data/<user>/x'],
    ['"/data/ondre/x"', '"/data/<user>/x"'],
    // A redirection, `@file`, emphasis or a one-letter option in front of the path is not part of it.
    ['echo x >/data/ondre/out.log', 'echo x >/data/<user>/out.log'],
    ['cmd 2>/data/ondre/err &>/data/ondre/all', 'cmd 2>/data/<user>/err &>/data/<user>/all'],
    ['sort </data/ondre/in', 'sort </data/<user>/in'],
    ['curl -d @/data/ondre/body', 'curl -d @/data/<user>/body'],
    ['**/data/ondre/x**', '**/data/<user>/x**'],
    ['gcc -o/data/ondre/bin -I/data/ondre/include x.c', 'gcc -o/data/<user>/bin -I/data/<user>/include x.c'],
    // A route with no host cannot be told from an absolute path.
    ['/api/ondre/runs', '/api/<user>/runs'],
  ]) {
    assert.equal(person.rewrite(text!), expected, text)
  }
  // A relative path, a URL and a root's own tail still keep a folder spelled like the user.
  assert.equal(person.rewrite('see (src/ondre/x.ts), https://github.com/ondre/app and /home/ondre/src/app/ondre/y.ts'),
    'see (src/ondre/x.ts), https://github.com/ondre/app and <app>/ondre/y.ts')
  // So do a glob, a scoped package, a numbered folder and a path that goes on from what the shell expands.
  for (const text of ['src/**/ondre/x.ts', 'node_modules/@types/ondre/index.d.ts', '2024/ondre/notes.md', '$(pwd)/ondre/x', '${ROOT}/ondre/x']) {
    assert.equal(person.rewrite(text), text, text)
  }
  // Known limits: a directory with a space in its name reads as prose from the space on, and a glob that
  // starts at `*` cannot be told from emphasis around an absolute path.
  assert.equal(person.rewrite('/data/My Files/ondre/in.csv'), '/data/My Files/ondre/in.csv')
  assert.equal(person.rewrite('**/ondre/*.ts'), '**/<user>/*.ts')
  // A branch is a name, never a path the model resolves: every segment of it is rewritten.
  assert.equal(person.rewriteBranch('feature/ondre/fix'), 'feature/<user>/fix')
  assert.equal(person.rewriteBranch('minis/ondre'), '<host>/<user>')
  assert.equal(person.rewrite('feature/ondre/fix'), 'feature/ondre/fix', 'as prose it could be a folder')
})

test('a long token full of names is read once, not once per name', () => {
  const person = createPathRewriter([{ name: undefined, paths: ['/home/ondre'] }], 'linux', { users: ['ondre'], hosts: ['minis'] })
  // An agent's tool output, or a file it prints: every name a folder of the one relative path.
  const text = `src/${'ondre/'.repeat(50_000)}x.ts`
  const began = performance.now()
  const rewritten = person.rewrite(text)
  const elapsed = performance.now() - began
  assert.equal(rewritten, text)
  // Scanning back to the token's start for each name took minutes for this, the host's heartbeat blocked meanwhile.
  // A linear pass is milliseconds; the bound leaves a busy CI runner room while still catching the quadratic scan.
  assert.ok(elapsed < 5_000, `${Math.round(elapsed)} ms for ${text.length} characters`)
})

test('the last pass keeps identifiers whole, so a session named after its user still passes the report schema', () => {
  const session = {
    sessionId: '0f0e0d0c-0b0a-4908-8706-050403020100', ownerKey: `sha256:${'a'.repeat(64)}`, title: 'fix the build on minis for ondre',
    status: 'interrupted', reason: 'agent_exited', agent: 'codex', root: 'ondre', updatedAt: '2026-09-23T10:00:00.000Z',
  }
  const rewriter = createPathRewriter([], 'linux', { users: ['ondre', 'codex', 'claude'], hosts: ['minis'] })
  const answer = rewriteCodingAnswer({ sessions: [session] }, rewriter) as { sessions: unknown[] }
  const [summary] = answer.sessions
  assert.deepEqual(summary, { ...session, title: 'fix the build on <host> for <user>' })
  assert.equal(ExecutorCodingSessionSummarySchema.safeParse(summary).success, true)
  // What session_list offers the model to start a session with comes back as it went in.
  const offered = { roots: [{ name: 'ondre', available: true }], agents: ['claude', 'codex'] }
  assert.deepEqual(rewriteCodingAnswer(offered, rewriter), offered)
  // A pull request's link keeps its owner; prose beside it does not.
  assert.deepEqual(rewriteCodingAnswer({ pullRequests: { '<user>/fix': { url: 'https://github.com/ondre/ondre', state: 'OPEN' } }, note: 'ondre' }, rewriter),
    { pullRequests: { '<user>/fix': { url: 'https://github.com/ondre/ondre', state: 'OPEN' } }, note: '<user>' })
})

test('a test command is recognised by the program it runs, with its exit code from the tool result', () => {
  for (const command of ['pnpm test', 'pnpm --filter @nessie/executor test', 'npm run test:unit', 'npx vitest run',
    'cargo test -p x', 'go test ./...', 'node --test test/a.test.ts', 'cd x && pytest -q']) {
    assert.equal(looksLikeTestCommand(command), true, command)
  }
  for (const command of ['git status', 'pnpm build', 'cat test.txt', 'echo testing']) {
    assert.equal(looksLikeTestCommand(command), false, command)
  }
  assert.equal(exitCodeFromToolResult('Exit code 3\nFAIL', true), 3)
  assert.equal(exitCodeFromToolResult('ok', false), 0)
  assert.equal(exitCodeFromToolResult('crashed', true), null)
})
