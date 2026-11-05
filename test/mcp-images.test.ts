import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  extractExecutorMcpImages,
  executorMcpImageReferences,
  settleExecutorMcpImages,
  withdrawExecutorMcpImage,
  type ExecutorMcpImage,
} from '../src/mcp-images.js'

/**
 * Kelpie's answer to `kelpie_screenshot`, as the real Kelpie sent it from a
 * Windows browser on example.com (1918×957, a 13 715-byte PNG): the base64
 * once inside the text item's JSON, once as the image item, and once more in
 * `structuredContent`. Saved verbatim from the probe that measured it.
 */
const kelpieResult = (): Record<string, unknown> => JSON.parse(
  readFileSync(new URL('./fixtures/kelpie-screenshot-result.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

const EXAMPLE_DIGEST = 'sha256:aac8eca7b74f38470cd961da4b11897e2296ca4b583865dde161ab387027e7a5'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = (bytes: number, fill = 1): Buffer =>
  Buffer.concat([PNG_SIGNATURE, Buffer.alloc(bytes - PNG_SIGNATURE.length, fill)])
const digestOf = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const imageItem = (bytes: Buffer, mimeType = 'image/png') => ({ data: bytes.toString('base64'), mimeType, type: 'image' })

type Content = Array<Record<string, unknown>>
const contentOf = (result: Record<string, unknown>): Content => result.content as Content

test('Kelpie’s three copies of one screenshot collapse into one attachment', () => {
  const raw = kelpieResult()
  const base64 = (contentOf(raw)[1]!.data as string)
  assert.equal(JSON.stringify(raw).split(base64).length - 1, 3, 'the fixture carries the base64 three times')

  const { images, result } = extractExecutorMcpImages(raw)

  assert.equal(images.length, 1)
  assert.equal(images[0]!.digest, EXAMPLE_DIGEST)
  assert.equal(images[0]!.bytes.length, 13_715)
  assert.equal(images[0]!.mimeType, 'image/png')
  const marker = `[image: attachment ${EXAMPLE_DIGEST}]`
  const [text, reference] = contentOf(result)
  assert.deepEqual(reference, {
    attachmentDigest: EXAMPLE_DIGEST,
    byteLength: 13_715,
    mimeType: 'image/png',
    type: 'image',
  })
  // The text item is still Kelpie's JSON, with the marker where the base64 was.
  assert.deepEqual(JSON.parse(text!.text as string), {
    format: 'png', height: 957, image: marker, mimeType: 'image/png', success: true, tab: {}, width: 1918,
  })
  assert.equal((result.structuredContent as Record<string, unknown>).image, marker)
  const document = JSON.stringify(result)
  assert.equal(document.includes(base64.slice(0, 64)), false, 'no copy of the base64 is left anywhere')
  assert.ok(Buffer.byteLength(document) < 1_024, `${Buffer.byteLength(document)} bytes, down from 55 195`)
  assert.deepEqual(executorMcpImageReferences(result), [reference])
})

test('PNG, JPEG, WebP and GIF are kept when their bytes agree with the type they declare', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(200, 3)])
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 4)])
  const { images, result } = extractExecutorMcpImages({
    content: [
      imageItem(png(200)),
      imageItem(jpeg, 'image/jpeg'),
      imageItem(webp, 'image/webp'),
      imageItem(gif, 'image/gif'),
      // A declared type is compared without its case.
      imageItem(png(300), 'IMAGE/PNG'),
    ],
  })
  assert.deepEqual(images.map((image) => image.mimeType), ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/png'])
  assert.deepEqual(contentOf(result).map((item) => item.type), ['image', 'image', 'image', 'image', 'image'])
})

test('an image whose bytes disagree with its type, or of another type, becomes a placeholder', () => {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(80)}</svg>`)
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 2)])
  const { images, result } = extractExecutorMcpImages({
    content: [
      imageItem(jpeg, 'image/png'),
      imageItem(svg, 'image/svg+xml'),
      imageItem(svg, 'image/png'),
      { data: 'not base64 at all!', mimeType: 'image/png', type: 'image' },
      { mimeType: 'image/png', type: 'image' },
    ],
  })
  assert.equal(images.length, 0)
  assert.deepEqual(contentOf(result).map((item) => item.text), [
    '[image unavailable: its bytes are not the image/png it declares]',
    '[image unavailable: only PNG, JPEG, WebP and GIF images are delivered]',
    '[image unavailable: its bytes are not the image/png it declares]',
    '[image unavailable: the program sent no readable image data]',
    '[image unavailable: the program sent no readable image data]',
  ])
})

test('at most six images are kept from one result, and a repeated one counts once', () => {
  const distinct = Array.from({ length: 7 }, (_, index) => png(100, index + 1))
  const { images, result } = extractExecutorMcpImages({
    content: [imageItem(distinct[0]!), ...distinct.map((bytes) => imageItem(bytes))],
  })
  assert.equal(images.length, 6)
  const content = contentOf(result)
  // The repeat is a second reference to the first image, not a seventh one.
  assert.equal(content[0]!.attachmentDigest, digestOf(distinct[0]!))
  assert.equal(content[1]!.attachmentDigest, digestOf(distinct[0]!))
  assert.equal(content.filter((item) => item.type === 'image').length, 7)
  assert.equal(content[7]!.text, '[image unavailable: more than 6 images in one result]')
})

test('one image over 4 MiB, or images over 8 MiB together, become placeholders — and so do their copies', () => {
  const over = png(4 * 1024 * 1024 + 1, 5)
  const exactly = png(4 * 1024 * 1024, 6)
  const second = png(3 * 1024 * 1024, 7)
  const third = png(1024 * 1024 + 1, 8)
  const { images, result } = extractExecutorMcpImages({
    content: [imageItem(over), imageItem(exactly), imageItem(second), imageItem(third)],
    structuredContent: { image: over.toString('base64'), last: third.toString('base64') },
  })
  assert.deepEqual(images.map((image) => image.bytes.length), [exactly.length, second.length])
  const content = contentOf(result)
  const tooLarge = '[image unavailable: larger than the 4 MiB limit for one image]'
  const overTotal = "[image unavailable: over the 8 MiB limit for one result's images]"
  assert.equal(content[0]!.text, tooLarge)
  assert.equal(content[3]!.text, overTotal)
  // A refused image's copies go too, or they alone would sink the result.
  assert.deepEqual(result.structuredContent, { image: tooLarge, last: overTotal })
})

test('a copy another encoder line-wrapped or escaped becomes the marker too', () => {
  // 0xff bytes spell `/` in base64, so the JSON-escaped copy has slashes to escape.
  const bytes = png(3_000, 0xff)
  const data = bytes.toString('base64')
  const lines = (width: number): string[] => data.match(new RegExp(`.{1,${width}}`, 'gu'))!
  const { images, result } = extractExecutorMcpImages({
    content: [
      // JSON text from an encoder that escapes `/`, and one that wrapped the base64 before encoding it.
      { text: `{"image":"${data.replaceAll('/', '\\/')}","wrapped":"${lines(76).join('\\n')}"}`, type: 'text' },
      imageItem(bytes),
    ],
    structuredContent: { image: lines(76).join('\n'), pem: `-----BEGIN-----\r\n${lines(64).join('\r\n')}\r\n-----END-----` },
  })
  assert.equal(images.length, 1)
  const marker = `[image: attachment ${digestOf(bytes)}]`
  assert.deepEqual(JSON.parse(contentOf(result)[0]!.text as string), { image: marker, wrapped: marker })
  assert.deepEqual(result.structuredContent, { image: marker, pem: `-----BEGIN-----\r\n${marker}\r\n-----END-----` })
  const flattened = JSON.stringify(result).replace(/\\[nr/]|\s/gu, '')
  assert.equal(flattened.includes(data.slice(0, 64)), false, 'no spelling of the base64 is left anywhere')
})

test('an escaped copy whose base64 opens with a slash leaves nothing of that escape behind', () => {
  // Every JPEG's base64 opens `/9j/`, so its JSON-escaped copy opens with `\/`.
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3_000, 0xff)])
  const data = bytes.toString('base64')
  assert.equal(data.startsWith('/9j/'), true)
  const { result } = extractExecutorMcpImages({
    content: [{ text: `{"image":"${data.replaceAll('/', '\\/')}"}`, type: 'text' }, imageItem(bytes, 'image/jpeg')],
  })
  // A backslash left before the marker would be `\[`, which is no JSON escape at all.
  assert.deepEqual(JSON.parse(contentOf(result)[0]!.text as string), { image: `[image: attachment ${digestOf(bytes)}]` })
})

test('a copy shorter than any real image is left alone', () => {
  // 24 bytes of GIF: base64 short enough to occur in ordinary text by chance.
  const tiny = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(18, 1)])
  const data = tiny.toString('base64')
  const { images, result } = extractExecutorMcpImages({
    content: [{ text: `seen: ${data}`, type: 'text' }, imageItem(tiny, 'image/gif')],
  })
  assert.equal(images.length, 1)
  assert.equal(contentOf(result)[0]!.text, `seen: ${data}`)
})

test('a result with no content array, or no images, passes through unchanged', () => {
  const plain = { content: [{ text: 'hello', type: 'text' }], structuredContent: { a: 1 } }
  assert.deepEqual(extractExecutorMcpImages(plain), { images: [], result: plain })
  const odd = { toolResult: { image: 'x' } }
  assert.equal(extractExecutorMcpImages(odd).result, odd)
})

test('withdrawing an image turns its references and markers into one placeholder', () => {
  const { result } = extractExecutorMcpImages(kelpieResult())
  const withdrawn = withdrawExecutorMcpImage(result, EXAMPLE_DIGEST, 'Nessie refused it')
  const placeholder = '[image unavailable: Nessie refused it]'
  assert.deepEqual(contentOf(withdrawn)[1], { text: placeholder, type: 'text' })
  assert.equal((JSON.parse(contentOf(withdrawn)[0]!.text as string) as { image: string }).image, placeholder)
  assert.equal((withdrawn.structuredContent as Record<string, unknown>).image, placeholder)
  assert.deepEqual(executorMcpImageReferences(withdrawn), [])
  assert.equal(JSON.stringify(withdrawn).includes(EXAMPLE_DIGEST), false)
})

test('the sink keeps the images before the result is answered; without one they are withdrawn', async () => {
  const kept: ExecutorMcpImage[][] = []
  const settled = await settleExecutorMcpImages(kelpieResult(), async (images) => {
    kept.push([...images])
  }, () => undefined)
  assert.equal(kept.length, 1)
  assert.equal(kept[0]![0]!.digest, EXAMPLE_DIGEST)
  assert.deepEqual(executorMcpImageReferences(settled).map((reference) => reference.attachmentDigest), [EXAMPLE_DIGEST])

  const unkept = await settleExecutorMcpImages(kelpieResult(), undefined, () => undefined)
  assert.equal(contentOf(unkept)[1]!.text, '[image unavailable: this machine has nowhere to keep images]')

  const logged: string[] = []
  const failed = await settleExecutorMcpImages(kelpieResult(), async () => {
    throw new Error('ENOSPC: no space left on device')
  }, (message) => { logged.push(message) })
  assert.equal(contentOf(failed)[1]!.text, '[image unavailable: the image could not be kept on this machine]')
  assert.equal(JSON.stringify(failed).includes('ENOSPC'), false, 'the local error stays in the local log')
  assert.equal(logged.length, 1)
})
