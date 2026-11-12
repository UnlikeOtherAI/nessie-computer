import type { DeclaredLocalApp } from './local-app-discovery-claude.js'

/**
 * The stdio MCP servers in Codex's `config.toml`: every `[mcp_servers.<name>]`
 * table with a `command`, its `args`, `env` (inline or as its own
 * `[mcp_servers.<name>.env]` table) and `cwd`, unless `enabled = false`.
 *
 * This reads the part of TOML a Codex configuration uses — basic, literal
 * and multi-line strings, arrays, inline tables, booleans, comments; numbers
 * and dates are stepped over — and no more. A server whose fields are not
 * exactly strings where strings belong is left out rather than half-read, and
 * a file this reader cannot follow to its end yields nothing: an argv it
 * guessed at would start a program nobody wrote. A server with a `url` is
 * remote and is not a local app.
 */

type Value = string | boolean | Value[] | { [key: string]: Value } | typeof UNREAD
const UNREAD = Symbol('unread')

class TomlSubsetError extends Error {}

const BASIC_ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

const skipSpace = (text: string, at: number): number => {
  let index = at
  while (index < text.length) {
    if (text[index] === ' ' || text[index] === '\t' || text[index] === '\n' || text[index] === '\r') index += 1
    else if (text[index] === '#') while (index < text.length && text[index] !== '\n') index += 1
    else break
  }
  return index
}

const readEscape = (text: string, index: number): { value: string; width: number } => {
  const escape = text[index + 1] ?? ''
  if (escape === 'u' || escape === 'U') {
    const width = escape === 'u' ? 4 : 8
    const hex = text.slice(index + 2, index + 2 + width)
    if (!/^[0-9A-Fa-f]+$/u.test(hex) || hex.length !== width) throw new TomlSubsetError('escape')
    return { value: String.fromCodePoint(Number.parseInt(hex, 16)), width: 2 + width }
  }
  if (BASIC_ESCAPES[escape] === undefined) throw new TomlSubsetError('escape')
  return { value: BASIC_ESCAPES[escape], width: 2 }
}

/** A `"""` or `'''` string, read so the rest of the file stays in step whatever key holds it. */
const readMultilineString = (text: string, at: number): { value: string; end: number } => {
  const delimiter = text.slice(at, at + 3)
  let index = at + 3
  if (text[index] === '\r') index += 1
  if (text[index] === '\n') index += 1
  let value = ''
  while (index < text.length) {
    if (text.startsWith(delimiter, index)) return { value, end: index + 3 }
    if (delimiter === '"""' && text[index] === '\\') {
      if (/^\\[ \t]*\r?\n/u.test(text.slice(index))) {
        index += 1
        while (/[ \t\r\n]/u.test(text[index] ?? '')) index += 1
        continue
      }
      const escaped = readEscape(text, index)
      value += escaped.value
      index += escaped.width
      continue
    }
    value += text[index]
    index += 1
  }
  throw new TomlSubsetError('unterminated string')
}

const readString = (text: string, at: number): { value: string; end: number } => {
  const quote = text[at]!
  if (text.startsWith(quote.repeat(3), at)) return readMultilineString(text, at)
  let value = ''
  for (let index = at + 1; index < text.length; index += 1) {
    const character = text[index]!
    if (character === '\n') break
    if (character === quote) return { value, end: index + 1 }
    if (quote === '"' && character === '\\') {
      const escaped = readEscape(text, index)
      value += escaped.value
      index += escaped.width - 1
    } else value += character
  }
  throw new TomlSubsetError('unterminated string')
}

const readKey = (text: string, at: number): { key: string; end: number } => {
  if (text[at] === '"' || text[at] === '\'') {
    const { value, end } = readString(text, at)
    return { key: value, end }
  }
  const match = /^[A-Za-z0-9_-]+/u.exec(text.slice(at))
  if (!match) throw new TomlSubsetError('key')
  return { key: match[0], end: at + match[0].length }
}

/** A dotted key such as `mcp_servers."my server".env`. */
const readDottedKey = (text: string, at: number): { path: string[]; end: number } => {
  const path: string[] = []
  let index = at
  for (;;) {
    index = skipSpace(text, index)
    const { key, end } = readKey(text, index)
    path.push(key)
    index = skipSpace(text, end)
    if (text[index] !== '.') return { path, end: index }
    index += 1
  }
}

const readValue = (text: string, at: number): { value: Value; end: number } => {
  const index = skipSpace(text, at)
  const character = text[index]
  if (character === '"' || character === '\'') return readString(text, index)
  if (character === '[') {
    const items: Value[] = []
    let cursor = skipSpace(text, index + 1)
    while (text[cursor] !== ']') {
      const item = readValue(text, cursor)
      items.push(item.value)
      cursor = skipSpace(text, item.end)
      if (text[cursor] === ',') cursor = skipSpace(text, cursor + 1)
      else if (text[cursor] !== ']') throw new TomlSubsetError('array')
    }
    return { value: items, end: cursor + 1 }
  }
  if (character === '{') {
    const table: Record<string, Value> = {}
    let cursor = skipSpace(text, index + 1)
    while (text[cursor] !== '}') {
      const { path, end } = readDottedKey(text, cursor)
      if (path.length !== 1 || text[end] !== '=') throw new TomlSubsetError('inline table')
      const item = readValue(text, end + 1)
      table[path[0]!] = item.value
      cursor = skipSpace(text, item.end)
      if (text[cursor] === ',') cursor = skipSpace(text, cursor + 1)
      else if (text[cursor] !== '}') throw new TomlSubsetError('inline table')
    }
    return { value: table, end: cursor + 1 }
  }
  const bare = /^[^\s,\]}#]+/u.exec(text.slice(index))
  if (!bare) throw new TomlSubsetError('value')
  const word = bare[0]
  return { value: word === 'true' ? true : word === 'false' ? false : UNREAD, end: index + word.length }
}

type ServerFields = { fields: Record<string, Value>; env: Record<string, Value> }

const collectServers = (text: string): Map<string, ServerFields> => {
  const servers = new Map<string, ServerFields>()
  const server = (name: string): ServerFields => {
    if (!servers.has(name)) servers.set(name, { fields: {}, env: {} })
    return servers.get(name)!
  }
  let table: string[] = []
  let index = skipSpace(text, 0)
  while (index < text.length) {
    if (text.startsWith('[[', index)) throw new TomlSubsetError('array of tables')
    if (text[index] === '[') {
      const { path, end } = readDottedKey(text, index + 1)
      if (text[end] !== ']') throw new TomlSubsetError('table')
      table = path
      if (table[0] === 'mcp_servers' && table[1] !== undefined) server(table[1])
      index = skipSpace(text, end + 1)
      continue
    }
    const { path, end } = readDottedKey(text, index)
    if (text[end] !== '=') throw new TomlSubsetError('key/value')
    const full = [...table, ...path]
    const read = readValue(text, end + 1)
    if (full[0] === 'mcp_servers' && full[1] !== undefined) {
      const target = server(full[1])
      if (full.length === 3) target.fields[full[2]!] = read.value
      else if (full.length === 4 && full[2] === 'env') target.env[full[3]!] = read.value
    }
    index = skipSpace(text, read.end)
  }
  return servers
}

const strings = (value: Value | undefined): string[] | undefined => (
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : undefined
)

const stringTable = (value: Value | undefined): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  return entries.every(([, item]) => typeof item === 'string') ? Object.fromEntries(entries) as Record<string, string>
    : undefined
}

export const codexDeclaredLocalApps = (text: string): DeclaredLocalApp[] => {
  let servers: Map<string, ServerFields>
  try {
    servers = collectServers(text)
  } catch {
    // A file this reader cannot follow to its end yields nothing: a later
    // table could be one of these servers', changing what an earlier one says.
    return []
  }
  const declared: DeclaredLocalApp[] = []
  for (const [name, { fields, env }] of servers) {
    if (fields.url !== undefined || fields.enabled === false) continue
    if (typeof fields.command !== 'string' || !fields.command) continue
    const args = fields.args === undefined ? [] : strings(fields.args)
    const inlineEnv = fields.env === undefined ? {} : stringTable(fields.env)
    const tableEnv = stringTable(env)
    if (!args || !inlineEnv || !tableEnv || (fields.cwd !== undefined && typeof fields.cwd !== 'string')) continue
    const merged = { ...inlineEnv, ...tableEnv }
    declared.push({
      name,
      command: [fields.command, ...args],
      ...(typeof fields.cwd === 'string' ? { cwd: fields.cwd } : {}),
      ...(Object.keys(merged).length ? { env: merged } : {}),
    })
  }
  return declared
}
