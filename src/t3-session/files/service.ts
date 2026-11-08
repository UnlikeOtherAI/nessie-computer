import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import type * as HttpServerRequest from 'effect/http/HttpServerRequest'
import { FileUpload, FileAssets, FileHttp, FileMedia, FilePorts,
  SourceContracts as S } from '@nessie/t3-session-source/engine'

/** These are inner runtime operations, not authority producers or registered transport slots.
 * FilePorts.FileAccess, AssetSigner and FilePathPolicy have no default layer. Only the
 * canonical signed runtime may supply them; an API request cannot construct a layer.
 * The broker must keep the Effect scope alive until a response stream ends/cancels.
 */
type UploadIssue = ReturnType<typeof FileUpload.issueAttachmentUploadUrl>
type UploadDelete = ReturnType<typeof FileUpload.deletePendingAttachment>
type UploadStore = ReturnType<typeof FileUpload.storeAttachmentUpload>
type AssetIssue = ReturnType<typeof FileAssets.issueAssetUrl>
type AssetResolve = ReturnType<typeof FileAssets.resolveAsset>
type FileResponse = ReturnType<typeof FileHttp.assetFileResponse>
type AssetResponse = Effect.Effect<HttpServerResponse.HttpServerResponse,
  Effect.Error<AssetResolve> | Effect.Error<FileResponse>
    | Effect.Error<ReturnType<FileSystem.FileSystem['realPath']>>,
  Effect.Services<AssetResolve> | Effect.Services<FileResponse> | FilePorts.FileAccess>

export const createSessionFileUpload = (input: unknown): Effect.Effect<Effect.Success<UploadIssue>,
  Schema.SchemaError | Effect.Error<UploadIssue>, Effect.Services<UploadIssue>> =>
  Schema.decodeUnknownEffect(S.AttachmentCreateUploadUrlInput)(input).pipe(
    Effect.flatMap(FileUpload.issueAttachmentUploadUrl),
  )

export const deleteSessionFileUpload = (input: unknown): Effect.Effect<Effect.Success<UploadDelete>,
  Schema.SchemaError | Effect.Error<UploadDelete>, Effect.Services<UploadDelete>> =>
  Schema.decodeUnknownEffect(S.AttachmentDeleteInput)(input).pipe(
    Effect.flatMap(({ attachmentId }) => FileUpload.deletePendingAttachment(attachmentId)),
  )

/** Original upload URL and pending id survive retries. Publication is exclusive and
 * identical bytes succeed again; partial/oversized/conflicting uploads cannot replace it.
 * The admission port records the byte digest separately from provider/command receipts.
 */
export const uploadSessionFile: (token: string, body: Uint8Array | HttpServerRequest.HttpServerRequest['stream']) =>
  Effect.Effect<Effect.Success<UploadStore>, Effect.Error<UploadStore>,
    Effect.Services<UploadStore> | Effect.Services<ReturnType<typeof FileUpload.validateAttachmentUploadToken>>> =
  Effect.fn('SessionFiles.upload')(function* (
  token: string, body: Uint8Array | HttpServerRequest.HttpServerRequest['stream'],
) {
  const claims = yield* FileUpload.validateAttachmentUploadToken(token)
  if (!claims) return yield* new FilePorts.FileBoundaryError({ code: 'expired' })
  return yield* FileUpload.storeAttachmentUpload(claims, body)
})

export const createSessionAsset: (input: unknown, admittedWorkspaceRoot?: string) =>
  Effect.Effect<Effect.Success<AssetIssue>, Schema.SchemaError | Effect.Error<AssetIssue>, Effect.Services<AssetIssue>> =
  Effect.fn('SessionFiles.createAsset')(function* (
  input: unknown, admittedWorkspaceRoot?: string,
) {
  const { resource } = yield* Schema.decodeUnknownEffect(S.AssetCreateUrlInput)(input)
  // The source-control media arm needs a credentialed provider owner; this path never fetches credentials.
  if (resource._tag === S.SOURCE_CONTROL_MEDIA_ASSET) {
    return yield* new FilePorts.FileBoundaryError({ code: 'unbound' })
  }
  return yield* FileAssets.issueAssetUrl({ resource,
    ...(admittedWorkspaceRoot === undefined ? {} : { workspaceRoot: admittedWorkspaceRoot }) })
})

/** Byte response only. UI and MCP receive the original finite URL descriptor;
 * bytes stream on its authenticated resource route, never inside a tool JSON result.
 */
type AssetInput = {
  readonly token: string
  readonly relativePath: string
  readonly range?: string
  readonly ifRange?: string
  readonly method?: 'GET' | 'HEAD'
}
export const readSessionAsset: (input: AssetInput) => AssetResponse =
  Effect.fn('SessionFiles.readAsset')(function* (input: AssetInput) {
  const access = yield* FilePorts.FileAccess
  const expiresAt = yield* access.assetToken(input.token, input.relativePath)
  const recheck = () => Effect.gen(function* () {
    yield* access.recheck()
    if (!Number.isFinite(expiresAt) || expiresAt <= (yield* Clock.currentTimeMillis)) {
      return yield* new FilePorts.FileBoundaryError({ code: 'expired' })
    }
  })
  return yield* readAssetBody(input, recheck).pipe(
    Effect.provideService(FilePorts.FileAccess, { ...access, recheck }),
  )
})

const readAssetBody: (input: AssetInput, recheck: () => Effect.Effect<void, FilePorts.FileBoundaryError>) => AssetResponse =
  Effect.fn('SessionFiles.readAssetBody')(function* (input: AssetInput,
    recheck: () => Effect.Effect<void, FilePorts.FileBoundaryError>) {
  const access = yield* FilePorts.FileAccess
  yield* recheck()
  if ((input.range?.length ?? 0) > 256 || (input.ifRange?.length ?? 0) > 512) {
    return yield* new FilePorts.FileBoundaryError({ code: 'denied' })
  }
  const asset = yield* FileAssets.resolveAsset(input.token, input.relativePath)
  if (!asset) return HttpServerResponse.empty({ status: 404 })
  if (asset.kind === 'source-control-media') {
    return yield* new FilePorts.FileBoundaryError({ code: 'unbound' })
  }
  if (asset.kind === 'bytes') {
    yield* recheck()
    const headers: Record<string, string> = { 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Type': asset.mimeType, 'Accept-Ranges': 'bytes' }
    const range = input.method !== 'HEAD' && input.range && input.ifRange === undefined
      ? FileHttp.assetByteRange(input.range, BigInt(asset.bytes.byteLength)) : null
    if (range?._tag === 'Unsatisfiable') {
      return HttpServerResponse.empty({ status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${asset.bytes.byteLength}` } })
    }
    const bytes = range?._tag === 'Range'
      ? asset.bytes.subarray(Number(range.offset), Number(range.offset + range.bytesToRead)) : asset.bytes
    if (range?._tag === 'Range') headers['Content-Range'] = range.contentRange
    headers['Content-Length'] = String(bytes.byteLength)
    const chunks = function* () {
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024)
    }
    const body = Stream.fromIterable(chunks()).pipe(Stream.mapEffect(chunk => recheck().pipe(Effect.as(chunk))))
    return input.method === 'HEAD' ? HttpServerResponse.empty({ headers })
      : HttpServerResponse.stream(body, { status: range?._tag === 'Range' ? 206 : 200, headers })
  }
  // A canonical path alone is insufficient: hold the actual original MediaFile descriptor
  // for all files, including attachments/HTML, until the consumer closes the scope.
  const fs = yield* FileSystem.FileSystem
  const canonical = yield* fs.realPath(asset.path)
  yield* access.path(canonical, 'read')
  const file = ('file' in asset ? asset.file : undefined) ?? (yield* FileMedia.openMediaFile(canonical))
  if (!file) return HttpServerResponse.empty({ status: 404 })
  yield* access.recheck()
  return yield* FileHttp.assetFileResponse({ ...asset, path: canonical, file },
    input.range, input.ifRange, input.method)
})

/** Bound a transport's original byte stream before it reaches the upload sink. */
export const sessionUploadStream = (body: AsyncIterable<Uint8Array>) =>
  Stream.fromAsyncIterable(body, () => new FilePorts.FileBoundaryError({ code: 'denied' }))
