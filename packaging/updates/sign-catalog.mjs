// Machine-only release interface. This creates metadata; it never publishes
// files or changes an installed computer. The release environment supplies
// the Ed25519 PKCS#8 key through EXECUTOR_UPDATE_SIGNING_KEY, never an argument.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyUpdateManifest } from '../../src/updates/manifest.ts'
import { EXECUTOR_UPDATE_PUBLIC_KEY } from '../../src/updates/trusted-key.ts'

export function signCatalog(manifest, privateKey, publicKey = EXECUTOR_UPDATE_PUBLIC_KEY, now = Date.now()) {
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519'
    || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(
      createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))) {
    throw new Error('The release key does not match the installed updater trust root.')
  }
  const payload = Buffer.from(JSON.stringify(manifest))
  const envelope = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') })
  verifyUpdateManifest(envelope, publicKey, { now, channel: manifest.channel, highestSequence: 0 })
  return `${envelope}\n`
}

async function main() {
  const [input, output] = process.argv.slice(2)
  if (!input || !output || process.argv.length !== 4) {
    throw new Error('Usage: pnpm exec tsx packaging/updates/sign-catalog.mjs manifest.json catalog.json')
  }
  const privateKey = process.env.EXECUTOR_UPDATE_SIGNING_KEY
  if (!privateKey) throw new Error('The protected executor-updates environment must supply EXECUTOR_UPDATE_SIGNING_KEY.')
  const manifest = JSON.parse(await readFile(resolve(input), 'utf8'))
  // Each target's digest/size is independently checked by the candidate verifier
  // before this command. Signing cannot make an unverified candidate releasable.
  const envelope = signCatalog(manifest, privateKey)
  await writeFile(resolve(output), envelope, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`Created signed ${manifest.channel} metadata for ${manifest.version}; SHA-256 ${createHash('sha256').update(envelope).digest('hex')}.\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    // Crypto-library diagnostics must never serialize a supplied private key.
    process.stderr.write(`${error instanceof Error && !error.message.includes('-----BEGIN')
      ? error.message : 'Update metadata signing failed.'}\n`)
    process.exitCode = 1
  })
}
