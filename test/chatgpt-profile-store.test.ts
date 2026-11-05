import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CHATGPT_ISSUER, type ChatgptTokens } from '../src/chatgpt-oauth-provider.js'
import { ChatgptCredentialStore, type ChatgptCredentialAuthority } from '../src/chatgpt-credential-store.js'
import { ChatgptProfileStore, chatgptBytesDigest } from '../src/chatgpt-profile-store.js'
import { ChatgptProfileRecordSchema, publicChatgptProfileStatus } from '../src/chatgpt-profile-records.js'
import { ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../src/state-security.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'

const security = { platform: 'win32' as const, helper: verifyInferenceTestState }
const tokens = (): ChatgptTokens => ({ issuer: CHATGPT_ISSUER, subject: 'opaque-openai-subject',
  idToken: 'fixture-id-token', accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
  expiresAt: 2099999999999, scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-chatgpt-profile-'))
  await ensureOwnerOnlyStateDirectory(root, security)
  const profileId = randomUUID()
  let current = true
  const mutation = {
    root, durability: 'process_crash' as const,
    ensureDirectory: (path: string) => ensureOwnerOnlyStateDirectory(path, security),
    barrier: async () => undefined, // Explicit CAS fixture, no native durability claim.
    mutate: async (path: string, input: {
      operation: 'replace'; bytes: Uint8Array; expectedDigest: string | null
    } | { operation: 'delete'; expectedDigest: string }) => {
      const prior = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      assert.equal(prior ? chatgptBytesDigest(prior) : null, input.expectedDigest, 'actual fixture bytes CAS')
      if (input.operation === 'delete') await unlink(path)
      else {
        await writeFile(path, input.bytes, { mode: 0o600 })
        await secureOwnerOnlyStateFile(path, security)
      }
    },
  }
  const store = new ChatgptProfileStore({ directory: root, security })
  const credentials = (authority: ChatgptCredentialAuthority = {
    assertCurrent: async () => { if (!current) throw new Error('credential_fenced') },
  }) => new ChatgptCredentialStore({ mutation, profileId,
    accountGeneration: 1, consentRevision: 1, security,
    authority })
  return { root, profileId, store, credentials, fence: () => { current = false },
    path: join(root, 'profiles', profileId, 'credentials.json'),
    clean: () => rm(root, { recursive: true, force: true }) }
}

test('public profile projection and exact selected-team filtering never read credential bytes', async () => {
  const f = await fixture()
  try {
    const intent = { version: 1 as const, kind: 'personal-chatgpt-connect' as const,
      apiOrigin: 'https://nessie.example', executorId: randomUUID(),
      organizationId: randomUUID(), teamId: randomUUID() }
    const record = ChatgptProfileRecordSchema.parse({ apiOrigin: intent.apiOrigin, executorId: intent.executorId,
      organizationId: intent.organizationId, teamId: intent.teamId,
      format: 1, revision: 0, profileId: f.profileId, phase: 'disconnected', reason: null,
      planEnabled: false, hostExecutionRestricted: false, operationId: null, principal: null,
      accountGeneration: 1, consentRevision: 1, publicKey: 'p'.repeat(64), credentialProcess: null,
      registration: { clientId: 'issued-workspace-registration', extAgentHostId: await f.store.hostId(),
        issuer: CHATGPT_ISSUER, subject: 'opaque-openai-subject' } })
    await f.store.update(f.profileId, () => record)
    await f.credentials().save(tokens())
    assert.equal((await f.store.scoped(intent)).length, 1)
    assert.equal((await f.store.connection(intent.apiOrigin, intent.executorId)).length, 1)
    assert.equal((await f.store.connection('https://other.example', intent.executorId)).length, 0)
    assert.equal((await f.store.connection(intent.apiOrigin, randomUUID())).length, 0)
    assert.equal((await f.store.scoped({ ...intent, teamId: randomUUID() })).length, 0)
    assert.equal((await f.store.scoped({ ...intent, executorId: randomUUID() })).length, 0)
    const publicStatus = JSON.stringify(publicChatgptProfileStatus(record))
    for (const secret of ['opaque-openai-subject', 'issued-workspace-registration', 'fixture-access-token',
      'publicKey', 'credentialProcess', 'principal']) assert.equal(publicStatus.includes(secret), false)
    assert.equal(await f.store.hostId(), record.registration.extAgentHostId)
  } finally { await f.clean() }
})

test('refresh consumes durable predecessor once and preserves account/consent through replacement CAS', async () => {
  const f = await fixture()
  try {
    await f.credentials().save(tokens())
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const first = f.credentials().refresh(async previous => {
      calls += 1; entered(); await held
      assert.equal(previous.refreshToken, 'fixture-refresh-token')
      return { ...previous, refreshToken: 'rotated-refresh-token', accessToken: 'rotated-access-token' }
    })
    await started
    const spent = JSON.parse(await readFile(f.path, 'utf8'))
    assert.equal(spent.tokens, null)
    assert.equal(spent.revision, 2)
    assert.equal((await readFile(f.path, 'utf8')).includes('fixture-refresh-token'), false)
    await assert.rejects(f.credentials().refresh(async previous => { calls += 1; return previous }), /admission_busy/u)
    release()
    assert.equal((await first).accessToken, 'rotated-access-token')
    assert.equal(calls, 1)
    const next = JSON.parse(await readFile(f.path, 'utf8'))
    assert.equal(next.revision, 3)
    assert.equal(next.accountGeneration, 1)
    assert.equal(next.consentRevision, 1)
  } finally { await f.clean() }
})

for (const failure of ['ambiguous', 'malformed', 'fenced']) {
  test(`a ${failure} refresh never restores or retries spent predecessor bytes`, async () => {
    const f = await fixture()
    try {
      await f.credentials().save(tokens())
      let calls = 0
      await assert.rejects(f.credentials().refresh(async previous => {
        calls += 1
        if (failure === 'ambiguous') throw new Error('fixture transport ambiguity')
        if (failure === 'fenced') f.fence()
        return { ...previous, refreshToken: failure === 'malformed' ? null : 'replacement' }
      }))
      const spent = JSON.parse(await readFile(f.path, 'utf8'))
      assert.equal(spent.tokens, null)
      await assert.rejects(f.credentials().refresh(async previous => { calls += 1; return previous }))
      assert.equal(calls, 1)
    } finally { await f.clean() }
  })
}

test('remote revocation failure still deletes every local token byte before reporting local clearance', async () => {
  const f = await fixture()
  try {
    await f.credentials().save(tokens())
    const outcome = await f.credentials().clear(async () => { throw new Error('remote revocation ambiguous') })
    assert.equal(outcome.remoteRevoked, false)
    await assert.rejects(readFile(f.path), { code: 'ENOENT' })
    await assert.rejects(f.credentials().load(), /credential_fenced/u)
  } finally { await f.clean() }
})

test('disconnect custody can delete bytes but cannot load, refresh or publish a token grant', async () => {
  const f = await fixture()
  try {
    await f.credentials().save(tokens())
    const clearing = f.credentials({ assertCurrent: async purpose => {
      if (purpose !== 'clear') throw new Error('disconnect_grant_fenced')
    } })
    await assert.rejects(clearing.load(), /disconnect_grant_fenced/u)
    await assert.rejects(clearing.refresh(async previous => previous), /disconnect_grant_fenced/u)
    await assert.rejects(clearing.save(tokens()), /disconnect_grant_fenced/u)
    assert.equal((await clearing.clear(async () => false)).remoteRevoked, false)
    await assert.rejects(readFile(f.path), { code: 'ENOENT' })
  } finally { await f.clean() }
})

test('explicit new sign-in retires only a spent marker and never retries its predecessor grant', async () => {
  const f = await fixture()
  try {
    await f.credentials().save(tokens())
    assert.equal(await f.credentials().clearSpent(), false)
    assert.equal((await f.credentials().load()).refreshToken, 'fixture-refresh-token')
    let grants = 0
    await assert.rejects(f.credentials().refresh(async () => {
      grants += 1
      throw new Error('fixture uncertain refresh')
    }))
    assert.equal(await f.credentials().clearSpent(), true)
    await f.credentials().save({ ...tokens(), refreshToken: 'new-code-grant-refresh' })
    assert.equal((await f.credentials().load()).refreshToken, 'new-code-grant-refresh')
    assert.equal(grants, 1)
  } finally { await f.clean() }
})
