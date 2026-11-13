import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readRequestSource } from './source-fixture.mjs'

const { privacy } = await readRequestSource()
const canary = 'synthetic-P02-outer-response-🧭'
const denied = { privacy: 'request_projection_unavailable' }
const noCanary = value => assert.equal(JSON.stringify(value).includes(canary), false)
const request = (id = 41, callId = 'native-call') => ({
  id, method: 'item/tool/call', params: {
    namespace: 't3-code', tool: 'request_secret', callId, arguments: { value: canary },
  },
})

test('Codex request IDs and native callId independently bind responses, errors and replay', () => {
  for (const id of [41, '41', '__proto__']) {
    const project = privacy.createRequestPrivacyProjector()
    noCanary(project(request(id)))
    for (const frame of [
      { id, result: { contentItems: [{ type: 'inputText', text: canary }] } },
      { id, error: { message: canary } },
      { callId: 'native-call', contentItems: [{ type: 'inputText', text: canary }] },
      { params: { callId: 'native-call', result: { value: canary } } },
    ]) {
      const safe = project(frame)
      noCanary(safe)
      assert.deepEqual(project(safe), safe)
    }
  }
  const project = privacy.createRequestPrivacyProjector()
  noCanary(project([{ id: 41, result: { value: canary } }, request()]))
  assert.deepEqual(project({ id: '41', result: 'ordinary different typed ID' }),
    { id: '41', result: 'ordinary different typed ID' })
})

test('admitted MCP metadata validates scalar types and recursively projects native references', () => {
  for (const method of ['tools/call', 'item/tool/call']) {
    for (const field of ['status', 'id', 'callId', 'success', 'ordinal', 'namespace', 'nativeItemRef']) {
      const project = privacy.createRequestPrivacyProjector()
      noCanary(project({ id: 8, method, params: {
        namespace: 't3-code', tool: 'request_secret', arguments: { value: canary },
        [field]: { result: { value: canary } },
        // Keep a separate exact identity when the namespace itself is malformed.
        name: 't3-code.request_secret',
      } }))
    }
  }
  const project = privacy.createRequestPrivacyProjector()
  const safe = project({ ...request(), nativeItemRef: {
    driver: 'codex', nativeId: 'item', strength: 'exact', extra: { value: canary },
  } })
  noCanary(safe)
  const valid = { driver: 'codex', nativeId: 'item', strength: 'exact' }
  assert.deepEqual(project({ ...request(), nativeItemRef: valid }).nativeItemRef, valid)
})

test('primitive members, sparse arrays and huge objects exhaust bounded work and stop before later getters', () => {
  for (const huge of [Array(40000).fill(1), Array(40000),
    Object.fromEntries(Array.from({ length: 40000 }, (_, i) => [`field${i}`, 1]))]) {
    let getterCalls = 0
    const value = { huge }
    Object.defineProperty(value, 'later', { enumerable: true, get() { getterCalls++; return canary } })
    const project = privacy.createRequestPrivacyProjector()
    assert.equal(project(value).privacy, denied.privacy)
    assert.equal(getterCalls, 0)
    assert.deepEqual(project({ value: canary }), denied, 'exhaustion is sticky for this logger')
  }
})

test('malformed accessors are never executed, even before exhaustion or inside secret arguments', () => {
  let getterCalls = 0
  const fields = { label: 'Token' }
  Object.defineProperty(fields, 'value', { enumerable: true, get() { getterCalls++; return canary } })
  noCanary(privacy.projectSecretRequestInput('t3-code.request_secret', fields))
  assert.deepEqual(privacy.createRequestPrivacyProjector()({ payload: fields }), denied)
  assert.equal(getterCalls, 0)
})

test('identifier bytes and aggregate correlation bytes are bounded independently of count', () => {
  for (const hugeId of ['x'.repeat(2048), '🧭'.repeat(300), 'x'.repeat(2 * 1024 * 1024)]) {
    for (const frame of [request(hugeId), request(1, hugeId)]) {
      const project = privacy.createRequestPrivacyProjector()
      assert.deepEqual(project(frame), denied)
      assert.deepEqual(project({ id: 1, result: canary }), denied)
    }
  }
  const project = privacy.createRequestPrivacyProjector()
  let accepted = 0
  for (let i = 0; i < 4096; i++) {
    const safe = project(request(`request-${i}-${'x'.repeat(900)}`, `call-${i}`))
    if (safe.privacy === denied.privacy) break
    accepted++
  }
  assert.ok(accepted > 0 && accepted < 1024, `correlation byte budget must precede count: ${accepted}`)
  assert.deepEqual(project({ id: 1, result: canary }), denied)
})

test('correlation count and question metadata share a bound; equivalent batched frames cannot evade it', () => {
  for (const batched of [false, true]) {
    const project = privacy.createRequestPrivacyProjector()
    let accepted = 0
    for (let i = 0; i < 10000; i++) {
      const frame = i % 2 ? { id: `question-${i}`, isSecret: true, answer: canary }
        : request(i, `native-${i}`)
      const safe = project(batched ? [frame] : frame)
      if (safe.privacy === denied.privacy) break
      noCanary(safe)
      accepted++
    }
    assert.ok(accepted > 2048 && accepted < 8192, `bounded combined identifiers: ${accepted}`)
    assert.deepEqual(project({ id: 1, result: canary }), denied)
  }
})

test('oversized arrays are denied before reading any element descriptor', () => {
  let reads = 0
  const huge = new Proxy(Array(40000).fill(1), {
    getOwnPropertyDescriptor(target, key) { reads++; return Reflect.getOwnPropertyDescriptor(target, key) },
  })
  assert.deepEqual(privacy.createRequestPrivacyProjector()(huge), denied)
  assert.ok(reads <= 2, `the array was stopped at its length: ${reads}`)
})
