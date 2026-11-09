import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { runDocuments } from '../src/cli-documents.js'
import { parseCliOptions } from '../src/cli-options.js'
import type { CliContext } from '../src/cli-output.js'
import type { CliRun } from '../src/cli-user.js'
import { loadFolderSyncConfig } from '../src/folder-sync/config.js'
import { runConsoleCommand } from '../src/folder-sync/sync-command.js'
import { createSyncHarness } from './support/folder-sync-harness.js'

/** `documents on` without `--folder` offers the main folder the app offers. */

test('documents on uses the main folder another team on this computer already syncs into', async (t) => {
  const platform = await createSyncHarness()
  t.after(platform.cleanup)
  const research = await createSyncHarness({ beside: platform })
  research.server.teamLabel = 'Research'
  // Platform syncs into a main folder of its own choosing, not the default one.
  const shared = join(platform.home, 'Team files')
  await mkdir(shared)
  await runConsoleCommand(platform.context, { command: 'configure', root: shared, enabled: true, acceptExistingFiles: true })
  await platform.settle()

  const out: string[] = []
  const run = {
    options: parseCliOptions(['documents', 'on', '--json']),
    context: { home: research.home, out: (text: string) => { out.push(text) } } as unknown as CliContext,
    team: async () => ({ route: 'local', stateDir: research.stateDir, executorId: research.server.executorId,
      label: 'Research · UnlikeOtherAI', state: { workspaceFolders: [] } }),
  } as unknown as CliRun
  await runDocuments(run)
  const config = await loadFolderSyncConfig(research.stateDir)
  assert.equal(config.root, shared)
  assert.equal(config.enabled, true)
  assert.equal((JSON.parse(out.join('')) as { root: string }).root, shared)
})
