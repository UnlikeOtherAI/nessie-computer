import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const directory = join(root, '.artifacts/native-claude-source')
const files = [
  'existing-session/types', 'existing-session/claude-saved', 'existing-session/claude-history',
  't3-session/ownership/continuity', 't3-session/native-sources/history-homes', 't3-session/native-sources/held-history',
  ...['identity', 'catalog', 'history', 'index'].map(name => `t3-session/native-sources/claude/${name}`),
]
// Node's builtin type erasure loads these exact authored modules. No dependency
// install, substitute runtime package, generated engine or compiler is involved.
for (const name of files) {
  const input = await readFile(join(root, 'src', `${name}.ts`), 'utf8')
  const output = join(directory, `${name}.js`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, stripTypeScriptTypes(input, { mode: 'strip' }))
}
await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
export const load = name => import(pathToFileURL(join(directory, `${name}.js`)).href)
export const fixtureRoot = join(directory, 'fixtures')
