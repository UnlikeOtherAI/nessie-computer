import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultExecutorWorkspaceFolders, type DefaultFolderProbe } from '../src/default-workspace-folders.js'

const probe = (overrides: Partial<DefaultFolderProbe>, directories: string[] = []) => {
  const made: string[] = []
  return {
    made,
    probe: {
      environment: {},
      home: '/home/person',
      platform: 'linux' as NodeJS.Platform,
      isDirectory: async (path: string) => directories.includes(path),
      makeDirectory: async (path: string) => { made.push(path) },
      readText: async () => null,
      ...overrides,
    },
  }
}

test('macOS offers a Nessie folder in the home directory and /Users/Shared', async () => {
  const { made, probe: host } = probe({ platform: 'darwin', home: '/Users/person' }, ['/Users/Shared'])
  assert.deepEqual(await defaultExecutorWorkspaceFolders(host), [
    { name: 'nessie', path: '/Users/person/Nessie' },
    { name: 'shared', path: '/Users/Shared' },
  ])
  assert.deepEqual(made, ['/Users/person/Nessie'])
})

test('Windows offers the Public folder', async () => {
  const { probe: host } = probe({
    platform: 'win32', home: 'C:\\Users\\person', environment: { PUBLIC: 'C:\\Users\\Public' },
  }, ['C:\\Users\\Public'])
  assert.deepEqual((await defaultExecutorWorkspaceFolders(host)).map((folder) => folder.path), [
    'C:\\Users\\person\\Nessie', 'C:\\Users\\Public',
  ])
})

test('Linux follows xdg-user-dirs and never shares the home directory itself', async () => {
  const configured = probe({
    environment: { XDG_CONFIG_HOME: '/config' },
    readText: async (path) => (path === '/config/user-dirs.dirs'
      ? '# written by xdg-user-dirs-update\nXDG_PUBLICSHARE_DIR="$HOME/Veřejné"\n' : null),
  }, ['/home/person/Veřejné'])
  assert.deepEqual((await defaultExecutorWorkspaceFolders(configured.probe)).at(-1),
    { name: 'shared', path: '/home/person/Veřejné' })

  const disabled = probe({ readText: async () => 'XDG_PUBLICSHARE_DIR="$HOME/"\n' }, ['/home/person'])
  assert.deepEqual(await defaultExecutorWorkspaceFolders(disabled.probe), [
    { name: 'nessie', path: '/home/person/Nessie' },
  ])
})

test('a headless Linux account without a Public folder gets the Nessie folder alone', async () => {
  const { probe: host } = probe({})
  assert.deepEqual(await defaultExecutorWorkspaceFolders(host), [{ name: 'nessie', path: '/home/person/Nessie' }])
})
