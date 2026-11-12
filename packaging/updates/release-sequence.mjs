import { releaseVersion } from '../cli/release-plan.mjs'

// Idempotent delivery/retry uses the same immutable archive. Never roll a channel backwards.
export function nextSequence(current, version, sourceCommit) {
  releaseVersion(version)
  releaseVersion(current.version)
  const offered = version.split('.').map(BigInt)
  const previous = current.version.split('.').map(BigInt)
  const difference = offered.map((part, index) => part - previous[index]).find(part => part !== 0n) ?? 0n
  if (difference < 0n) throw new Error('A release cannot move the update channel backwards.')
  if (difference === 0n) {
    if (current.sourceCommit !== sourceCommit) throw new Error('An existing version cannot change source.')
    return current.sequence
  }
  if (!Number.isSafeInteger(current.sequence + 1)) throw new Error('Catalogue sequence exhausted.')
  return current.sequence + 1
}
