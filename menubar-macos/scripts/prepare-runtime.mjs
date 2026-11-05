// The menu bar app's copy of the packaged executor runtime.
//
// The preparation itself lives in executor/scripts/prepare-runtime.mjs because
// the Linux `nessie-executor` package, the desktop bundle and this app install
// the identical layout; this script only decides where the app bundle wants it.
// The native creator and OS-user context are required for personal custody.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareMacExecutorRuntime } from '../../packaging/macos/prepare-runtime.mjs'

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(appDirectory, '..')

const outputDirectory = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(appDirectory, 'build/executor-runtime')

const prepared = await prepareMacExecutorRuntime(repositoryDirectory, outputDirectory)

// The build script copies this directory into the app bundle's Resources, so the
// last line is the path it reads.
process.stdout.write(`${prepared.runtimeDirectory}\n`)
