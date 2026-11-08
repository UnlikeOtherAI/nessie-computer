import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SecretDestinationError, writeSecretToFolder } from '../src/coding-session/secret-destination.js'
import { assertOwnerOnlyStatePath, type StateSecurityCommand } from '../src/state-security.js'

/**
 * The secret writer runs unsandboxed beside an agent that can write in the
 * folder, so these move the folder and its files between the writer's steps
 * the way a racing agent would, and prove nothing outside the folder is read
 * or written.
 */

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-secret-'))
  const folder = join(dir, 'work')
  const outside = join(dir, 'outside')
  await mkdir(folder)
  await mkdir(outside)
  return { dir, folder, outside }
}

const refusedWith = (code: string) => (error: unknown): boolean => (
  error instanceof SecretDestinationError && error.code === code && !error.message.includes('v4lue')
)

test('a secret is written only as a file directly in the session folder, owner-only, never through a link', async () => {
  const { dir, folder, outside } = await scratch()
  try {
    const refused = async (destination: string, code = 'secret_destination_refused'): Promise<void> => {
      await assert.rejects(writeSecretToFolder({ folder, destination, value: 'v4lue-v4lue' }), refusedWith(code))
    }
    for (const destination of ['../escape', 'a/../../escape', '/etc/passwd', 'C:\\x', '', '.', 'bad\u0000name',
      'config/keys/token.txt', 'sub\\token', '.env:hidden', 'trailing.', `${'n'.repeat(201)}`]) {
      await refused(destination, 'secret_destination_invalid')
    }
    await symlink(join(outside, 'target'), join(folder, 'token-link'))
    await refused('token-link')
    await writeFile(join(outside, 'shared'), 'x')
    await link(join(outside, 'shared'), join(folder, 'hard'))
    await refused('hard')
    await mkdir(join(folder, 'dir'))
    await refused('dir')
    assert.deepEqual(await writeSecretToFolder({ folder, destination: 'token.txt', value: 's3cret' }), { destination: 'token.txt' })
    assert.equal(await readFile(join(folder, 'token.txt'), 'utf8'), 's3cret')
    await assertOwnerOnlyStatePath(join(folder, 'token.txt'), 'file')
    await writeFile(join(folder, '.env'), 'A=1\nexport TOKEN=old\n# keep me\nTOKEN=dup\n', { mode: 0o644 })
    await writeSecretToFolder({ folder, destination: './.env', value: 'new value "quoted"', envName: 'TOKEN' })
    assert.equal(await readFile(join(folder, '.env'), 'utf8'), 'A=1\nTOKEN="new value \\"quoted\\""\n# keep me\n')
    await assertOwnerOnlyStatePath(join(folder, '.env'), 'file')
    assert.equal(await readFile(join(outside, 'shared'), 'utf8'), 'x', 'nothing outside the folder changed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a folder swapped for a link after the read is refused, and nothing outside is read or written', async () => {
  const { dir, folder, outside } = await scratch()
  try {
    await writeFile(join(folder, '.env'), 'A=1\n')
    await writeFile(join(outside, '.env'), 'OUTSIDE=private\n')
    // Moved aside and replaced by a link to elsewhere, just after the in-folder file was read.
    const swap = async (): Promise<void> => {
      await rename(folder, join(dir, 'moved'))
      await symlink(outside, folder)
    }
    await assert.rejects(writeSecretToFolder({ folder, destination: '.env', value: 'v4lue-v4lue', envName: 'KEY',
      seams: { afterRead: swap } }), refusedWith('secret_destination_refused'))
    assert.equal(await readFile(join(outside, '.env'), 'utf8'), 'OUTSIDE=private\n', 'the outside file was not replaced')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a folder swapped just before the rename is refused before anything lands outside', async () => {
  const { dir, folder, outside } = await scratch()
  try {
    await writeFile(join(outside, 'token'), 'OUTSIDE')
    const swap = async (): Promise<void> => {
      await rename(folder, join(dir, 'moved'))
      await symlink(outside, folder)
    }
    await assert.rejects(writeSecretToFolder({ folder, destination: 'token', value: 'v4lue-v4lue',
      seams: { beforeRename: swap } }), refusedWith('secret_destination_refused'))
    assert.equal(await readFile(join(outside, 'token'), 'utf8'), 'OUTSIDE')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an in-folder file replaced by a link to an outside file is never copied in', async () => {
  const { dir, folder, outside } = await scratch()
  try {
    await writeFile(join(outside, 'secrets.env'), 'PRIVATE=elsewhere\n')
    await symlink(join(outside, 'secrets.env'), join(folder, '.env'))
    await assert.rejects(writeSecretToFolder({ folder, destination: '.env', value: 'v4lue-v4lue', envName: 'KEY' }),
      refusedWith('secret_destination_refused'))
    assert.equal((await lstat(join(folder, '.env'))).isSymbolicLink(), true, 'the link is left as it was')
    assert.equal(await readFile(join(outside, 'secrets.env'), 'utf8'), 'PRIVATE=elsewhere\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('on Windows the file is made owner-only by the state-security helper and proved so before the value is in it', async () => {
  const { dir, folder } = await scratch()
  try {
    const asked: { command: StateSecurityCommand; size: number }[] = []
    const helper = async (command: StateSecurityCommand, path: string): Promise<void> => {
      const entry = await stat(path)
      asked.push({ command, size: entry.isFile() ? entry.size : 0 })
    }
    await writeSecretToFolder({ folder, destination: '.env.local', value: 'v4lue-v4lue', envName: 'KEY',
      security: { platform: 'win32', helper } })
    assert.deepEqual(asked, [
      { command: 'secure-directory', size: 0 },
      { command: 'secure-owner-only-file', size: 0 },
      { command: 'verify-owner-only-file', size: 0 },
      { command: 'verify-owner-only-file', size: (await stat(join(folder, '.env.local'))).size },
    ])
    const failing = async (command: StateSecurityCommand): Promise<void> => {
      if (command === 'verify-owner-only-file') throw new Error('not owner-only')
    }
    await assert.rejects(writeSecretToFolder({ folder, destination: 'other', value: 'v4lue-v4lue',
      security: { platform: 'win32', helper: failing } }), refusedWith('secret_destination_refused'))
    assert.equal(await stat(join(folder, 'other')).then(() => true, () => false), false, 'nothing is left that is not proved private')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
