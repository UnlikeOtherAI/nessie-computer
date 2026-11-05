// Seal final, already-signed launch consumers into the protected runtime manifest.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const sealWindowsLaunchConsumers = async (directory) => {
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.format !== 1 || manifest.managedRuntimeGuardVersion !== 2
    || manifest.nativeHelper !== 'nessie-executor-native.exe') {
    throw new Error('Windows launch consumers require the managed native runtime manifest.')
  }
  const digest = async (name) => createHash('sha256').update(await readFile(join(directory, name))).digest('hex')
  const windowsLaunchConsumers = { protocolVersion: 2,
    serviceSha256: await digest('nessie-executor-service.exe'),
    traySha256: await digest('nessie-executor-tray.exe') }
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, windowsLaunchConsumers }, null, 2)}\n`)
  return windowsLaunchConsumers
}
