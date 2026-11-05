import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const run = promisify(execFile)
const fixture = fileURLToPath(new URL('./fixtures/paused-http-response.mjs', import.meta.url))

for (const transport of ['runtime', 'local']) {
  for (const framing of ['length', 'eof', 'short', 'chunked']) {
    test(`${transport} HTTP transport survives paused FIN and handles ${framing} correctly`, async () => {
      // An uncatchable socket assertion must fail this child without killing the suite.
      const result = await run(process.execPath, ['--import', 'tsx', fixture, framing, transport], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 10000,
      })
      assert.match(result.stdout, new RegExp(`completed ${framing} ${transport}`))
      assert.equal(result.stderr, '')
    })
  }
}
