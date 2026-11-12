import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const gpgPath = (path) => process.platform === 'win32'
  ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`)
  : path
const fingerprint = process.env.NESSIE_REPOSITORY_SIGNING_FINGERPRINT
const privateKey = process.env.NESSIE_RPM_SIGNING_KEY_FILE
if (!fingerprint || !/^[A-F0-9]{40}$/.test(fingerprint) || !privateKey) {
  throw new Error('Set NESSIE_REPOSITORY_SIGNING_FINGERPRINT and NESSIE_RPM_SIGNING_KEY_FILE.')
}
const gpg = process.env.NESSIE_GPG_BINARY ?? 'gpg'
const gpgconf = process.env.NESSIE_GPGCONF_BINARY
  ?? (process.platform === 'win32' && process.env.NESSIE_GPG_BINARY ? join(dirname(gpg), 'gpgconf.exe') : 'gpgconf')
const directory = await mkdtemp(join(tmpdir(), 'nessie-signing-proof-'))
try {
  // Restore from the export for every check; a cached agent cannot hide a lost backup.
  await run(gpg, ['--homedir', gpgPath(directory), '--batch', '--import', gpgPath(privateKey)], { timeout: 30_000 })
  const challenge = join(directory, 'challenge')
  const signature = `${challenge}.asc`
  await writeFile(challenge, `Nessie Computer publisher recovery check\n${fingerprint}\n`, { mode: 0o600 })
  await run(gpg, ['--homedir', gpgPath(directory), '--batch', '--pinentry-mode', 'error',
    '--local-user', fingerprint, '--armor', '--detach-sign', '--output', gpgPath(signature), gpgPath(challenge)], { timeout: 30_000 })
  await run(process.env.NESSIE_GPGV_BINARY ?? 'gpgv', ['--homedir', gpgPath(directory), '--keyring',
    gpgPath(fileURLToPath(new URL('keys/unlikeotherai-executor.gpg', import.meta.url))), gpgPath(signature), gpgPath(challenge)], { timeout: 30_000 })
  process.stdout.write(`Linux publisher restore, signing and pinned-key verification passed: ${fingerprint}\n`)
} finally {
  // GnuPG's Windows agent can keep an SSH process tree open. This keyring is ours alone.
  try {
    await run(gpgconf, ['--homedir', gpgPath(directory), '--kill', 'gpg-agent'], { timeout: 10_000 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
