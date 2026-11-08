import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { applySessionEngineBoundaryPatches } from '../../packaging/session-engine/patches.mjs'
import { T3_SESSION_ENGINE_SOURCE } from '../../packaging/session-engine/source.mjs'

/** Immutable objects only; never read the reference checkout's files, dependencies or retained state. */
export const sourceSnapshot = () => {
  const repository = process.env.T3_WORKSPACE_SOURCE_REPOSITORY
  if (!repository) throw new Error('T3_WORKSPACE_SOURCE_REPOSITORY_REQUIRED')
  const git = args => execFileSync('git', ['-C', repository, ...args], { maxBuffer: 8 * 1024 * 1024 })
  const spec = T3_SESSION_ENGINE_SOURCE
  const tree = git(['rev-parse', `${spec.commit}^{tree}`]).toString().trim()
  if (tree !== spec.tree) throw new Error('T3_WORKSPACE_SOURCE_TREE_MISMATCH')
  const files = git(['ls-tree', '-r', '--name-only', spec.commit]).toString().trim().split('\n')
  const cache = new Map()
  const original = {
    identity: { commit: spec.commit, tree }, files,
    read: file => {
      if (!files.includes(file)) throw new Error('T3_WORKSPACE_SOURCE_FILE_MISSING')
      if (!cache.has(file)) cache.set(file, git(['show', `${spec.commit}:${file}`]))
      return Buffer.from(cache.get(file))
    },
  }
  const families = [
    '../../packaging/session-engine/boundary-patches.json',
    '../../patches/t3-session/client-connection/boundary-patches.json',
    '../../patches/t3-session/extraction/boundary-patches.json',
    '../../patches/t3-session/requests/boundary-patches.json',
  ]
  return families.reduce((snapshot, file) => applySessionEngineBoundaryPatches(snapshot,
    readFileSync(new URL(file, import.meta.url))), original)
}
