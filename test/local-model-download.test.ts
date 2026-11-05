import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'

import type { LocalModelFile } from '@nessie/executor-protocol'

import {
  downloadModelFile,
  hasRoomFor,
  parseContentRange,
  stagedFilePath,
  verifiedFilePath,
  type OpenStagedFile,
  type WeightsFetch,
} from '../src/local-model-download.js'
import { open as openFile } from 'node:fs/promises'

const BYTES = Buffer.from('the weights, such as they are, in this test')
const DIGEST = createHash('sha256').update(BYTES).digest('hex')

const fileOf = (overrides: Partial<LocalModelFile> = {}): LocalModelFile => ({
  key: `gemma4/e2b/q4_0/${DIGEST}/model.gguf`,
  sha256: DIGEST,
  bytes: BYTES.byteLength,
  upstream: 'hf:example/test',
  ...overrides,
})

const withStateDir = async (run: (stateDir: string) => Promise<void>): Promise<void> => {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'nessie-local-model-'))
  try {
    await run(stateDir)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
}

const respondWholeObject: WeightsFetch = (_url, _init) =>
  Promise.resolve(
    new Response(new Uint8Array(BYTES), {
      status: 200,
      headers: { 'content-length': String(BYTES.byteLength), etag: '"v1"' },
    }),
  )

const plentyOfRoom = () => Promise.resolve({ bavail: 1_000_000, bsize: 4_096 })

test('a whole object that hashes to its pin lands under its final name', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const seen: number[] = []
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      onProgress: (progress) => seen.push(progress.downloadedBytes),
      statfsImpl: plentyOfRoom,
    })

    assert.deepEqual(outcome, { ok: true, path: verifiedFilePath(stateDir, 'gemma4-e2b-q4', file) })
    assert.deepEqual(await readFile(outcome.ok ? outcome.path : ''), BYTES)
    assert.equal(seen.at(-1), BYTES.byteLength)
    await assert.rejects(stat(stagedFilePath(stateDir, 'gemma4-e2b-q4', file)))
  })
})

test('bytes that hash to anything else are refused, and the partial is destroyed', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf({ sha256: 'a'.repeat(64) })
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'digest_mismatch')
    assert.equal(outcome.ok === false && outcome.observedDigest, DIGEST)
    // Nothing is left that a resume could build on, and nothing is advertised.
    await assert.rejects(stat(stagedFilePath(stateDir, 'gemma4-e2b-q4', file)))
    await assert.rejects(stat(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)))
  })
})

test('a 206 whose total is not the pinned length is refused before a byte is written', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, BYTES.subarray(0, 10))

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array(BYTES.subarray(10)), {
            status: 206,
            // A different build sitting behind the same URL.
            headers: { 'content-range': `bytes 10-41/999999` },
          }),
        ),
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok === false && outcome.reason, 'size_mismatch')
  })
})

test('a resumed download continues one digest over the bytes already on disk', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, BYTES.subarray(0, 10))

    let requestedRange: string | undefined
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: (_url, init) => {
        requestedRange = init.headers.Range
        return Promise.resolve(
          new Response(new Uint8Array(BYTES.subarray(10)), {
            status: 206,
            headers: { 'content-range': `bytes 10-${BYTES.byteLength - 1}/${BYTES.byteLength}` },
          }),
        )
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(requestedRange, 'bytes=10-')
    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a mirror that ignores the range and sends the whole object still ends at the right digest', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, Buffer.from('rubbish that is not our prefix'))

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a live lock holder is respected rather than raced', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const directory = resolve(stagedFilePath(stateDir, 'gemma4-e2b-q4', file), '..')
    await mkdir(directory, { recursive: true })
    await writeFile(
      resolve(directory, '.downloading'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    )

    // A throw from inside fetchImpl would be caught and reported as
    // `mirror_unreachable`, so "did not dial" has to be observed, not asserted.
    let dialed = false
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: (url, init) => {
        dialed = true
        return respondWholeObject(url, init)
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(dialed, false)
    assert.equal(outcome.ok === false && outcome.reason, 'download_in_progress')
  })
})

test('a lock left by a dead process is cleared', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const directory = resolve(stagedFilePath(stateDir, 'gemma4-e2b-q4', file), '..')
    await mkdir(directory, { recursive: true })
    await writeFile(
      resolve(directory, '.downloading'),
      JSON.stringify({ pid: 2_147_483_600, startedAt: new Date().toISOString() }),
    )

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, true)
  })
})

test('a volume without room for the file and Ollama copy of it refuses the pull', async () => {
  await withStateDir(async (stateDir) => {
    let dialed = false
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file: fileOf(),
      stateDir,
      fetchImpl: (url, init) => {
        dialed = true
        return respondWholeObject(url, init)
      },
      // Less than the file itself, let alone the copy Ollama's import makes.
      statfsImpl: () => Promise.resolve({ bavail: 10, bsize: 1 }),
    })

    assert.equal(dialed, false)
    assert.equal(outcome.ok === false && outcome.reason, 'no_storage')
  })
})

test('an already-verified file is not fetched again', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const finalPath = verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(finalPath, '..'), { recursive: true })
    await writeFile(finalPath, BYTES)

    let dialed = false
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: (url, init) => {
        dialed = true
        return respondWholeObject(url, init)
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(dialed, false)
    assert.deepEqual(outcome, { ok: true, path: finalPath })
  })
})

test('an unreachable mirror is a reported reason, not a throw', async () => {
  await withStateDir(async (stateDir) => {
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file: fileOf(),
      stateDir,
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok === false && outcome.reason, 'mirror_unreachable')
  })
})

test('content ranges are read strictly, start as well as total', () => {
  assert.deepEqual(parseContentRange('bytes 0-9/100'), { start: 0, total: 100 })
  assert.deepEqual(parseContentRange('bytes 10-99/100'), { start: 10, total: 100 })
  assert.equal(parseContentRange('bytes 0-9/*'), undefined)
  assert.equal(parseContentRange('items 0-9/100'), undefined)
  assert.equal(parseContentRange(null), undefined)
})

test('an unreadable volume does not block a download', async () => {
  const room = await hasRoomFor('/nowhere', 10_000, () => Promise.reject(new Error('ENOENT')))
  assert.equal(room.ok, true)
})

test('resume asks with If-Range, so a rotated object self-heals instead of sticking on 412', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    // Shorter than the pinned length, so this is genuinely a resume.
    await writeFile(partPath, Buffer.from('a stale prefix'))
    await writeFile(partPath + '.meta', JSON.stringify({ etag: '"old"' }))

    let sentHeaders: Record<string, string> = {}
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      // An If-Range whose validator no longer matches yields the whole current
      // object, which is the restart path. If-Match would have yielded 412.
      fetchImpl: (url, init) => {
        sentHeaders = init.headers
        return respondWholeObject(url, init)
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(sentHeaders['If-Range'], '"old"')
    assert.equal(sentHeaders['If-Match'], undefined)
    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a 206 starting at the wrong offset is refused rather than written at ours', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, BYTES.subarray(0, 10))

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array(BYTES), {
            status: 206,
            // We asked from byte 10; this answers from zero with the right total.
            headers: { 'content-range': 'bytes 0-' + String(BYTES.byteLength - 1) + '/' + String(BYTES.byteLength) },
          }),
        ),
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok === false && outcome.reason, 'size_mismatch')
  })
})

test('a 206 carrying a different validator is refused before the transfer', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, BYTES.subarray(0, 10))
    await writeFile(partPath + '.meta', JSON.stringify({ etag: '"v1"' }))

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      // A cache edge that served the range without honouring If-Range.
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array(BYTES.subarray(10)), {
            status: 206,
            headers: {
              'content-range': 'bytes 10-' + String(BYTES.byteLength - 1) + '/' + String(BYTES.byteLength),
              etag: '"v2"',
            },
          }),
        ),
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok === false && outcome.reason, 'size_mismatch')
  })
})

test('a partial that is already complete is finished from disk, with no request at all', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    // Died between the last write and the digest check.
    await writeFile(partPath, BYTES)

    let dialed = false
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: (url, init) => {
        dialed = true
        return respondWholeObject(url, init)
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(dialed, false)
    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a complete partial that hashes wrong is destroyed rather than promoted', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, Buffer.alloc(BYTES.byteLength, 0x41))

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok === false && outcome.reason, 'digest_mismatch')
    await assert.rejects(stat(partPath))
    await assert.rejects(stat(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)))
  })
})

test('an empty lock is treated as occupied, not as wreckage to clear', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const directory = resolve(stagedFilePath(stateDir, 'gemma4-e2b-q4', file), '..')
    await mkdir(directory, { recursive: true })
    // Exactly what an exclusive create publishes in the instant before its
    // JSON lands. A competitor that read this as abandoned would take a lock
    // another process already holds, and both would write one partial file.
    await writeFile(resolve(directory, '.downloading'), '')

    let dialed = false
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: (url, init) => {
        dialed = true
        return respondWholeObject(url, init)
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(dialed, false)
    assert.equal(outcome.ok === false && outcome.reason, 'download_in_progress')
  })
})

test('a short write is completed rather than silently leaving a hole', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      // A body delivered in many small chunks exercises the write loop at
      // every offset; the file on disk must equal the bytes we hashed.
      fetchImpl: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < BYTES.byteLength; index += 3) {
              controller.enqueue(new Uint8Array(BYTES.subarray(index, index + 3)))
            }
            controller.close()
          },
        })
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'content-length': String(BYTES.byteLength) },
          }),
        )
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a resume is not refused for room to re-fetch bytes it already has', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, BYTES.subarray(0, 40))

    // Room for the two bytes still missing and Ollama copy, but nowhere near
    // 2.2x the whole file. The old check charged for the whole file again.
    const required = file.bytes - 40 + Math.ceil(file.bytes * 1.2)
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array(BYTES.subarray(40)), {
            status: 206,
            headers: { 'content-range': 'bytes 40-' + String(BYTES.byteLength - 1) + '/' + String(BYTES.byteLength) },
          }),
        ),
      statfsImpl: () => Promise.resolve({ bavail: required, bsize: 1 }),
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a complete partial is finished even when the disk has no room to fetch anything', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, BYTES)

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: () => Promise.resolve({ bavail: 0, bsize: 512 }),
    })

    assert.equal(outcome.ok, true)
  })
})

test('a cached file of the right length but the wrong bytes can be recovered from', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const finalPath = verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(finalPath, '..'), { recursive: true })
    await writeFile(finalPath, Buffer.alloc(BYTES.byteLength, 0x41))

    // Trusted by length, this hands back the corrupt file for ever.
    const trusted = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })
    assert.equal(trusted.ok, true)
    assert.notDeepEqual(await readFile(finalPath), BYTES)

    // Asked to revalidate, it throws the bad copy away and fetches again.
    const repaired = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      revalidateCached: true,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })
    assert.equal(repaired.ok, true)
    assert.deepEqual(await readFile(finalPath), BYTES)
  })
})

test('a filesystem refusal is an outcome, not a rejected promise', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const finalPath = verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(finalPath, '..'), { recursive: true })
    // A directory where the staged file needs to be: open() fails with EISDIR.
    await mkdir(stagedFilePath(stateDir, 'gemma4-e2b-q4', file), { recursive: true })

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, false)
    assert.ok(outcome.ok === false && outcome.reason !== 'digest_mismatch')
  })
})

/**
 * A handle that stores at most `limit` bytes per call, which is what a real
 * short write looks like. Splitting the network body into small chunks does
 * not exercise this: the bug was in how one chunk is written, not how many
 * chunks arrive.
 */
const shortWritingOpen = (limit: number): OpenStagedFile => async (path, flags, mode) => {
  const handle = await openFile(path, flags, mode)
  return {
    close: () => handle.close(),
    truncate: (length) => handle.truncate(length),
    write: async (data, offset, length, position) => {
      const capped = Math.min(length, limit)
      const { bytesWritten } = await handle.write(data, offset, capped, position)
      return { bytesWritten }
    },
  }
}

test('a genuinely short write is retried until the bytes are all on disk', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      // One byte at a time: without the write loop the file would be full of
      // holes while the streamed digest still matched, and it would be
      // promoted as verified.
      openImpl: shortWritingOpen(1),
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a write that stores nothing fails the download instead of looping forever', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      openImpl: shortWritingOpen(0),
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, false)
    await assert.rejects(stat(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)))
  })
})

test('only one of two racers reclaims the same dead lock', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const directory = resolve(stagedFilePath(stateDir, 'gemma4-e2b-q4', file), '..')
    await mkdir(directory, { recursive: true })
    await writeFile(
      resolve(directory, '.downloading'),
      JSON.stringify({ pid: 2_147_483_600, startedAt: new Date().toISOString() }),
    )

    // Both see the same dead holder. Reclaim is a rename, which succeeds for
    // exactly one of them, so the loser must back off rather than delete the
    // winner lock and write the same partial file alongside it.
    const race = () =>
      downloadModelFile({
        baseUrl: 'https://mirror.example.com',
        entryId: 'gemma4-e2b-q4',
        file,
        stateDir,
        fetchImpl: respondWholeObject,
        statfsImpl: plentyOfRoom,
      })
    const [first, second] = await Promise.all([race(), race()])

    const outcomes = [first, second]
    const busy = outcomes.filter((o) => o.ok === false && o.reason === 'download_in_progress')
    const done = outcomes.filter((o) => o.ok)
    assert.equal(done.length + busy.length, 2, JSON.stringify(outcomes))
    assert.ok(done.length >= 1)
  })
})

test('a disk failure mid-transfer is a local error, not a blamed mirror', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const failing: OpenStagedFile = async (path, flags, mode) => {
      const handle = await openFile(path, flags, mode)
      return {
        close: () => handle.close(),
        truncate: (length) => handle.truncate(length),
        write: () => {
          const error: NodeJS.ErrnoException = new Error('read-only file system')
          error.code = 'EROFS'
          return Promise.reject(error)
        },
      }
    }

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      openImpl: failing,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok === false && outcome.reason, 'local_error')
  })
})
