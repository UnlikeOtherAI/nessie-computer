import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import test from 'node:test'

import { fsPath } from '../src/folder-sync/local-fs.js'
import { createSyncHarness } from './support/folder-sync-harness.js'

const require = createRequire(import.meta.url)
const fsp = require('node:fs/promises') as typeof import('node:fs/promises')

for (const code of ['EACCES', 'EIO']) {
  test(`an unreadable synced directory (${code}) never archives its children`, async (t) => {
    const h = await createSyncHarness()
    t.after(h.cleanup)
    const folder = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'folder', title: 'Folder' })
    const child = h.server.actor.create({ spaceId: h.space.id, parentPageId: folder.id, kind: 'file', title: 'a.txt', content: 'kept' })
    await h.enable()
    await h.settle()
    const original = fsp.readdir
    fsp.readdir = (async (...args: Parameters<typeof original>) => {
      if (String(args[0]) === fsPath(h.path('Projects/Folder'))) throw Object.assign(new Error('Unreadable'), { code })
      return original(...args)
    }) as typeof original
    syncBuiltinESMExports()
    try {
      await assert.rejects(h.pass(), (error: NodeJS.ErrnoException) => error.code === code)
      assert.equal(h.server.pages.get(child.id)!.status, 'live')
      assert.equal(await h.read('Projects/Folder/a.txt'), 'kept')
    } finally {
      fsp.readdir = original
      syncBuiltinESMExports()
    }
    await h.settle()
    assert.equal(h.server.pages.get(child.id)!.status, 'live', 'read access recovery resumes safely')
  })
}
