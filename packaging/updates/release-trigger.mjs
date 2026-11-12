// A published version queues the protected-main publisher, never signing from a tag workflow.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function releaseRequest(release) {
  const match = /^executor-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(release?.tag_name ?? '')
  if (!match || release.draft) return undefined
  if (release.immutable !== true) throw new Error('Update releases must be immutable.')
  return { version: match[1], channel: release.prerelease ? 'preview' : 'stable' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const request = releaseRequest(event.release)
  if (request) {
    const repository = 'UnlikeOtherAI/nessie-computer'
    const source = execFileSync('gh', ['api', `repos/${repository}/commits/executor-v${request.version}`, '--jq', '.sha'],
      { encoding: 'utf8' }).trim()
    if (!/^[a-f0-9]{40}$/u.test(source)) throw new Error('Invalid release source.')
    execFileSync('gh', ['workflow', 'run', 'publish-update-catalog.yml', '--repo', repository, '--ref', 'main',
      '-f', `version=${request.version}`, '-f', `channel=${request.channel}`, '-f', `source_commit=${source}`],
    { stdio: 'inherit' })
  }
}
