import { randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { renameWithRetry } from './file-rename.js'

import { secureOwnerOnlyStateFile, type StateSecurityDeps } from './state-security.js'

/** Atomic private text replacement: write a sibling, flush, secure, rename. */
export const replaceOwnerOnlyText = async (
  path: string, text: string, security: StateSecurityDeps = {},
): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.new`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await secureOwnerOnlyStateFile(temporaryPath, security)
    await renameWithRetry(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

/** Atomic private JSON replacement shared by paired and pending machine state. */
export const replaceOwnerOnlyJson = async (
  path: string, value: unknown, security: StateSecurityDeps = {},
): Promise<void> => replaceOwnerOnlyText(path, `${JSON.stringify(value)}\n`, security)
