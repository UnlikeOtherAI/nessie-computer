// Draws every executor icon from the one executor mark in `assets/logo`: the
// Windows tray's four states, the Windows window, taskbar and Apps & features
// icon, and the macOS menu bar app's application icon.
//
// The mark is an SVG of the shape itself, so each raster is drawn rather than
// resampled from a PNG with a soft, fringed edge — the same rule
// `assets/logo/generate.py` follows for the N mark, and the reason the two
// marks stay the same family rather than drifting apart.
//
// Colour is the tray's whole vocabulary: `state.rs` picks one of four icons and
// a person reads it at a glance beside the clock, at 16 or 32 pixels, without
// clicking. So the four states are the *same* mark in four palettes rather than
// four shapes — running is the brand mark in full colour, and the other three
// restate it in one hue so that "red beats amber beats green beats grey"
// survives being three millimetres wide.
//
// Run from the repository root, which is where its one dependency resolves: it
// rasterises with `sharp`, already in the workspace through `@nessie/runtime`,
// the same way `assets/logo/generate.py` leans on a Pillow it does not vendor.
//
//     node executor/scripts/generate-icons.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const executorDirectory = resolve(scriptDirectory, '..')
const repositoryDirectory = resolve(executorDirectory, '..')
const iconsDirectory = join(executorDirectory, 'tray-windows/src-tauri/icons')
const installerIconPath = join(executorDirectory, 'packaging/windows/assets/nessie-executor.ico')
const appIconSetDirectory = join(
  executorDirectory,
  'menubar-macos/Sources/App/Assets.xcassets/AppIcon.appiconset',
)
const markPath = join(repositoryDirectory, 'assets/logo/nessie-executor-mark.svg')

/**
 * The six fills the mark carries, in the order the SVG paints them. A state
 * palette replaces them by name, so a mark edit that adds a seventh fill fails
 * loudly here instead of silently shipping an icon with a brand colour in it.
 */
const BRAND = {
  yellow: '#FDC501',
  pink: '#FC2D8A',
  lightGreen: '#3AEFB1',
  green: '#04BC8F',
  blue: '#01A8FC',
  deepBlue: '#0066FC',
}

/**
 * One hue in two tones. The mark's own geometry decides which slot is lit and
 * which is shaded, so a state icon keeps the plus legible — a flat silhouette
 * at 16 pixels reads as a blob.
 */
const monochrome = (light, dark) => ({
  yellow: light,
  pink: dark,
  lightGreen: light,
  green: dark,
  blue: light,
  deepBlue: dark,
})

/**
 * Grey is "nothing is working for you right now", amber "something is
 * mid-flight", red "the service could not be reached". They are the tones the
 * tray already used, so an upgrade changes the shape without changing what a
 * colour means to somebody who has been watching it for months.
 */
const PALETTES = {
  'tray-running': BRAND,
  'tray-idle': monochrome('#8A8F98', '#676C75'),
  'tray-attention': monochrome('#F5A623', '#B87828'),
  'tray-error': monochrome('#E05252', '#A83838'),
}

/** Windows asks for the window and taskbar icon at every one of these. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

/**
 * The tray asks Windows for a 16-pixel icon at 100% scaling and a 32-pixel one
 * at 200%, and shrinks whatever it is given. Shipping 32 keeps the second case
 * exact, and the mark survives the first because it is four bars and no detail
 * below a stroke width.
 */
const TRAY_SIZE = 32

/**
 * The clock is crowded and the mark is drawn to its own edge, so a little air
 * keeps it from touching the icon next to it.
 */
const PADDING_RATIO = 0.06

/**
 * The macOS icon grid Nessie's own app icon is drawn on (`mac()` in
 * `assets/logo/generate.py`): an 824-point plate inset 100 points into a
 * 1024-point canvas, 185-point corners, on the same dark ground, with the mark
 * standing where the N stands. Finder, the DMG window and Login Items then show
 * the executor as Nessie's sibling rather than as the generic application icon
 * a bundle without one gets.
 */
const MAC_GRID = { canvas: 1024, inset: 100, radius: 185, ground: '#07152C', glyph: 0.56 }

/** Every point size macOS asks an app icon for, each at 1x and 2x. */
const MAC_POINT_SIZES = [16, 32, 128, 256, 512]

const recolour = (markup, palette) => {
  let recoloured = markup
  for (const [slot, brandColour] of Object.entries(BRAND)) {
    const replacement = palette[slot]
    if (!replacement) throw new Error(`palette is missing the ${slot} slot`)
    if (!recoloured.includes(brandColour)) {
      throw new Error(`the mark no longer paints ${brandColour} for ${slot}`)
    }
    recoloured = recoloured.split(brandColour).join(replacement)
  }
  return recoloured
}

const render = async (markup, size) => {
  const inner = Math.round(size * (1 - 2 * PADDING_RATIO))
  const margin = Math.round((size - inner) / 2)
  const mark = await sharp(Buffer.from(markup)).resize(inner, inner).png().toBuffer()
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, top: margin, left: margin }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * The plate and the mark are one SVG drawn at the target size, not a mark
 * raster pasted onto a plate raster: at 16 pixels the 100-point inset is a pixel
 * and a half, and rounding each layer on its own would set the plus off centre.
 */
const renderMac = (markup, size) => {
  const viewBox = markup.match(/<svg[^>]*\sviewBox="([^"]+)"/)?.[1]
  if (!viewBox) throw new Error('the mark has no viewBox to place it by')
  const body = markup.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  const { canvas, inset, radius, ground, glyph } = MAC_GRID
  const plate = canvas - 2 * inset
  const extent = canvas * glyph
  const origin = (canvas - extent) / 2
  const icon = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${canvas} ${canvas}">`,
    `<rect x="${inset}" y="${inset}" width="${plate}" height="${plate}" rx="${radius}" fill="${ground}"/>`,
    `<svg x="${origin}" y="${origin}" width="${extent}" height="${extent}" viewBox="${viewBox}">${body}</svg>`,
    '</svg>',
  ].join('')
  return sharp(Buffer.from(icon)).png({ compressionLevel: 9 }).toBuffer()
}

/**
 * A .ico is a directory of images, and every size here is stored as a whole PNG
 * rather than a DIB — the format has allowed that since Vista and it is what
 * keeps the 256-pixel entry from being a megabyte of bitmap.
 */
const ico = (images) => {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length
  images.forEach(({ size, data }, index) => {
    const entry = index * 16
    // 256 does not fit in a byte; the format spells it zero.
    directory.writeUInt8(size >= 256 ? 0 : size, entry)
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    directory.writeUInt8(0, entry + 2)
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.data)])
}

const markup = await readFile(markPath, 'utf8')

for (const [name, palette] of Object.entries(PALETTES)) {
  await writeFile(join(iconsDirectory, `${name}.png`), await render(recolour(markup, palette), TRAY_SIZE))
}

// The window and taskbar icon is the brand mark: those surfaces name the
// application, and only the tray reports a state. The installer's Apps &
// features entry names the same application, so it carries the same file.
await writeFile(join(iconsDirectory, '32x32.png'), await render(markup, 32))
const windowsIcon = ico(
  await Promise.all(ICO_SIZES.map(async (size) => ({ size, data: await render(markup, size) }))),
)
await writeFile(join(iconsDirectory, 'icon.ico'), windowsIcon)
await writeFile(installerIconPath, windowsIcon)

// The asset catalog the menu bar app compiles its icon from. Contents.json is
// written with the images so the set can never name a file it does not hold.
await mkdir(appIconSetDirectory, { recursive: true })
const appIconImages = []
for (const points of MAC_POINT_SIZES) {
  for (const scale of [1, 2]) {
    const filename = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`
    await writeFile(join(appIconSetDirectory, filename), await renderMac(markup, points * scale))
    appIconImages.push({ filename, idiom: 'mac', scale: `${scale}x`, size: `${points}x${points}` })
  }
}
await writeFile(
  join(appIconSetDirectory, 'Contents.json'),
  `${JSON.stringify({ images: appIconImages, info: { author: 'xcode', version: 1 } }, null, 2)}\n`,
)

console.log(`wrote ${Object.keys(PALETTES).length + 2} icons to ${relativeToRepository(iconsDirectory)}`)
console.log(`wrote the Apps & features icon to ${relativeToRepository(installerIconPath)}`)
console.log(`wrote ${appIconImages.length} app icons to ${relativeToRepository(appIconSetDirectory)}`)

function relativeToRepository(path) {
  return path.slice(repositoryDirectory.length + 1).split('\\').join('/')
}
