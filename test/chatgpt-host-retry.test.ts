import assert from 'node:assert/strict'
import test from 'node:test'
import { CHATGPT_HOST_SETTLED_MS, chatgptHostRetryDelayMs, nextChatgptHostFailures } from '../src/chatgpt-host-retry.js'

test('a plan host that keeps failing connects again less and less often, up to once a minute', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 40].map(chatgptHostRetryDelayMs),
    [3000, 6000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000])
  assert.equal(chatgptHostRetryDelayMs(0), 3000)
})

test('ten minutes of failures stay far below the sixty challenges a network gets', () => {
  let elapsed = 0
  let failures = 0
  let connections = 0
  while (elapsed < 10 * 60_000) {
    connections += 1
    failures = nextChatgptHostFailures(failures, 0)
    elapsed += chatgptHostRetryDelayMs(failures)
  }
  assert.equal(connections, 14)
})

test('a failure after a settled run waits three seconds again', () => {
  assert.equal(nextChatgptHostFailures(6, CHATGPT_HOST_SETTLED_MS), 1)
  assert.equal(nextChatgptHostFailures(6, CHATGPT_HOST_SETTLED_MS - 1), 7)
})
