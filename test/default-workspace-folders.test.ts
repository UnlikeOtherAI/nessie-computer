import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultExecutorWorkspaceFolders } from '../src/default-workspace-folders.js'

const probe = (platform: NodeJS.Platform, home: string) => {
  const made: string[] = []
  return { made, probe: { home, platform, makeDirectory: async (path: string) => { made.push(path) } } }
}

// One folder, because a guest VM mounts exactly one: two would make the guest
// browser, sandboxed commands and coding.launch refuse from the first minute.
for (const [platform, home, nessie] of [
  ['darwin', '/Users/person', '/Users/person/Nessie'],
  ['win32', 'C:\\Users\\person', 'C:\\Users\\person\\Nessie'],
  ['linux', '/home/person', '/home/person/Nessie'],
] as const) {
  test(`a new pairing on ${platform} gets the Nessie folder alone, created on first use`, async () => {
    const { made, probe: host } = probe(platform, home)
    assert.deepEqual(await defaultExecutorWorkspaceFolders(host), [{ name: 'nessie', path: nessie }])
    assert.deepEqual(made, [nessie])
  })
}
