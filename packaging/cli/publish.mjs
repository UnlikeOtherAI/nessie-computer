// Deliberately absent from the build workflow: publication is an operator action.
import { execFile } from 'node:child_process'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { verifyCandidate } from './candidate.mjs'
import { releaseTag, releaseVersion } from './release-plan.mjs'

const run = promisify(execFile)
const version = releaseVersion()
const directory = resolve(process.argv[2] ?? 'dist/executor-cli')
const repo = 'UnlikeOtherAI/Nessie'
const linux = await verifyCandidate(directory, 'linux', version)
const mac = await verifyCandidate(directory, 'darwin', version)
if (linux.commit !== mac.commit) throw new Error('All platforms must come from the same source revision.')
const json = async (args) => JSON.parse((await run('gh', args)).stdout)
const runs = await json(['api', `repos/${repo}/actions/runs?head_sha=${linux.commit}&event=push&per_page=100`])
for (const path of ['.github/workflows/ci.yml', '.github/workflows/desktop-ci.yml']) {
  const latest = runs.workflow_runs.filter((item) => item.path === path && item.head_branch === 'main')
    .sort((left, right) => right.id - left.id)[0]
  if (latest?.conclusion !== 'success') throw new Error(`The source needs a green main run of ${path}.`)
}
const tagged = await json(['api', `repos/${repo}/commits/${releaseTag(version)}`])
if (tagged.sha !== linux.commit) throw new Error('Create the release tag at the exact verified candidate commit first.')
const files = [...Object.keys(linux.files), ...Object.keys(mac.files),
  'linux-candidate.json', 'darwin-candidate.json'].map((file) => join(directory, file))
await run('gh', ['release', 'create', releaseTag(version), '--repo', repo, '--verify-tag', '--latest=false',
  '--title', `Nessie Executor ${version}`, '--notes',
  'CLI packages for macOS Apple Silicon and Linux x86_64. Installation: https://nessie.works/docs/executor-setup',
  ...files], { maxBuffer: 1024 * 1024 })
process.stdout.write(`Published ${releaseTag(version)}. Apply the generated Homebrew formula through a tap PR, then deploy its signed repository archive.\n`)
