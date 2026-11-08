// The native helper is a custody dependency of every macOS executor package.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'

export const prepareMacExecutorRuntime = async (repository, outputDirectory,
  executorVersion = process.env.NESSIE_EXECUTOR_VERSION ?? 'development') => {
  if (process.platform !== 'darwin') throw new Error('Prepare the macOS executor on macOS.')
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Build the macOS packaged runtime with Node 24.')
  await promisify(execFile)('cargo', ['build', '--release', '--manifest-path',
    join(repository, 'native/Cargo.toml')], { maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NESSIE_EXECUTOR_VERSION: executorVersion } })
  return prepareExecutorRuntime({ entryPoint: join(repository, 'src/index.ts'), outputDirectory,
    executorVersion, executorAppleTeamId: process.env.NESSIE_DESKTOP_SIGNING_TEAM_ID ?? '',
    nativeHelperPath: join(repository, 'native/target/release/nessie-executor-native') })
}
