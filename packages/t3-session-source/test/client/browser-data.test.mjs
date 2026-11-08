import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const source = await readFile(new URL('../../../../patches/t3-session/client-connection/browser-data.ts',
  import.meta.url), 'utf8')
const { createBrowserDataBoundary, browserDataPrefix } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)
const storage = () => {
  const values = new Map()
  const failures = new Set()
  return { values, failures, get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => { if (failures.has(key)) throw Error('synthetic persistence failure'); values.delete(key) } }
}

test('cold start removes previous scope caches and pending-data keys, preserving unrelated storage', () => {
  const store = storage()
  store.values.set(`${browserDataPrefix}old:thread`, 'original-cache-bytes')
  store.values.set(`${browserDataPrefix}old:outbox`, 'synthetic-pending-bytes')
  store.values.set('another-feature', 'keep')
  const data = createBrowserDataBoundary(store, 'new-team-generation')
  data.prepare()
  assert.deepEqual([...store.values], [['another-feature', 'keep']])
  data.write('thread', 'new-original-cache-bytes')
  assert.equal(data.read('thread'), 'new-original-cache-bytes')
})

test('retirement denies late reads and writes even when persistent cleanup fails; retry deletes leftovers', () => {
  const store = storage(), data = createBrowserDataBoundary(store, 'scope')
  data.prepare()
  data.write('thread', 'cached')
  data.write('outbox', 'synthetic pending')
  const failing = `${browserDataPrefix}scope:thread`
  store.failures.add(failing)
  assert.throws(data.clear, /CLEANUP_FAILED/u)
  assert.deepEqual([...store.values.keys()], [failing])
  assert.throws(() => data.read('thread'), /RETIRED/u)
  assert.throws(() => data.write('thread', 'late'), /RETIRED/u)
  store.failures.clear()
  data.clear()
  assert.equal(store.length, 0)
})

test('failed cold cleanup never enables storage and a subsequent preparation retries', () => {
  const store = storage(), key = `${browserDataPrefix}old:thread`
  store.values.set(key, 'cached')
  store.failures.add(key)
  const data = createBrowserDataBoundary(store, 'next')
  assert.throws(data.prepare, /CLEANUP_FAILED/u)
  assert.throws(() => data.write('thread', 'not admitted'), /RETIRED/u)
  store.failures.clear()
  data.prepare()
  data.write('thread', 'admitted lifetime')
  assert.equal(data.read('thread'), 'admitted lifetime')
})

test('a retired lifetime cannot delete a newer lifetime cache', () => {
  const store = storage(), old = createBrowserDataBoundary(store, 'old'), next = createBrowserDataBoundary(store, 'new')
  old.prepare()
  old.write('thread', 'old')
  old.retire()
  next.prepare()
  next.write('thread', 'current')
  old.clear()
  assert.equal(next.read('thread'), 'current')
})
