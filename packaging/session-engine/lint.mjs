import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tools = fileURLToPath(new URL('.', import.meta.url))

export const lintSessionEngineSources = async () => {
  const { ESLint } = await import('eslint')
  const { default: configuration } = await import('./eslint.config.mjs')
  const files = [
    ...(await readdir(tools)).filter(file => file.endsWith('.mjs')).map(file => resolve(tools, file)),
    ...(await readdir(resolve(tools, 'core'))).filter(file => file.endsWith('.ts'))
      .map(file => resolve(tools, 'core', file)),
    ...(await readdir(resolve(tools, '../../patches/t3-session/extraction'))).filter(file => file.endsWith('.mjs'))
      .map(file => resolve(tools, '../../patches/t3-session/extraction', file)),
    ...(await readdir(resolve(tools, '../../patches/t3-session/session-control'))).filter(file => file.endsWith('.mjs'))
      .map(file => resolve(tools, '../../patches/t3-session/session-control', file)),
  ]
  const eslint = new ESLint({ cwd: resolve(tools, '../..'), overrideConfigFile: true, overrideConfig: configuration })
  const results = await eslint.lintFiles(files)
  const formatter = await eslint.loadFormatter('stylish')
  const output = formatter.format(results)
  if (output) process.stderr.write(output)
  if (results.some(result => result.errorCount || result.warningCount)) throw new Error('Session source lint failed.')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await lintSessionEngineSources()
}
