import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdir, realpath, lstat } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Config, FileDocuments, FilePorts, FileWorkspace } from '@nessie/t3-session-source/engine'

/** Synthetic algorithm fixture only. These callbacks do NOT qualify original-human
 * continuity, physical resource admission, signed transport or production authority.
 */
export async function fixture() {
  const directory = resolve('.artifacts/t14-files', randomUUID())
  await mkdir(directory, { recursive: true })
  const root = await realpath(directory)
  const pending = new Set()
  const accepted = new Set()
  const receipts = new Map()
  const urls = new Map()
  const state = { revoked: false, expectedDigest: undefined, extracts: 0 }
  const check = () => state.revoked
    ? Effect.fail(new FilePorts.FileBoundaryError({ code: 'revoked' })) : Effect.void
  const denied = () => Effect.fail(new FilePorts.FileBoundaryError({ code: 'denied' }))
  const access = {
    recheck: check,
    upload: check,
    bindUpload: (_input, result) => Effect.sync(() => pending.add(result.attachmentId)),
    pending: id => pending.has(id) ? check() : denied(),
    uploadDigest: () => Effect.succeed(state.expectedDigest),
    uploaded: (id, sizeBytes, sha256) => Effect.sync(() => receipts.set(id, { sizeBytes, sha256 })),
    claim: (threadId, attachments) => threadId === 'thread:雪/1'
      && attachments.every(file => pending.has(file.id) || accepted.has(file.id)) ? check() : denied(),
    bindClaim: (_thread, _before, after) => Effect.sync(() => after.forEach(file => accepted.add(file.id))),
    asset: resource => resource._tag === 'attachment' && accepted.has(resource.attachmentId) ? check() : denied(),
    bindAsset: (_resource, result) => Effect.sync(() => urls.set(result.relativeUrl, result.expiresAt)),
    assetToken: (token, suffix) => urls.has(`/api/assets/${token}/${suffix}`)
      ? check().pipe(Effect.as(urls.get(`/api/assets/${token}/${suffix}`))) : denied(),
    path: file => Effect.tryPromise({ try: async () => {
      const local = relative(root, file)
      if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('outside fixture')
      const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (info?.isSymbolicLink()) throw new Error('symlink')
    }, catch: () => new FilePorts.FileBoundaryError({ code: 'denied' }) }),
  }
  const sign = value => createHmac('sha256', 'synthetic-test-key-only').update(value).digest('base64url')
  const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer,
    Layer.succeed(Config.ServerConfig, { attachmentsDir: root }),
    Layer.succeed(FileDocuments.DocumentText, { ensure: () => Effect.sync(() => { state.extracts++; return undefined }) }),
    Layer.succeed(FilePorts.FileAccess, access),
    Layer.succeed(FilePorts.FilePathPolicy, { isInternal: () => Effect.succeed(false) }),
    Layer.succeed(FilePorts.AssetSigner, {
      sign: value => Effect.succeed(sign(value)), verify: (value, signature) => Effect.succeed(sign(value) === signature),
    }),
    Layer.succeed(FileWorkspace.WorkspacePaths, {
      normalizeWorkspaceRoot: () => denied(), resolveRelativePathWithinRoot: () => denied(),
    }))
  return { root, state, pending, accepted, receipts, urls, layer,
    run: effect => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer)))),
    digest: bytes => createHash('sha256').update(bytes).digest('hex') }
}
