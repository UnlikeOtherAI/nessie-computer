#!/usr/bin/env node
// Read-only native-provider smoke. Build @nessie/executor first; no conversation content is printed.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExistingSessions } from '../dist/existing-session/manager.js'

const directory = await mkdtemp(join(tmpdir(), 'nessie-native-discovery-'))
const manager = new ExistingSessions(directory)
try {
  const providers = {}
  for (const provider of ['codex', 'claude']) {
    const result = await manager.page(provider)
    providers[provider] = { status: result.providers?.[provider], count: result.sessions.length,
      queue: result.sessions.filter((row) => row.capabilities.queue).length,
      push: result.sessions.filter((row) => row.capabilities.push).length }
  }
  console.log(JSON.stringify({ platform: process.platform, providers }))
  if (Object.values(providers).some((provider) => provider.status === 'unavailable')) process.exitCode = 1
} finally { await manager.close(); await rm(directory, { recursive: true, force: true }) }
