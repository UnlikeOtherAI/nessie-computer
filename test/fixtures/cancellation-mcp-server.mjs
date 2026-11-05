import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const journal = process.env.NESSIE_TEST_TREE_LOG
appendFileSync(journal, `${process.pid}\n`)
if (process.argv[2] === 'child') {
  spawn(process.execPath, [import.meta.filename, 'grandchild'], { env: process.env, stdio: 'ignore', windowsHide: true })
  setInterval(() => undefined, 1000)
} else if (process.argv[2] === 'grandchild') {
  setInterval(() => undefined, 1000)
} else {
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line)
    if (request.method === 'initialize') process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tree', version: '1' } },
    })}\n`)
    if (request.method === 'tools/call') {
      if (request.params.name === 'persist') {
        spawn(process.execPath, [import.meta.filename, 'child'], {
          detached: true, env: process.env, stdio: 'ignore', windowsHide: true,
        }).unref()
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [] } })}\n`)
      } else if (process.env.NESSIE_TEST_PERSISTENT_HOST !== '1') {
        spawn(process.execPath, [import.meta.filename, 'child'], { env: process.env, stdio: 'ignore', windowsHide: true })
      }
    }
  })
}
