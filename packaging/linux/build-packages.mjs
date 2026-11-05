import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { linuxPackage, releaseVersion, REPOSITORY } from '../cli/release-plan.mjs'
import { stageLinuxPayload } from './payload.mjs'

const run = promisify(execFile)

export const buildLinuxPackages = async (formats = ['deb', 'rpm']) => {
  const version = releaseVersion()
  const output = join(REPOSITORY, 'dist/executor-cli')
  const payload = join(output, 'linux-payload')
  await mkdir(output, { recursive: true })
  await stageLinuxPayload(payload, version)
  for (const format of formats) {
    const extension = format === 'deb' ? 'amd64.deb' : 'x86_64.rpm'
    const file = `nessie-executor_${version}_${extension}`
    const configuration = join(output, `nfpm-${format}.json`)
    await writeFile(configuration, JSON.stringify(linuxPackage(
      version, payload, format, process.env.NESSIE_RPM_SIGNING_KEY_FILE,
    ), null, 2))
    await run('nfpm', ['package', '--config', configuration, '--packager', format, '--target', join(output, file)])
    const digest = createHash('sha256').update(await readFile(join(output, file))).digest('hex')
    await writeFile(join(output, `${file}.sha256`), `${digest}  ${file}\n`)
    process.stdout.write(`${join(output, file)}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildLinuxPackages()
}
