import assert from 'node:assert/strict'
import test from 'node:test'
import { createUoaConnectionAccount, UoaConnectionDenied } from '../../patches/t3-session/client-connection/uoa-account.ts'

const account = { subject: 'synthetic-person', organizationId: 'org', teamId: 'team', sessionId: 'session', expiresAt: 200_000 }
const environment = id => ({ environmentId: id, label: id,
  endpoint: { httpBaseUrl: `https://api.example/t3/environments/${id}/`, wsBaseUrl: `wss://api.example/t3/environments/${id}/ws` } })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const fixture = overrides => {
  let time = 1_000
  let directory = [environment('z-offline'), environment('a-online')]
  const calls = [], reports = [], timers = new Set()
  const ports = {
    prepare: async () => {},
    now: () => time,
    schedule: (callback, delay) => {
      const timer = { callback, at: time + delay }
      timers.add(timer)
      return () => timers.delete(timer)
    },
    list: async () => directory,
    authorize: async (selected, row) => ({ registration: `${selected.teamId}/${row.environmentId}`, expiresAt: 100_000 }),
    reconcile: async rows => { calls.push([...rows]) },
    report: category => reports.push(category),
    ...overrides,
  }
  const service = createUoaConnectionAccount(ports)
  return { service, calls, reports, ports, timers,
    setDirectory: rows => { directory = rows },
    advance: async value => {
      time = value
      for (const timer of [...timers]) if (timer.at <= time) { timers.delete(timer); timer.callback() }
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

test('registers every directory entry in exact order, including offline; refresh reuses unexpired leases', async () => {
  let authorizations = 0
  const f = fixture({ authorize: async (selected, row) => {
    authorizations++
    return { registration: row.environmentId, expiresAt: 100_000 }
  } })
  await f.service.setAccount(account)
  assert.deepEqual(f.calls.at(-1), ['z-offline', 'a-online'])
  await f.service.refresh()
  assert.equal(authorizations, 2)
  await f.service.dispose()
})

test('team changes withdraw first and discard a late old-team directory', async () => {
  const pending = deferred(), started = deferred()
  const f = fixture({ list: async selected => {
    if (selected.teamId === 'team') { started.resolve(); return pending.promise }
    return [environment('new')]
  } })
  const old = f.service.setAccount(account)
  await started.promise
  await f.service.setAccount({ ...account, teamId: 'next' })
  pending.resolve([environment('old')])
  await old
  assert.deepEqual(f.calls.at(-1), ['next/new'])
  assert.equal(f.calls.some(rows => rows.includes('team/old')), false)
  await f.service.dispose()
})

test('signout aborts bootstrap and rejects its late credential even if the host ignores cancellation', async () => {
  const pending = deferred(), started = deferred()
  let signal
  const f = fixture({ authorize: async (_account, _row, requestSignal) => {
    signal = requestSignal
    started.resolve()
    return pending.promise
  } })
  const old = f.service.setAccount(account)
  await started.promise
  await f.service.setAccount(null)
  assert.equal(signal.aborted, true)
  pending.resolve({ registration: 'retired-credential', expiresAt: 100_000 })
  await old
  assert.deepEqual(f.calls.at(-1), [])
  assert.equal(f.calls.some(rows => rows.includes('retired-credential')), false)
  await f.service.dispose()
})

test('authoritative removal withdraws before bootstrap of a new environment completes', async () => {
  const pending = deferred(), started = deferred()
  const f = fixture()
  await f.service.setAccount(account)
  f.setDirectory([environment('new')])
  f.ports.authorize = async () => { started.resolve(); return pending.promise }
  const refresh = f.service.refresh()
  await started.promise
  assert.deepEqual(f.calls.at(-1), [])
  pending.resolve({ registration: 'new', expiresAt: 100_000 })
  await refresh
  assert.deepEqual(f.calls.at(-1), ['new'])
  await f.service.dispose()
})

test('transient directory loss retains existing entries only until credential expiry', async () => {
  const f = fixture()
  await f.service.setAccount(account)
  f.ports.list = async () => { throw new Error('network unavailable') }
  await f.service.refresh()
  assert.deepEqual(f.calls.at(-1), ['team/z-offline', 'team/a-online'])
  await f.advance(100_001)
  assert.deepEqual(f.calls.at(-1), [])
  assert.ok(f.reports.includes('directory'))
  await f.service.dispose()
})

test('current authority denial withdraws; refresh cannot renew without a new account event', async () => {
  const f = fixture()
  await f.service.setAccount(account)
  f.ports.list = async () => { throw new UoaConnectionDenied() }
  await f.service.refresh()
  assert.deepEqual(f.calls.at(-1), [])
  f.ports.list = async () => [environment('revoked')]
  await f.service.refresh()
  assert.deepEqual(f.calls.at(-1), [])
  await f.service.dispose()
})

test('expired account never performs discovery, and live account expiry withdraws', async () => {
  const f = fixture()
  await f.service.setAccount({ ...account, expiresAt: 999 })
  assert.deepEqual(f.calls, [[]])
  await f.service.setAccount({ ...account, expiresAt: 20_000 })
  await f.advance(20_001)
  assert.deepEqual(f.calls.at(-1), [])
  await f.service.dispose()
})

test('repeated signout retries registry cleanup after a rejected persistence operation', async () => {
  let fail = true, attempts = 0
  const f = fixture({ reconcile: async () => { attempts++; if (fail) throw new Error('storage') } })
  await assert.rejects(f.service.setAccount(null), /storage/)
  fail = false
  await f.service.setAccount(null)
  assert.equal(attempts, 2)
  assert.deepEqual(f.reports, ['cleanup'])
  await f.service.dispose()
})

test('duplicate environment identities fail closed instead of merging or reordering', async () => {
  const f = fixture({ list: async () => [environment('same'), environment('same')] })
  await f.service.setAccount(account)
  assert.deepEqual(f.calls.at(-1), [])
  assert.equal(f.calls.some(rows => rows.length > 0), false)
  await f.service.dispose()
})

test('same-subject reauthentication gets a new generation; no old-session credentials survive', async () => {
  const f = fixture({ authorize: async (selected, row) => ({
    registration: `${selected.sessionId}/${row.environmentId}`, expiresAt: 100_000,
  }) })
  await f.service.setAccount(account)
  const marker = f.calls.length
  await f.service.setAccount({ ...account, sessionId: 'new-session' })
  assert.deepEqual(f.calls[marker], [])
  assert.deepEqual(f.calls.at(-1), ['new-session/z-offline', 'new-session/a-online'])
  await f.service.dispose()
})

test('renewal uses current account and keeps the original environment identities', async () => {
  let tokens = 0
  const f = fixture({ authorize: async (_selected, row) => ({
    registration: `${row.environmentId}:${++tokens}`, expiresAt: tokens <= 2 ? 40_000 : 150_000,
  }) })
  await f.service.setAccount(account)
  await f.advance(11_000)
  assert.deepEqual(f.calls.at(-1), ['z-offline:3', 'a-online:4'])
  await f.service.dispose()
})

test('failed cold-account cleanup blocks every registration path until a successful preparation retry', async () => {
  let failed = true, lists = 0
  const f = fixture({ prepare: async () => { if (failed) throw new Error('persisted cleanup incomplete') },
    list: async () => { lists++; return [environment('cold')] },
  })
  await assert.rejects(f.service.setAccount(account), /cleanup incomplete/)
  await f.service.refresh()
  assert.equal(lists, 0)
  failed = false
  await f.service.setAccount(account)
  assert.deepEqual(f.calls.at(-1), ['team/cold'])
  assert.equal(lists, 1)
  await f.service.dispose()
})
