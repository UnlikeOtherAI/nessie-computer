import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applySessionEngineBoundaryPatches } from '../../../packaging/session-engine/patches.mjs'

const commit = '25bf84ab07f53f141c20239c63e383823a9d5ea0'
const repository = process.argv[2]
if (!repository) throw new Error('Pass the read-only pinned T3 source repository.')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = args => execFileSync('git', ['--no-replace-objects', '-C', repository, ...args],
  { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
const files = git(['ls-tree', '-r', '--name-only', commit]).toString().trim().split('\n')
const cache = new Map()
const read = file => {
  if (!cache.has(file)) cache.set(file, git(['show', `${commit}:${file}`]))
  return cache.get(file)
}
const original = { files, identity: { commit }, read }
const extracted = applySessionEngineBoundaryPatches(original,
  readFileSync(new URL('../extraction/boundary-patches.json', import.meta.url)))
const modified = new Map()
const patches = []
const replace = (file, from, to) => {
  const before = modified.get(file) ?? extracted.read(file)
  if (before.toString().split(from).length !== 2) throw new Error(`Nonunique patch: ${file}: ${from}`)
  const after = Buffer.from(before.toString().replace(from, to))
  patches.push({ file, beforeSha256: hash(before), afterSha256: hash(after), from, to })
  modified.set(file, after)
}
const select = (file, startMarker, endMarker) => {
  const source = read(file)
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < start) throw new Error(`Missing slice: ${file}`)
  return { sourceFile: file, start, end, sha256: hash(source.subarray(start, end)) }
}
const create = (file, parts) => {
  const bytes = Buffer.concat(parts.map(part => part.text !== undefined
    ? Buffer.from(part.text) : read(part.sourceFile).subarray(part.start, part.end)))
  patches.push({ file, beforeSha256: null, afterSha256: hash(bytes), create: parts })
}
const server = 'apps/server/src/'
create(`${server}assets/FileCodecs.session.ts`, [
  { text: 'import * as Base64Url from "effect/encoding/Base64Url";\nimport * as Result from "effect/Result";\n' },
  select(`${server}auth/utils.ts`, 'export function base64UrlEncode(', '\nexport function ',),
  select(`${server}auth/utils.ts`, 'export function base64UrlDecodeUtf8(', '\nexport function '),
])
create(`${server}assets/FilePorts.session.ts`, [{ text: readFileSync(
  new URL('./ports.ts.txt', import.meta.url), 'utf8') }])
create(`${server}assets/FileHttp.session.ts`, [
  { text: 'import * as Mime from "effect/http/Mime";\nimport * as Effect from "effect/Effect";\n'
    + 'import * as Stream from "effect/Stream";\n'
    + 'import * as FileSystem from "effect/FileSystem";\nimport * as Option from "effect/Option";\n'
    + 'import { pipe } from "effect/Function";\nimport { HttpServerResponse } from "effect/http";\n'
    + 'import { injectMcpAppCookieBootstrap, injectMcpAppThemeBootstrap } from "@t3tools/shared/mcpApp";\n'
    + 'import { readMcpAppHtml } from "./AssetAccess.ts";\n'
    + 'import { statMediaFile, streamMediaFile, type OpenMediaFile } from "./MediaFile.ts";\n'
    + 'import { FileAccess, FileBoundaryError } from "./FilePorts.session.ts";\n' },
  select(`${server}http.ts`, 'const SVG_CONTENT_SECURITY_POLICY', 'export const layerHttpCompression'),
])
// Guard the extracted HTTP function without changing the original response/header/range algorithms.
const httpPatch = patches.at(-1)
const httpBytes = Buffer.concat(httpPatch.create.map(part => part.text !== undefined
  ? Buffer.from(part.text) : read(part.sourceFile).subarray(part.start, part.end)))
modified.set(httpPatch.file, httpBytes)
replace(httpPatch.file, 'function assetByteRange(', 'export function assetByteRange(')
replace(httpPatch.file, '  const headers = assetResponseHeaders(asset.path, asset);',
  '  const access = yield* FileAccess;\n  yield* access.recheck();\n  yield* access.path(asset.path, "read");\n'
  + '  if (!asset.file) return yield* new FileBoundaryError({ code: "denied" });\n'
  + '  const headers: Record<string, string> = { ...assetResponseHeaders(asset.path, asset), "Cache-Control": "private, no-store" };')
replace(httpPatch.file, 'streamMediaFile(mediaFile, offset, size)',
  'streamMediaFile(mediaFile, offset, size, access.recheck)')
replace(httpPatch.file, 'HttpServerResponse.uint8Array(body, { headers })',
  'HttpServerResponse.stream(Stream.fromIterable((function* () {\n'
  + '          for (let offset = 0; offset < body.length; offset += 64 * 1024) {\n'
  + '            yield body.subarray(offset, offset + 64 * 1024);\n          }\n'
  + '        })()).pipe(Stream.mapEffect(chunk => access.recheck().pipe(Effect.as(chunk)))), { headers })')
replace(httpPatch.file, '  return yield* HttpServerResponse.file(asset.path, { status, offset, bytesToRead, headers });',
  '  return yield* new FileBoundaryError({ code: "denied" });')
for (const name of ['AttachmentUpload', 'AssetAccess']) {
  const file = `${server}assets/${name}.ts`
  replace(file, 'import * as ServerConfig from "../config.ts";',
    'import * as ServerConfig from "../config.session-port.ts";')
  replace(file, 'from "../auth/utils.ts";', 'from "./FileCodecs.session.ts";')
  replace(file, 'import * as AssetSigner from "./AssetSigner.ts";',
    'import * as AssetSigner from "./FilePorts.session.ts";')
}
replace(`${server}assets/AssetAccess.ts`, 'from "../auth/serverInternalPaths.ts";',
  'from "./FilePorts.session.ts";')
replace(`${server}assets/AssetAccess.ts`, 'import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";',
  'import * as Orchestrator from "../orchestration-v2/Orchestrator.session-api.ts";')
replace(`${server}assets/AssetAccess.ts`, 'import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";',
  'import * as NativeAppIconResolver from "./FilePorts.session.ts";')
replace(`${server}assets/AssetAccess.ts`, 'import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";',
  'import { builtInSourceControlDefinitions as sourceControlDefinitions } from "@t3tools/source-control-definitions/registry";')
// Issuance does not authorize arbitrary local files. Exact local scope comes from the admitted resource owner.
replace(`${server}assets/AssetAccess.ts`, 'const [encodedPayload, signature] = token.split(".");\n  if (!encodedPayload || !signature) return null;',
  'const [encodedPayload, signature, extra] = token.split(".");\n  if (!encodedPayload || !signature || extra) return null;')
// Keep parsing/extraction behind a mandatory service; never import the unmanaged parser launcher.
create(`${server}provider/DocumentText.files-port.ts`, [
  { text: 'import * as Context from "effect/Context";\nimport * as Effect from "effect/Effect";\n' },
  select(`${server}provider/DocumentText.ts`, 'export class DocumentText extends', 'const make ='),
])
const documentTag = select(`${server}provider/DocumentText.ts`, 'export class DocumentText extends', 'const make =')
replace(`${server}provider/DocumentText.ts`, read(documentTag.sourceFile)
  .subarray(documentTag.start, documentTag.end).toString(),
  'import { DocumentText } from "./DocumentText.files-port.ts";\n'
  + 'export { DocumentText } from "./DocumentText.files-port.ts";\n\n')
replace(`${server}provider/DocumentText.ts`, 'import * as Context from "effect/Context";\n', '')
replace(`${server}provider/userInputAttachments.ts`, 'from "./DocumentText.ts";',
  'from "./DocumentText.files-port.ts";')
for (const file of ['assets/AttachmentUpload.ts', 'orchestration-v2/AttachmentClaims.ts']) {
  replace(`${server}${file}`, 'from "../provider/DocumentText.ts";', 'from "../provider/DocumentText.files-port.ts";')
}
const upload = `${server}assets/AttachmentUpload.ts`
const assets = `${server}assets/AssetAccess.ts`
const claims = `${server}orchestration-v2/AttachmentClaims.ts`
for (const file of [upload, assets, claims]) {
  replace(file, 'import * as Effect from "effect/Effect";',
    'import * as Effect from "effect/Effect";\nimport { FileAccess } from "../assets/FilePorts.session.ts";')
}
replace(upload, '  const config = yield* ServerConfig.ServerConfig;\n  const nowMs',
  '  const access = yield* FileAccess;\n  yield* access.upload(input);\n'
  + '  yield* access.recheck();\n  const config = yield* ServerConfig.ServerConfig;\n  const nowMs')
// Sweeping is runtime-owned maintenance: issuing one person's URL cannot delete another person's uploads.
const uploadSource = modified.get(upload).toString()
replace(upload, uploadSource.slice(uploadSource.indexOf('  const previousSweep'),
  uploadSource.indexOf('\n  const attachmentType')),
  '')
replace(upload, '  sweepStalePendingAttachments,\n', '')
replace(upload, 'const PENDING_ATTACHMENT_SWEEP_INTERVAL_MS = 15 * 60_000;\nconst lastPendingSweepByDirectory = new Map<string, number>();\n', '')
replace(upload, '  return {\n    attachmentId,\n    relativeUrl:',
  '  const result = {\n    attachmentId,\n    relativeUrl:')
replace(upload, '    expiresAt,\n  };\n});',
  '    expiresAt,\n  };\n  yield* access.recheck();\n  yield* access.bindUpload(input, result);\n  return result;\n});')
replace(upload, '  if (body instanceof Uint8Array && body.byteLength !== claims.sizeBytes)',
  '  const access = yield* FileAccess;\n  yield* access.pending(claims.attachmentId, "upload");\n'
  + '  yield* access.recheck();\n  if (claims.expiresAt <= (yield* Clock.currentTimeMillis)) {\n'
  + '    return { ok: false, status: 410, detail: "Upload expired." } satisfies StoreAttachmentUploadResult;\n  }\n'
  + '  const expectedDigest = yield* access.uploadDigest(claims.attachmentId);\n'
  + '  const contentHash = NodeCrypto.createHash("sha256");\n'
  + '  if (body instanceof Uint8Array && body.byteLength !== claims.sizeBytes)')
replace(upload, '    yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });',
  '    yield* access.path(finalPath, "write");\n    yield* access.path(partPath, "write");\n'
  + '    yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });')
replace(upload, '        Stream.takeWhile((chunk) => {',
  '        Stream.mapEffect((chunk) => Effect.gen(function* () {\n'
  + '          yield* access.recheck();\n          if (claims.expiresAt <= (yield* Clock.currentTimeMillis)) {\n'
  + '            return yield* Effect.fail(new AssetSigner.FileBoundaryError({ code: "expired" }));\n          }\n'
  + '          contentHash.update(chunk);\n          return chunk;\n        })),\n'
  + '        Stream.takeWhile((chunk) => {')
replace(upload, '    // Publishing without replacement keeps an upload and its cached text immutable.',
  '    const sha256 = contentHash.digest("hex");\n'
  + '    if (expectedDigest !== undefined && sha256 !== expectedDigest) {\n'
  + '      return { ok: false, status: 409, detail: "Upload digest does not match." };\n    }\n'
  + '    yield* access.recheck();\n    yield* access.path(finalPath, "write");\n'
  + '    if (claims.expiresAt <= (yield* Clock.currentTimeMillis)) {\n'
  + '      return { ok: false, status: 410, detail: "Upload expired." };\n    }\n'
  + '    // Publishing without replacement keeps an upload and its cached text immutable.')
replace(upload, '    const documents = yield* DocumentText.DocumentText;',
  '    yield* access.recheck();\n    yield* access.uploaded(claims.attachmentId, receivedBytes, sha256);\n'
  + '    const documents = yield* DocumentText.DocumentText;')
// The partial and final paths share one protected directory. Refuse filesystems
// without atomic link publication; an exclusive copy can expose a partial final file.
const copyFallback = modified.get(upload).toString()
const copyStart = copyFallback.indexOf('        return Effect.tryPromise({')
const copyEnd = copyFallback.indexOf('\n      }),\n    );', copyStart)
replace(upload, copyFallback.slice(copyStart, copyEnd), '        return Effect.fail(error);')
replace(upload, 'import * as NodeFSP from "node:fs/promises";\n', '')
replace(upload, 'import * as PlatformError from "effect/PlatformError";\n', '')
replace(upload, '  if (parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT)',
  '  const access = yield* FileAccess;\n  yield* access.pending(attachmentId, "delete");\n'
  + '  yield* access.recheck();\n  if (parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT)')
replace(upload, '  const fileSystem = yield* FileSystem.FileSystem;\n  yield* fileSystem.remove(attachmentPath',
  '  const fileSystem = yield* FileSystem.FileSystem;\n  yield* access.path(attachmentPath, "write");\n'
  + '  yield* fileSystem.remove(attachmentPath')
replace(claims, '    yield* validateAttachmentLimits(input.attachments);',
  '    const access = yield* FileAccess;\n    yield* access.recheck();\n'
  + '    yield* access.claim(input.threadId, input.attachments);\n    yield* validateAttachmentLimits(input.attachments);')
replace(claims, '          const info = yield* fileSystem.stat(claim.currentPath)',
  '          yield* access.recheck();\n          yield* access.path(claim.currentPath, "read");\n'
  + '          yield* access.path(claim.finalPath, "write");\n'
  + '          const info = yield* fileSystem.stat(claim.currentPath)')
replace(claims, '    ).pipe(Effect.onError(() => releaseClaimedAttachments(claimedPaths)));',
  '    ).pipe(\n      Effect.tap((attachments) => Effect.gen(function* () {\n'
  + '        yield* access.recheck();\n        yield* access.bindClaim(input.threadId, input.attachments, attachments);\n'
  + '      })),\n      Effect.onError(() => releaseClaimedAttachments(claimedPaths)),\n    );')
replace(assets, '  const fileSystem = yield* FileSystem.FileSystem;\n  const path = yield* Path.Path;\n  const workspacePaths',
  '  const access = yield* FileAccess;\n  yield* access.recheck();\n  yield* access.asset(input.resource);\n'
  + '  const fileSystem = yield* FileSystem.FileSystem;\n  const path = yield* Path.Path;\n  const workspacePaths')
replace(assets, '  return {\n    relativeUrl: `${ASSET_ROUTE_PREFIX}',
  '  const result = {\n    relativeUrl: `${ASSET_ROUTE_PREFIX}')
replace(assets, '    ...(fileRevision !== undefined ? { fileRevision } : {}),\n  };\n});',
  '    ...(fileRevision !== undefined ? { fileRevision } : {}),\n  };\n'
  + '  yield* access.recheck();\n  yield* access.bindAsset(input.resource, result);\n  return result;\n});')
replace(assets, '  const [encodedPayload, signature, extra] = token.split(".");',
  '  const access = yield* FileAccess;\n  yield* access.recheck();\n'
  + '  yield* access.assetToken(token, relativePath);\n  const [encodedPayload, signature, extra] = token.split(".");')
// HTML parsing consumes the same held-descriptor primitive; no path reopen after admission.
replace(assets, 'readMediaFileHeader, type OpenMediaFile', 'readMediaFileHeader, streamMediaFile, type OpenMediaFile')
replace(assets, '  const chunks = yield* Stream.runCollect(fileSystem.stream(filePath, { bytesToRead: limit + 1 }));',
  '  const canonical = yield* fileSystem.realPath(filePath);\n'
  + '  const file = yield* openMediaFile(canonical);\n  if (!file) return null;\n'
  + '  const count = file.info.size < BigInt(limit + 1) ? file.info.size : BigInt(limit + 1);\n'
  + '  if (count === 0n) return new Uint8Array();\n'
  + '  const access = yield* FileAccess;\n'
  + '  const stream = streamMediaFile(file, 0n, count, access.recheck);\n  if (!stream) return null;\n'
  + '  const chunks = yield* Stream.runCollect(stream);')
const intake = `${server}orchestration-v2/ThreadMessageIntake.ts`
replace(intake, 'import * as Effect from "effect/Effect";',
  'import * as Effect from "effect/Effect";\nimport { FileAccess } from "../assets/FilePorts.session.ts";')
replace(intake, '  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);',
  '  const initialAttachments = input.initialMessage?.attachments ?? [];\n'
  + '  if (initialAttachments.length > 0) {\n'
  + '    if (!input.threadId) return yield* new AttachmentClaims.AttachmentClaimError({\n'
  + '      message: "Attachment launch requires an admitted original thread id.",\n    });\n'
  + '    const access = yield* FileAccess;\n    yield* access.recheck();\n'
  + '    yield* access.claim(input.threadId, initialAttachments);\n  }\n'
  + '  yield* AttachmentClaims.validateAttachmentLimits(initialAttachments);')
const media = `${server}assets/MediaFile.ts`
replace(media, 'export const streamMediaFile = (file: OpenMediaFile, offset: bigint, bytesToRead: bigint) => {',
  'export const streamMediaFile = (file: OpenMediaFile, offset: bigint, bytesToRead: bigint,\n'
  + '  recheck: () => Effect.Effect<void, FileBoundaryError>) => {')
replace(media, 'import * as Schema from "effect/Schema";',
  'import * as Schema from "effect/Schema";\nimport * as Stream from "effect/Stream";\n'
  + 'import { FileAccess, FileBoundaryError } from "./FilePorts.session.ts";')
replace(media, '  return yield* Effect.acquireRelease(',
  '  const access = yield* FileAccess;\n  yield* access.recheck();\n  yield* access.path(filePath, "read");\n'
  + '  return yield* Effect.acquireRelease(')
replace(media, '      }),\n  });\n};',
  '      }),\n  }).pipe(Stream.mapEffect((chunk) => Effect.gen(function* () {\n'
  + '    yield* recheck();\n'
  + '    const now = yield* Effect.tryPromise({ try: () => file.handle.stat({ bigint: true }),\n'
  + '      catch: () => new FileBoundaryError({ code: "changed" }) });\n'
  + '    if (now.size !== file.info.size || now.mtimeNs !== file.info.mtimeNs || now.ctimeNs !== file.info.ctimeNs) {\n'
  + '      return yield* new FileBoundaryError({ code: "changed" });\n    }\n    return chunk;\n  })));\n};')
// Named error declarations preserve the checked cross-module Effect error types.
for (const name of ['MediaFileOpenError', 'MediaFileReadError', 'MediaFileStatError']) {
  replace(media, `class ${name} extends`, `export class ${name} extends`)
}
writeFileSync(fileURLToPath(new URL('./boundary-patches.json', import.meta.url)),
  `${JSON.stringify({ format: 1, sourceCommit: commit, patches }, null, 2)}\n`)
