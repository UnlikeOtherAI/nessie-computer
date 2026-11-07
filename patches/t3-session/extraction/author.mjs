import { createHash } from 'node:crypto'
import { posix } from 'node:path'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const imports = text => [...text.matchAll(/^import[\s\S]*?from "[^"]+"(?: with \{[^}]+\})?;/gm)]

/** Author exact refactors against a verified capsule; never against working source files. */
export const createPatchAuthor = snapshot => {
  const files = new Map()
  const patches = []
  const read = file => files.get(file) ?? snapshot.read(file).toString('utf8')
  const replace = (file, from, to, id) => {
    const before = read(file)
    if (!from || before.split(from).length !== 2) throw new Error(`Nonunique extraction seam: ${id}`)
    const after = before.replace(from, to)
    patches.push({ id, file, from, to, beforeSha256: sha256(before), afterSha256: sha256(after) })
    files.set(file, after)
  }
  const between = (file, start, end) => {
    const text = read(file)
    if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error(`Nonunique range: ${file}`)
    const first = text.indexOf(start)
    const last = text.indexOf(end, first + start.length)
    if (last < first) throw new Error(`Reversed range: ${file}`)
    return text.slice(first, last)
  }
  const add = (file, text, id) => {
    if (snapshot.files.includes(file) || files.has(file)) throw new Error(`Existing derived file: ${file}`)
    // Store original ranges by hash, not editable copies of upstream implementations.
    patches.push({ id, file, create: [{ text }], beforeSha256: null, afterSha256: sha256(text) })
    files.set(file, text)
  }
  const derive = (file, parts, id) => {
    if (snapshot.files.includes(file) || files.has(file)) throw new Error(`Existing derived file: ${file}`)
    const encoded = parts.map(part => typeof part === 'string' ? { text: part } : part)
    const text = encoded.map(part => part.text ?? (part.sourceStage === 'current'
      ? Buffer.from(read(part.sourceFile)) : snapshot.read(part.sourceFile))
      .subarray(part.start, part.end).toString('utf8')).join('')
    patches.push({ id, file, create: encoded, beforeSha256: null, afterSha256: sha256(text) })
    files.set(file, text)
  }
  const sourcePart = (file, text, { current = false } = {}) => {
    const bytes = current ? Buffer.from(read(file)) : snapshot.read(file)
    const selected = Buffer.from(text)
    const start = bytes.indexOf(selected)
    if (start < 0 || bytes.indexOf(selected, start + 1) >= 0) throw new Error(`Nonunique original fragment: ${file}`)
    return { sourceFile: file, start, end: start + selected.length, sha256: sha256(selected),
      ...(current ? { sourceStage: 'current', sourceSha256: sha256(bytes) } : {}) }
  }
  return { read, replace, between, add, derive, sourcePart, patches, files }
}

/** Retain only imports used by the moved declarations/operations, with original aliases. */
export const selectedImports = (original, body, originalPath, targetPath, redirects = new Map()) => {
  const used = name => new RegExp(`\\b${name}\\b`, 'u').test(body)
  return imports(original).flatMap(match => {
    const statement = match[0]
    const specifier = /from "([^"]+)"/u.exec(statement)[1]
    const binding = statement.slice('import '.length, statement.lastIndexOf(' from '))
    let selected = binding
    const namespace = /^(?:type )?\* as (\w+)$/u.exec(binding)
    if (namespace) {
      if (!used(namespace[1])) return []
    } else if (binding.includes('{')) {
      const type = binding.startsWith('type ') ? 'type ' : ''
      const names = binding.slice(binding.indexOf('{') + 1, binding.lastIndexOf('}')).split(',')
        .map(name => name.trim()).filter(Boolean)
        .filter(name => used(name.replace(/^type /u, '').split(/\s+as\s+/u).at(-1)))
      if (!names.length) return []
      selected = `${type}{ ${names.join(', ')} }`
    } else if (!used(binding)) return []
    let path = specifier
    if (path.startsWith('.')) {
      const absolute = posix.normalize(posix.join(posix.dirname(originalPath), path))
      const target = redirects.get(absolute) ?? absolute
      path = posix.relative(posix.dirname(targetPath), target)
      if (!path.startsWith('.')) path = `./${path}`
    }
    return [`import ${selected} from "${path}";`]
  }).join('\n') + '\n'
}

export const exportedNames = text => [...new Set([...text.matchAll(
  /^export (?:class|interface|type|const|function) (\w+)/gm,
)].map(match => match[1]))]
