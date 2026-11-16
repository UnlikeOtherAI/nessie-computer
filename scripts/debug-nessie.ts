// The debug control plane's entry point (`docs/debug-control-plane.md`): `pnpm debug:nessie <command>`.
import { runDebugNessieCli } from '../src/debug-nessie/cli.js'

runDebugNessieCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
