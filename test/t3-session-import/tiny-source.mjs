import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/** Builtin type erasure only, no compiler/dependency preparation or domain mock.
 * The ordinary engine consumer gate separately imports the supported build.
 */
export async function prepareTinySources() {
  const directory = join(root, '.artifacts/t04-import', randomUUID())
  const files = ['state/sqlite', 'state/journal', 'ownership/continuity', 'import/manifest', 'import/layout', 'import/snapshot']
  for (const file of files) {
    const target = join(directory, `${file}.js`)
    await mkdir(dirname(target), { recursive: true })
    const source = await readFile(join(root, 'src/t3-session', `${file}.ts`), 'utf8')
    await writeFile(target, stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: `${file}.ts` }))
  }
  await writeFile(join(directory, 'import/migration-manifest.json'),
    await readFile(join(root, 'src/t3-session/import/migration-manifest.json')))
  const load = file => import(pathToFileURL(join(directory, `${file}.js`)).href)
  return { directory, root, load }
}
