import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import { createRetainedCatalogService } from '../../dist/t3-session/catalog/service.js'
import { catalogFixture } from './fixture.mjs'

const read = service => service.http.shellSnapshot({ params: undefined, query: {} })

test('missing producers and wrong source identities deny before opening destination', async () => {
  const f = await catalogFixture({ messages: 0 })
  try {
    let opens = 0
    const reopen = f.ports.workspace.reopenGeneration
    f.ports.workspace.reopenGeneration = async ref => { opens++; return reopen(ref) }
    for (const field of ['physicalRootKey', 'environmentId']) {
      const service = createRetainedCatalogService(f.ports, { ...f.selection, [field]: 'wrong:opaque-id' })
      await assert.rejects(Effect.runPromise(read(service)), /source_mismatch/u)
    }
    for (const field of ['source', 'originalOwner']) {
      const service = createRetainedCatalogService({ ...f.ports, [field]: undefined }, f.selection)
      await assert.rejects(Effect.runPromise(read(service)), /required_retained_read_producers/u)
    }
    assert.equal(opens, 0)
  } finally { f.close() }
})

for (const phase of ['entry', 'final']) {
  test(`catalog ${phase} denial cannot leak an entitled prefix or omit an unauthorized family`, async () => {
    const f = await catalogFixture({ messages: 0 })
    try {
      let opened = false
      const reopen = f.ports.workspace.reopenGeneration
      f.ports.workspace.reopenGeneration = async ref => { opened = true; return reopen(ref) }
      f.ports.originalOwner = { withReadScope: async (_input, use) => use({
        recheckSource: async () => {},
        recheckThread: async id => {
          if (id === f.ids.at(-1) && (phase === 'entry' || opened)) throw new Error('synthetic-owner-revoked')
        },
      }) }
      await assert.rejects(Effect.runPromise(read(f.service)), /synthetic-owner-revoked/u)
      assert.equal(opened, phase === 'final')
    } finally { f.close() }
  })
}

for (const race of ['advance', 'unavailable', 'cancel']) {
  test(`catalog ${race} during destination open refuses the completed result`, async () => {
    const f = await catalogFixture({ messages: 0 })
    try {
      const controller = new AbortController()
      const reopen = f.ports.workspace.reopenGeneration
      f.ports.workspace.reopenGeneration = async ref => {
        const stage = await reopen(ref)
        if (race === 'advance') f.ports.journal.begin(f.source, 'new-generation', 'new-stage')
        if (race === 'unavailable') f.ports.journal.unavailable(f.source.admittedRootKey)
        if (race === 'cancel') controller.abort()
        return stage
      }
      await assert.rejects(Effect.runPromise(read(f.service), { signal: controller.signal }))
    } finally { f.close() }
  })
}
