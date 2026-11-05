// Local verification candidate only. Never publish this mock-provider package.
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { linuxPackage, REPOSITORY } from '../../packaging/cli/release-plan.mjs'
import { stageLinuxPayload } from '../../packaging/linux/payload.mjs'

if (process.platform !== 'linux') throw new Error('Use the isolated Linux verification host.')
if (process.env.NESSIE_RPM_SIGNING_KEY_FILE || process.env.NESSIE_REPOSITORY_SIGNING_FINGERPRINT) {
  throw new Error('Fixture candidates must not use release signing credentials.')
}
const output = join(REPOSITORY, 'dist/executor-cli')
const payload = join(output, 'linux-payload')
await mkdir(output, { recursive: true })
await stageLinuxPayload(payload, '0.0.0', {
  entryPoint: join(REPOSITORY, 'executor/test/fixtures/installed-personal-chatgpt-entry.ts'),
})
const configuration = { ...linuxPackage('0.0.0', payload, 'rpm'),
  description: 'ISOLATED TEST ONLY: Nessie executor with a simulated OpenAI provider. Never publish.',
}
const configPath = join(output, 'nfpm-installed-chatgpt-fixture.json')
const target = join(output, 'nessie-executor-chatgpt-fixture.rpm')
await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`)
await promisify(execFile)('nfpm', ['package', '--config', configPath, '--packager', 'rpm', '--target', target])
process.stdout.write(`${target}\n`)
