// The native helper is a custody dependency of every macOS executor package.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'

export const prepareMacExecutorRuntime = async (repository, outputDirectory,
  executorVersion = process.env.NESSIE_EXECUTOR_VERSION ?? 'development', architecture) => {
  if (process.platform !== 'darwin') throw new Error('Prepare the macOS executor on macOS.')
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Build the macOS packaged runtime with Node 24.')
  const target = architecture === 'x64' ? 'x86_64-apple-darwin' : null
  if (architecture && architecture !== process.arch) throw new Error('Build with Node for the target Mac architecture.')
  await promisify(execFile)('cargo', ['build', '--release', ...(target ? ['--target', target] : []), '--manifest-path',
    join(repository, 'native/Cargo.toml')], { maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(target ? { MACOSX_DEPLOYMENT_TARGET: '12.0' } : {}), NESSIE_EXECUTOR_VERSION: executorVersion } })
  return prepareExecutorRuntime({ entryPoint: join(repository, 'src/index.ts'), outputDirectory,
    executorVersion, executorAppleTeamId: process.env.NESSIE_DESKTOP_SIGNING_TEAM_ID ?? '',
    nativeHelperPath: join(repository, 'native/target', target ?? '', 'release/nessie-executor-native') })
}
