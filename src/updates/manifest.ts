import { createHash, createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'

const Version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
const Asset = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().positive().max(2_147_483_648),
}).strict()
export const UpdateTargetSchema = z.enum(['windows-x64-msi', 'darwin-arm64-pkg', 'linux-x64-deb', 'linux-x64-rpm'])
export type UpdateTarget = z.infer<typeof UpdateTargetSchema>
const Manifest = z.object({
  format: z.literal(1),
  channel: z.enum(['stable', 'preview']),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  version: Version,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  publishedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  minimumUpdaterProtocol: z.number().int().positive(),
  targets: z.record(UpdateTargetSchema, z.array(Asset).min(1).max(3)),
}).strict()
const Envelope = z.object({
  payload: z.string().min(1).max(180_000),
  signature: z.string().min(1).max(128),
}).strict()
export type UpdateManifest = z.infer<typeof Manifest>
export type UpdateAsset = z.infer<typeof Asset>
export type VerifiedUpdate = { manifest: UpdateManifest; envelope: string; digest: string }

export class UpdateError extends Error {
  constructor(readonly code: string) { super(code) }
}

export const compareUpdateVersions = (left: string, right: string): number => {
  const a = Version.parse(left).split('.').map(BigInt)
  const b = Version.parse(right).split('.').map(BigInt)
  for (let index = 0; index < 3; index++) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]! ? 1 : -1
  }
  return 0
}

const canonicalBase64 = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new UpdateError('update.invalid_signature')
  return bytes
}

/** Verify the exact signed bytes before interpreting a release or its URLs. */
export const verifyUpdateManifest = (
  envelope: string,
  publicKey: string,
  options: { now: number; channel: 'stable' | 'preview'; highestSequence: number; previousDigest?: string },
): VerifiedUpdate => {
  try {
    if (Buffer.byteLength(envelope) > 200_000) throw new UpdateError('update.invalid_manifest')
    const parsed = Envelope.parse(JSON.parse(envelope))
    const payload = canonicalBase64(parsed.payload)
    const signature = canonicalBase64(parsed.signature)
    const key = createPublicKey(publicKey)
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, payload, key, signature)) {
      throw new UpdateError('update.invalid_signature')
    }
    const manifest = Manifest.parse(JSON.parse(payload.toString('utf8')))
    const digest = createHash('sha256').update(payload).digest('hex')
    if (manifest.channel !== options.channel) throw new UpdateError('update.wrong_channel')
    if (manifest.minimumUpdaterProtocol > 1) throw new UpdateError('update.updater_required')
    const published = Date.parse(manifest.publishedAt), expires = Date.parse(manifest.expiresAt)
    if (published > options.now + 300_000 || expires <= options.now || expires <= published) {
      throw new UpdateError('update.expired_manifest')
    }
    if (manifest.sequence < options.highestSequence || manifest.sequence === options.highestSequence
      && digest !== options.previousDigest) throw new UpdateError('update.replayed_manifest')
    const release = `https://github.com/UnlikeOtherAI/nessie-executor/releases/download/executor-v${manifest.version}/`
    for (const assets of Object.values(manifest.targets)) {
      const names = new Set<string>()
      for (const asset of assets ?? []) {
        if (asset.url !== `${release}${asset.name}` || names.has(asset.name)) {
          throw new UpdateError('update.invalid_asset')
        }
        names.add(asset.name)
      }
    }
    return { manifest, envelope, digest }
  } catch (error) {
    if (error instanceof UpdateError) throw error
    throw new UpdateError('update.invalid_manifest')
  }
}
