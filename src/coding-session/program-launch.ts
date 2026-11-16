import { readFile, stat } from 'node:fs/promises'
import { win32 } from 'node:path'

import { resolveProgramPath, windowsPathExtensions } from './program-path.js'

const NPM_PREFIX = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n'
const NODE_PREFIX = '\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n'
  + '  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\n'
  + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  '

const file = async (path: string): Promise<boolean> => stat(path).then((entry) => entry.isFile(), () => false)

/** Read npm's fixed forwarding format as data. Never execute a command interpreter. */
const npmLaunch = async (shim: string, env: NodeJS.ProcessEnv): Promise<string[] | undefined> => {
  const size = await stat(shim).then((entry) => entry.isFile() ? entry.size : 0, () => 0)
  if (!size || size > 8192) return undefined
  const text = (await readFile(shim, 'utf8')).replaceAll('\r\n', '\n')
  if (!text.startsWith(NPM_PREFIX)) return undefined
  const body = text.slice(NPM_PREFIX.length)
  const node = body.startsWith(NODE_PREFIX)
  const forward = node ? body.slice(NODE_PREFIX.length) : body
  const target = /^"%dp0%\\(node_modules\\[^"\r\n%]+)" {1,3}%\*\n$/u.exec(forward)?.[1]
  // An absolute path is constructed from literal segments, never shell expansion or traversal.
  if (!target || target.split('\\').some((part) => !part || part === '.' || part === '..' || /[/:\0]/u.test(part))) {
    return undefined
  }
  const entry = win32.join(win32.dirname(shim), target)
  if (!await file(entry)) return undefined
  if (!node) return /\.(?:exe|com)$/iu.test(entry) ? [entry] : undefined
  if (!/\.(?:js|cjs|mjs)$/iu.test(entry)) return undefined
  const adjacentNode = win32.join(win32.dirname(shim), 'node.exe')
  const runtime = await file(adjacentNode) ? adjacentNode : await resolveProgramPath('node', env, 'win32')
  return runtime ? [runtime, entry] : undefined
}

/**
 * The forwarder people write by hand: one line naming one program by its full path, `@"C:\tools\codex.exe" %*`.
 * Read as data like npm's: no variable, no relative path, no second command, and nothing but that program runs.
 */
const forwardedLaunch = async (shim: string): Promise<string[] | undefined> => {
  const size = await stat(shim).then((entry) => entry.isFile() ? entry.size : 0, () => 0)
  if (!size || size > 1024) return undefined
  const text = (await readFile(shim, 'utf8')).replaceAll('\r\n', '\n')
  const target = /^@?"([A-Za-z]:\\[^"%\n\0<>|?*]+\.(?:exe|com))" %\*\n?$/iu.exec(text)?.[1]
  if (!target || target.split('\\').slice(1).some((part) => !part || part === '.' || part === '..'
    || /[/:]/u.test(part))) return undefined
  return await file(target) ? [target] : undefined
}

/**
 * Resolve once for probes and contained launches. Windows npm forwarders become
 * the actual executable and literal argument vector; cwd and shell syntax never
 * participate in discovery. A one-line forwarder to a full path is read the same way; any other script
 * remains unsupported.
 */
export const resolveProgramLaunch = async (
  command: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
): Promise<string[] | undefined> => {
  if (!command[0]) return undefined
  const extensions = windowsPathExtensions(env).filter((extension) => ['.com', '.exe', '.cmd'].includes(extension))
  const program = await resolveProgramPath(command[0], env, platform, extensions)
  if (!program) return undefined
  if (platform !== 'win32') return [program, ...command.slice(1)]
  if (/\.cmd$/iu.test(program)) {
    const launch = await npmLaunch(program, env) ?? await forwardedLaunch(program)
    return launch ? [...launch, ...command.slice(1)] : undefined
  }
  if (!/\.(?:exe|com)$/iu.test(program)) return undefined
  return [program, ...command.slice(1)]
}
