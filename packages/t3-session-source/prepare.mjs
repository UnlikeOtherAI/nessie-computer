// Declared Turbo prerequisite; prepares only the frozen public producer, never upstream hooks.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensurePinnedSourceObject } from './cache.mjs'
import { T3_SESSION_ENGINE_SOURCE } from '../../packaging/session-engine/source.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const repository = resolve(root, '.artifacts/source/upstream.git')
await ensurePinnedSourceObject({ repository, upstream: T3_SESSION_ENGINE_SOURCE.repository,
  commit: T3_SESSION_ENGINE_SOURCE.commit })
execFileSync(process.execPath, [resolve(root, '../../packaging/session-engine/prepare-dependencies.mjs'), repository],
  { stdio: 'inherit', windowsHide: true })
