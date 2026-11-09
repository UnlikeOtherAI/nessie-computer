import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { saveExecutorState } from '../src/state-store.js'
import { readTeamLabel, saveTeamLabel, teamLabelPath, teamLabelStale } from '../src/team-label.js'
import { runTeamNamesCli } from '../src/team-names-cli.js'
import { refreshTeamNames, type TeamNameSource } from '../src/team-names.js'
import { fakeTeamNames, type FakeBatchFailure } from './support/fake-team-names.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/**
 * Team names without a person (contract §13): one signed batch per Nessie
 * server, every answer saved as the team's display-only label, and nothing
 * that fails ever blanking a name the computer already had.
 */

const skip = WINDOWS_STATE_HELPER_SKIP
const HOSTED = 'https://api.example.test'
const OWN = 'https://nessie.acme.example'
const SALES = '00000000-0000-4000-8000-0000000000a1'
const RESEARCH = '00000000-0000-4000-8000-0000000000a2'
const LEGAL = '00000000-0000-4000-8000-0000000000a3'
const now = () => new Date('2026-11-08T12:00:00.000Z')

const keyOf = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')

const withTeams = async (
  teams: Array<{ executorId: string; apiBaseUrl: string }>,
  body: (sources: TeamNameSource[], keys: Map<string, string>) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-team-names-'))
  try {
    const keys = new Map<string, string>()
    const sources: TeamNameSource[] = []
    for (const team of teams) {
      const machinePrivateKey = keyOf()
      keys.set(team.executorId, machinePrivateKey)
      sources.push({ stateDir: await ensureOwnerOnlyStateDirectory(join(root, team.executorId)),
        state: { ...team, machinePrivateKey } })
    }
    await body(sources, keys)
  } finally { await rm(root, { force: true, recursive: true }) }
}

test('two teams on one server are named in one signed request, and each label is saved', { skip }, async () => {
  await withTeams([{ executorId: SALES, apiBaseUrl: HOSTED }, { executorId: RESEARCH, apiBaseUrl: HOSTED }],
    async (sources, keys) => {
      const nessie = fakeTeamNames({ keys, names: {
        [SALES]: { organizationName: 'Acme', teamName: 'Sales' },
        [RESEARCH]: { organizationName: 'Acme', teamName: 'Research' },
      } })
      const saved = await refreshTeamNames(sources, { api: nessie.api, now })
      assert.deepEqual(nessie.calls, [{ route: 'teams', baseUrl: HOSTED, executorIds: [SALES, RESEARCH] }])
      assert.equal(saved.size, 2)
      assert.deepEqual(await readTeamLabel(sources[0]!.stateDir), {
        organizationName: 'Acme', teamName: 'Sales', apiBaseUrl: HOSTED, checkedAt: now().toISOString() })
      assert.equal((await readTeamLabel(sources[1]!.stateDir))?.teamName, 'Research')
    })
})

test('teams on two servers are asked once per server', { skip }, async () => {
  await withTeams([{ executorId: SALES, apiBaseUrl: HOSTED }, { executorId: LEGAL, apiBaseUrl: OWN },
    { executorId: RESEARCH, apiBaseUrl: HOSTED }], async (sources, keys) => {
    const nessie = fakeTeamNames({ keys, names: {
      [SALES]: { organizationName: 'Acme', teamName: 'Sales' },
      [LEGAL]: { organizationName: 'Acme Legal', teamName: null },
    } })
    await refreshTeamNames(sources, { api: nessie.api, now })
    assert.deepEqual(nessie.calls.map((call) => [call.baseUrl, call.executorIds]).sort(),
      [[HOSTED, [SALES, RESEARCH]], [OWN, [LEGAL]]])
    assert.deepEqual(await readTeamLabel(sources[1]!.stateDir), {
      organizationName: 'Acme Legal', teamName: null, apiBaseUrl: OWN, checkedAt: now().toISOString() })
    assert.equal(await readTeamLabel(sources[2]!.stateDir), null, 'a team Nessie left out has no name yet')
  })
})

test('offline, refused or left out, a known name stays as it was', { skip }, async () => {
  await withTeams([{ executorId: SALES, apiBaseUrl: HOSTED }], async (sources) => {
    const log = () => undefined
    const known = await saveTeamLabel(sources[0]!.stateDir, { organizationName: 'Acme', teamName: 'Sales' }, HOSTED,
      () => new Date('2026-11-01T00:00:00.000Z'))
    await refreshTeamNames(sources, { api: fakeTeamNames({ unreachable: true, names: {} }).api, now, log })
    assert.deepEqual(await readTeamLabel(sources[0]!.stateDir), known)
    await refreshTeamNames(sources, { api: fakeTeamNames({ names: {} }).api, now, log })
    assert.deepEqual(await readTeamLabel(sources[0]!.stateDir), known)
    await refreshTeamNames(sources, { api: fakeTeamNames({ old: true, refuseConnection: true, names: {} }).api, now, log })
    assert.deepEqual(await readTeamLabel(sources[0]!.stateDir), known)
  })
})

test('a team renamed in Nessie gets its new name at the next refresh', { skip }, async () => {
  await withTeams([{ executorId: SALES, apiBaseUrl: HOSTED }], async (sources) => {
    await saveTeamLabel(sources[0]!.stateDir, { organizationName: 'Acme', teamName: 'Sales' }, HOSTED, now)
    await refreshTeamNames(sources, { now,
      api: fakeTeamNames({ names: { [SALES]: { organizationName: 'Acme Group', teamName: '  Revenue  ' } } }).api })
    const renamed = await readTeamLabel(sources[0]!.stateDir)
    assert.deepEqual([renamed?.teamName, renamed?.organizationName], ['Revenue', 'Acme Group'])
  })
})

test('a Nessie without the batched route names each team through its connection read', { skip }, async () => {
  await withTeams([{ executorId: SALES, apiBaseUrl: HOSTED }, { executorId: RESEARCH, apiBaseUrl: HOSTED }],
    async (sources, keys) => {
      const nessie = fakeTeamNames({ old: true, keys, names: { [SALES]: { organizationName: 'Acme', teamName: 'Sales' } } })
      await refreshTeamNames(sources, { api: nessie.api, now })
      assert.deepEqual(nessie.calls.map((call) => call.route), ['teams', 'connection', 'connection'])
      assert.equal((await readTeamLabel(sources[0]!.stateDir))?.teamName, 'Sales')
      assert.equal(await readTeamLabel(sources[1]!.stateDir), null)
    })
})

test('whatever keeps the batched read from answering, the connection read names the team and is logged once', { skip },
  async () => {
    const expected: Record<FakeBatchFailure, RegExp> = {
      missing: /HTTP 404/u,
      auth_required: /HTTP 401 AUTH_REQUIRED/u,
      server_error: /HTTP 500 INTERNAL/u,
      malformed: /not well formed/u,
    }
    for (const batch of Object.keys(expected) as FakeBatchFailure[]) {
      await withTeams([{ executorId: SALES, apiBaseUrl: HOSTED }, { executorId: RESEARCH, apiBaseUrl: HOSTED }],
        async (sources, keys) => {
          const nessie = fakeTeamNames({ batch, keys, names: {
            [SALES]: { organizationName: 'Acme', teamName: 'Sales' },
            [RESEARCH]: { organizationName: 'Acme', teamName: null },
          } })
          const logged: string[] = []
          const saved = await refreshTeamNames(sources, { api: nessie.api, now, log: (line) => logged.push(line) })
          assert.deepEqual(nessie.calls.map((call) => call.route), ['teams', 'connection', 'connection'], batch)
          assert.equal(saved.size, 2, batch)
          assert.deepEqual(await readTeamLabel(sources[0]!.stateDir), {
            organizationName: 'Acme', teamName: 'Sales', apiBaseUrl: HOSTED, checkedAt: now().toISOString() }, batch)
          assert.equal((await readTeamLabel(sources[1]!.stateDir))?.organizationName, 'Acme', batch)
          assert.equal(logged.length, 1, `${batch}: one line for the batched read, none for the reads that worked`)
          assert.match(logged[0]!, expected[batch])
          assert.match(logged[0]!, /api\.example\.test/u)
          for (const key of keys.values()) assert.ok(!logged[0]!.includes(key), 'no machine key is logged')
        })
    }
  })

test('a refresh that names nobody says why for every team, and keeps the saved label', { skip }, async () => {
  await withTeams([{ executorId: SALES, apiBaseUrl: HOSTED }], async (sources) => {
    const known = await saveTeamLabel(sources[0]!.stateDir, { organizationName: 'Acme', teamName: 'Sales' }, HOSTED,
      () => new Date('2026-11-01T00:00:00.000Z'))
    const logged: string[] = []
    await refreshTeamNames(sources, { now, log: (line) => logged.push(line),
      api: fakeTeamNames({ batch: 'auth_required', refuseConnection: true, names: {} }).api })
    assert.deepEqual(await readTeamLabel(sources[0]!.stateDir), known)
    assert.equal(logged.length, 2)
    assert.match(logged[1]!, new RegExp(`team ${SALES} \\(HTTP 401 UOA_SESSION_REQUIRED\\)`, 'u'))
    const quiet: string[] = []
    await refreshTeamNames(sources, { now, log: (line) => quiet.push(line),
      api: fakeTeamNames({ names: { [SALES]: { organizationName: 'Acme', teamName: 'Sales' } } }).api })
    assert.deepEqual(quiet, [], 'a refresh that works logs nothing')
  })
})

test('a damaged label reads as no name, and the command line asks again once a label is an hour old', { skip },
  async () => {
    await withTeams([{ executorId: SALES, apiBaseUrl: HOSTED }], async (sources) => {
      const { stateDir } = sources[0]!
      await writeFile(teamLabelPath(stateDir), '{"organizationName":"  ","apiBaseUrl":"x","checkedAt":"y"}\n',
        { mode: 0o600 })
      assert.equal(await readTeamLabel(stateDir), null)
      const label = await saveTeamLabel(stateDir, { organizationName: 'Acme', teamName: 'Sales' }, HOSTED, now)
      assert.equal(teamLabelStale(label, HOSTED, new Date('2026-11-08T12:59:00.000Z')), false)
      assert.equal(teamLabelStale(label, HOSTED, new Date('2026-11-08T13:00:00.000Z')), true)
      assert.equal(teamLabelStale(label, OWN, now()), true, 'a label from another server is not this one\'s')
      assert.equal(teamLabelStale(null, HOSTED, now()), true)
      await assert.rejects(saveTeamLabel(stateDir, { organizationName: ' ', teamName: 'Sales' }, HOSTED, now))
    })
  })

test('the apps\' team-names verb refreshes every listed team and prints the labels', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-team-names-cli-'))
  try {
    const directories: string[] = []
    for (const executorId of [SALES, RESEARCH]) {
      const stateDir = await ensureOwnerOnlyStateDirectory(join(root, executorId))
      const keys = generateKeyPairSync('ed25519')
      await saveExecutorState(stateDir, {
        apiBaseUrl: HOSTED, executorId,
        descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
          operationKeys: ['file.read'], profiles: ['workspace_sandbox'], revision: 1, workspaceFolders: ['work'] },
        machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
        machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
        workspaceFolders: [{ name: 'work', path: await ensureOwnerOnlyStateDirectory(join(root, `work-${executorId}`)) }],
      })
      directories.push(stateDir)
    }
    const empty = await ensureOwnerOnlyStateDirectory(join(root, 'pending'))
    const nessie = fakeTeamNames({ names: { [SALES]: { organizationName: 'Acme', teamName: 'Sales' } } })
    let out = ''
    const handled = await runTeamNamesCli(['team-names', '--state-dir', directories[0]!, '--state-dir', empty,
      '--state-dir', directories[1]!, '--json'], { api: nessie.api, now, write: (text) => { out += text } })
    assert.equal(handled, true)
    assert.equal(nessie.calls.length, 1)
    assert.deepEqual(JSON.parse(out), { teams: [
      { executorId: SALES, organizationName: 'Acme', teamName: 'Sales', apiBaseUrl: HOSTED },
      { executorId: RESEARCH, organizationName: null, teamName: null, apiBaseUrl: HOSTED },
    ] })
    assert.equal(await runTeamNamesCli(['teams']), false)
    await assert.rejects(runTeamNamesCli(['team-names', '--json']), /--state-dir/)
  } finally { await rm(root, { force: true, recursive: true }) }
})
