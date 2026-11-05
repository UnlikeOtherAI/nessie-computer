import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const result = spawnSync(process.execPath, ['--max-old-space-size=5120', compiler, ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
