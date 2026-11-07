import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { SessionEngineSourceError, T3_SESSION_ENGINE_SOURCE } from './source.mjs'

const refuse = () => { throw new SessionEngineSourceError('SESSION_ENGINE_SOURCE_CAPSULE_INVALID') }
const text = bytes => bytes.toString('utf8').replace(/\0.*$/su, '')
const safePath = value => value !== '' && !value.includes('\\') && !value.startsWith('/')
  && !value.split('/').some(part => part === '..' || part === '.' || part === '.git')

const pax = bytes => {
  const result = {}
  let offset = 0
  while (offset < bytes.length) {
    const separator = bytes.indexOf(32, offset)
    if (separator < offset) refuse()
    const lengthText = bytes.subarray(offset, separator).toString('ascii')
    if (!/^[1-9][0-9]*$/u.test(lengthText)) refuse()
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length <= separator - offset + 2 || offset + length > bytes.length
      || bytes[offset + length - 1] !== 10) refuse()
    const entry = bytes.subarray(separator + 1, offset + length - 1).toString('utf8')
    const equals = entry.indexOf('=')
    if (equals <= 0 || Object.hasOwn(result, entry.slice(0, equals))) refuse()
    result[entry.slice(0, equals)] = entry.slice(equals + 1)
    offset += length
  }
  return result
}

/** Read only an already pinned Git tar; no extraction or source execution. */
export const readSessionEngineSnapshot = async (archivePath, spec = T3_SESSION_ENGINE_SOURCE) => {
  const archive = await readFile(archivePath)
  if (archive.length !== spec.archiveBytes
    || createHash('sha256').update(archive).digest('hex') !== spec.archiveSha256) refuse()
  const files = new Map()
  let attributes = {}
  let offset = 0
  let ended = false
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (archive.subarray(offset).some(byte => byte !== 0)) refuse()
      ended = true
      break
    }
    const sizeText = text(header.subarray(124, 136)).trim()
    const checksumText = text(header.subarray(148, 156)).trim()
    if (!/^[0-7]+$/u.test(sizeText) || !/^[0-7]+$/u.test(checksumText)) refuse()
    const size = Number.parseInt(sizeText, 8)
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (checksum !== Number.parseInt(checksumText, 8) || offset + 512 + size > archive.length) refuse()
    const contents = archive.subarray(offset + 512, offset + 512 + size)
    const prefix = text(header.subarray(345, 500))
    const name = `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`
    const type = String.fromCharCode(header[156])
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'g') {
      const global = pax(contents)
      if (Object.keys(global).some(key => key !== 'comment') || global.comment !== spec.commit) refuse()
      continue
    }
    if (type === 'x') {
      if (Object.keys(attributes).length !== 0) refuse()
      attributes = pax(contents)
      if (Object.keys(attributes).some(key => key !== 'path')) refuse()
      continue
    }
    const file = attributes.path ?? name
    attributes = {}
    if (!safePath(file)) refuse()
    if (type === '5') continue
    if (!['0', '\0'].includes(type) || files.has(file)
      || !spec.roots.some(root => file === root || file.startsWith(`${root}/`))) refuse()
    files.set(file, contents)
  }
  if (!ended || Object.keys(attributes).length !== 0 || files.size === 0) refuse()
  return Object.freeze({
    identity: Object.freeze({ commit: spec.commit, tree: spec.tree, archiveSha256: spec.archiveSha256 }),
    files: Object.freeze([...files.keys()].sort()),
    read: file => {
      const value = files.get(file)
      if (!value) throw new SessionEngineSourceError('SESSION_ENGINE_SOURCE_FILE_ABSENT')
      return Buffer.from(value)
    },
  })
}
