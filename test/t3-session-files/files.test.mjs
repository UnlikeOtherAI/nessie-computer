import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import * as Schema from 'effect/Schema'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { FileUpload, FileStore, FileMedia, FileHttp, FilePorts, AttachmentClaims, ThreadMessageIntake, Threads, Launch,
  SourceContracts as S } from '@nessie/t3-session-source/engine'
import { createSessionFileUpload, uploadSessionFile, createSessionAsset, readSessionAsset }
  from '../../dist/t3-session/files/service.js'
import { fixture } from './fixture.mjs'

const input = { type: 'file', name: 'résumé 雪.txt', mimeType: 'text/plain', sizeBytes: 6 }
const tokenOf = issued => issued.relativeUrl.split('/').at(-1)
const upload = async f => {
  const issued = await f.run(createSessionFileUpload(input))
  const token = tokenOf(issued)
  const result = await f.run(uploadSessionFile(token, Buffer.from('abcdef')))
  assert.deepEqual(result, { ok: true })
  return { issued, token }
}

test('original upload bytes/metadata, digest and identical/conflicting retry', async () => {
  const f = await fixture()
  const { issued, token } = await upload(f)
  assert.deepEqual(f.receipts.get(issued.attachmentId), { sizeBytes: 6, sha256: f.digest('abcdef') })
  const file = FileStore.resolveAttachmentPathById({ attachmentsDir: f.root, attachmentId: issued.attachmentId })
  assert.equal(await readFile(file, 'utf8'), 'abcdef')
  assert.deepEqual(await f.run(uploadSessionFile(token, Buffer.from('abcdef'))), { ok: true })
  assert.equal((await f.run(uploadSessionFile(token, Buffer.from('ABCDEF')))).status, 409)
  assert.equal(await readFile(file, 'utf8'), 'abcdef')
})

test('partial, oversized and digest-mismatched bodies never publish and remove their parts', async () => {
  const f = await fixture()
  const issued = await f.run(createSessionFileUpload(input))
  const token = tokenOf(issued)
  for (const body of [Buffer.from('short'), Buffer.from('too-long')]) {
    const result = await f.run(uploadSessionFile(token, Stream.make(body)))
    assert.equal(result.ok, false)
    assert.deepEqual(await readdir(f.root), [])
  }
  f.state.expectedDigest = f.digest('ABCDEF')
  assert.equal((await f.run(uploadSessionFile(token, Buffer.from('abcdef')))).status, 409)
  assert.deepEqual(await readdir(f.root), [])
  f.state.expectedDigest = f.digest('abcdef')
  assert.deepEqual(await f.run(uploadSessionFile(token, Buffer.from('abcdef'))), { ok: true })
})

test('expired, foreign and revoked uploads are refused before publication', async () => {
  const f = await fixture()
  const issued = await f.run(createSessionFileUpload(input))
  const token = tokenOf(issued)
  const claims = await f.run(FileUpload.validateAttachmentUploadToken(token))
  assert.equal((await f.run(FileUpload.storeAttachmentUpload({ ...claims, expiresAt: 0 }, Buffer.from('abcdef')))).status, 410)
  f.pending.clear()
  await assert.rejects(f.run(uploadSessionFile(token, Buffer.from('abcdef'))))
  f.pending.add(issued.attachmentId)
  const stream = Stream.fromAsyncIterable((async function* () {
    yield Buffer.from('abc')
    f.state.revoked = true
    yield Buffer.from('def')
  })(), error => error)
  assert.equal((await f.run(uploadSessionFile(token, stream))).ok, false)
  assert.deepEqual(await readdir(f.root), [])
})

test('original claim keeps pending retry source; foreign preclaimed id fails before early return', async () => {
  const f = await fixture()
  const { issued } = await upload(f)
  const attachment = { ...input, id: S.ChatAttachmentId.make(issued.attachmentId) }
  const result = await f.run(AttachmentClaims.claimPendingAttachments({ threadId: 'thread:雪/1', attachments: [attachment] }))
  assert.equal(result.attachments[0].name, input.name)
  assert.notEqual(result.attachments[0].id, issued.attachmentId)
  assert.equal(await readFile(result.claimedPaths[0], 'utf8'), 'abcdef')
  assert.ok(FileStore.resolveAttachmentPathById({ attachmentsDir: f.root, attachmentId: issued.attachmentId }))
  await assert.rejects(f.run(AttachmentClaims.claimPendingAttachments({
    threadId: 'foreign-thread', attachments: result.attachments,
  })))
  await f.run(AttachmentClaims.releaseClaimedAttachments(result.claimedPaths))
  assert.ok(FileStore.resolveAttachmentPathById({ attachmentsDir: f.root, attachmentId: issued.attachmentId }))
})

test('claimed attachment asset uses original metadata, held descriptor, ranges and HEAD', async () => {
  const f = await fixture()
  const { issued } = await upload(f)
  const claimed = await f.run(AttachmentClaims.claimPendingAttachments({ threadId: 'thread:雪/1',
    attachments: [{ ...input, id: S.ChatAttachmentId.make(issued.attachmentId) }] }))
  const asset = await f.run(createSessionAsset({ resource: { _tag: 'attachment',
    attachmentId: claimed.attachments[0].id, fileName: input.name, mimeType: input.mimeType } }))
  const [, token, relativePath] = asset.relativeUrl.split('/api/assets/').join('/').split('/')
  for (const [range, expectedStatus, expectedBody] of [
    ['bytes=1-3', 206, 'bcd'], ['bytes=-2', 206, 'ef'], ['bytes=8-', 416, ''], [undefined, 200, 'abcdef'],
  ]) {
    await f.run(Effect.gen(function* () {
      const response = HttpServerResponse.toWeb(yield* readSessionAsset({ token, relativePath,
        ...(range ? { range } : {}) }))
      assert.equal(response.status, expectedStatus)
      assert.equal(yield* Effect.promise(() => response.text()), expectedBody)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
    }))
  }
  await f.run(Effect.gen(function* () {
    const response = HttpServerResponse.toWeb(yield* readSessionAsset({ token, relativePath,
      method: 'HEAD' }))
    assert.equal(yield* Effect.promise(() => response.text()), '')
    assert.equal(response.headers.get('content-length'), '6')
  }))
  const expiry = f.urls.get(asset.relativeUrl)
  f.urls.set(asset.relativeUrl, 0)
  await assert.rejects(f.run(readSessionAsset({ token, relativePath })))
  f.urls.set(asset.relativeUrl, expiry)
  f.state.revoked = true
  await assert.rejects(f.run(readSessionAsset({ token, relativePath })))
})

test('held file refuses in-place change and missing admission has no fallback', async () => {
  const f = await fixture()
  const filePath = join(f.root, 'mutable.txt')
  await writeFile(filePath, 'abcdef')
  await f.run(Effect.gen(function* () {
    const file = yield* FileMedia.openMediaFile(filePath)
    assert.ok(file)
    yield* Effect.promise(() => writeFile(filePath, 'changed length'))
    const access = yield* FilePorts.FileAccess
    const stream = FileMedia.streamMediaFile(file, 0n, 6n, access.recheck)
    const exit = yield* Effect.exit(Stream.runCollect(stream))
    assert.equal(exit._tag, 'Failure')
  }))
  await assert.rejects(Effect.runPromise(createSessionFileUpload(input)))
  assert.equal(FileHttp.assetByteRange('bytes=0-0', 0n)._tag, 'Unsatisfiable')
  assert.equal(FileHttp.assetByteRange('bytes=1-2,3-4', 6n), null)
})

test('original queue and question intake claim files before dispatch with original ids', async () => {
  const f = await fixture()
  const { issued } = await upload(f)
  const attachment = { ...input, id: issued.attachmentId }
  for (const raw of [
    { type: 'queued-run.edit', commandId: 'cmd:queue', threadId: 'thread:雪/1', runId: 'run:original',
      text: 'Soubor pro frontu', attachments: [attachment] },
    { type: 'runtime-request.respond', commandId: 'cmd:question', threadId: 'thread:雪/1', requestId: 'request:original',
      answers: { 'question:original': 'Tady je soubor' }, attachmentsByQuestionId: { 'question:original': [attachment] } },
  ]) {
    const command = Schema.decodeUnknownSync(S.OrchestrationV2Command)(raw)
    let dispatched
    await f.run(ThreadMessageIntake.dispatchCommand(command).pipe(
      Effect.provideService(Threads.ThreadManagementService, {
        dispatch: value => Effect.sync(() => { dispatched = value; return { storedEvents: [] } }),
      }),
    ))
    assert.equal(dispatched.commandId, raw.commandId)
    assert.equal(dispatched.threadId, raw.threadId)
    const files = dispatched.attachments ?? dispatched.attachmentsByQuestionId['question:original']
    assert.notEqual(files[0].id, attachment.id)
    assert.equal(files[0].name, attachment.name)
    if (raw.type === 'runtime-request.respond') {
      assert.equal(dispatched.requestId, raw.requestId)
      assert.match(dispatched.answers['question:original'], /Tady je soubor/)
      assert.match(dispatched.answers['question:original'], /Attached file/)
    }
  }
})

test('launch with foreign already-claimed attachment is rejected before the original fast path', async () => {
  const f = await fixture()
  let launched = false
  const file = { ...input, id: 'foreign-00000000-0000-4000-8000-000000000000-txt' }
  await assert.rejects(f.run(ThreadMessageIntake.launchThread({ threadId: 'thread:雪/1',
    initialMessage: { attachments: [file] } }).pipe(
    Effect.provideService(Launch.ThreadLaunchService, {
      launch: () => Effect.sync(() => { launched = true }),
    }),
  )))
  assert.equal(launched, false)
})
