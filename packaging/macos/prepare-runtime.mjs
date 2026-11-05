// The native helper is a custody dependency of every macOS executor package.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'

export const prepareMacExecutorRuntime = async (repository, outputDirectory, executorVersion = 'development') => {
  if (process.platform !== 'darwin') throw new Error('Prepare the macOS executor on macOS.')
  await promisify(execFile)('cargo', ['build', '--release', '--manifest-path',
    join(repository, 'native/Cargo.toml')], { maxBuffer: 16 * 1024 * 1024 })
  return prepareExecutorRuntime({ entryPoint: join(repository, 'src/index.ts'), outputDirectory,
    executorVersion, executorAppleTeamId: process.env.NESSIE_DESKTOP_SIGNING_TEAM_ID ?? '',
    nativeHelperPath: join(repository, 'native/target/release/nessie-executor-native') })
}
