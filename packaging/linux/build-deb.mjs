// Compatibility entry point for the existing desktop verification workflow.
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildLinuxPackages } from './build-packages.mjs'
import { REPOSITORY } from '../cli/release-plan.mjs'
process.env.NESSIE_EXECUTOR_VERSION ??= '0.0.0'
await buildLinuxPackages(['deb'])
const file = `nessie-executor_${process.env.NESSIE_EXECUTOR_VERSION}_amd64.deb`
await copyFile(join(REPOSITORY, 'dist/executor-cli', file), join(REPOSITORY, 'dist', file))
