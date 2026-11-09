#!/usr/bin/env node
import { EXECUTOR_PACKAGED_BUNDLE_FILE } from './runtime-integrity.js'

/**
 * What a person sees when they run the packaged bundle by hand. It names the
 * marker and the supported way in, because the two callers who hit this are a
 * hand-written autostart script and somebody debugging one.
 */
export const UNMARKED_BUNDLE_MESSAGE =
  `${EXECUTOR_PACKAGED_BUNDLE_FILE} ran no command: it is the packaged Nessie Computer CLI and `
  + 'must be started by its package, which sets NESSIE_EXECUTOR_PACKAGED_CLI=1. '
  + 'Start Nessie Computer through its app or installed service; to run this '
  + 'bundle directly, set that variable first.'

/**
 * Whether this process was started to *be* the CLI, as opposed to importing it.
 *
 * The source entry is `index.js`/`index.ts`. The packaged bundle is
 * `nessie-executor.cjs`, which neither name matches, so the package marks
 * itself with `NESSIE_EXECUTOR_PACKAGED_CLI`. Installed-only custody and update
 * paths read that marker, so an entry point must never set it on its own behalf.
 * Public Windows ACL checks use their fixed native sibling independently;
 * finding that helper never makes a source process an installed package.
 */
export const executorCliEntry = (
  invokedPath: string | undefined,
  packagedMarker: string | undefined,
): 'run' | 'unmarked-bundle' | 'imported' => {
  if (invokedPath?.endsWith('index.js') || invokedPath?.endsWith('index.ts')) return 'run'
  if (packagedMarker === '1') return 'run'
  // Being named as argv[1] means a person or a script asked this file to do
  // something. Without the marker it cannot, and exiting 0 in silence — the
  // old behaviour — is indistinguishable from a daemon that started and
  // detached. An autostart script built that way leaves a machine with no
  // executor and no evidence of why.
  if (invokedPath?.endsWith(EXECUTOR_PACKAGED_BUNDLE_FILE)) return 'unmarked-bundle'
  return 'imported'
}

/**
 * A coding-session host, its bridge and the agent guard start once per
 * session or per agent, so each loads only its own modules: on a busy machine
 * loading the whole daemon took most of a session's start.
 */
const runCommand = async (args: string[]): Promise<void> => {
  if (args[0] === 't3-session-runtime') {
    await (await import('./t3-session/runtime/protected-entry.js')).runProtectedT3SessionRuntime(args.slice(1))
    return
  }
  if (await (await import('./builtin-mcp-cli.js')).runBuiltinMcpCli(args)) return
  await (await import('./cli.js')).run(args)
}

const entry = executorCliEntry(process.argv[1], process.env.NESSIE_EXECUTOR_PACKAGED_CLI)
if (entry === 'run') {
  runCommand(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
} else if (entry === 'unmarked-bundle') {
  process.stderr.write(`${UNMARKED_BUNDLE_MESSAGE}\n`)
  process.exitCode = 1
}
