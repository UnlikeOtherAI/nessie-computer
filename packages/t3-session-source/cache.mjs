import { execFileSync } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

const git = (repository, args) => execFileSync('git', ['--no-replace-objects', '--git-dir', repository, ...args], {
  stdio: 'pipe', windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024,
})

/** An interrupted fetch leaves a valid, reusable bare repo. Never discard it. */
export const ensurePinnedSourceObject = async ({ repository, upstream, commit }) => {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw Error('CONTRACT_COMMIT_INVALID')
  const present = await stat(repository).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (!present) {
    await mkdir(dirname(repository), { recursive: true })
    execFileSync('git', ['init', '--bare', repository], { stdio: 'pipe', windowsHide: true })
  }
  const hasCommit = () => {
    try { return git(repository, ['cat-file', '-t', commit]).toString().trim() === 'commit' }
    catch { return false }
  }
  if (!hasCommit()) git(repository, ['fetch', '--depth=1', upstream, commit])
  if (!hasCommit() || git(repository, ['rev-parse', '--verify', `${commit}^{commit}`]).toString().trim() !== commit) {
    throw Error('CONTRACT_COMMITTED_OBJECT_REQUIRED')
  }
}
