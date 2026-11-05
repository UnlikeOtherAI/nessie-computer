import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { archiveName, releaseVersion, REPOSITORY } from './release-plan.mjs'

const run = promisify(execFile)
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

export const candidateFiles = (platform, version) => {
  releaseVersion(version)
  if (platform === 'darwin') return [archiveName(version), `${archiveName(version)}.sha256`, 'Formula/nessie-executor.rb']
  if (platform !== 'linux') throw new Error('Only Linux and macOS CLI releases are supported.')
  return [
    `nessie-executor_${version}_amd64.deb`, `nessie-executor_${version}_x86_64.rpm`,
    `nessie-executor_${version}_repository.tar.gz`, 'nessie-executor.asc', 'SHA256SUMS', 'SHA256SUMS.asc',
  ]
}

export const verifyCandidate = async (directory, platform, version, execute = run) => {
  const manifest = join(directory, `${platform}-candidate.json`)
  const candidate = JSON.parse(await readFile(manifest, 'utf8'))
  if (candidate.version !== releaseVersion(version) || candidate.platform !== platform || candidate.signing !== 'release'
    || !/^[a-f0-9]{40}$/.test(candidate.commit)) {
    throw new Error('Publication requires matching production-signed candidates. Verification builds cannot be published.')
  }
  const files = candidateFiles(platform, version)
  if (Object.keys(candidate.files ?? {}).sort().join() !== [...files].sort().join()) throw new Error('Candidate file set differs from the release contract.')
  for (const file of files) {
    if (candidate.files[file] !== await digest(join(directory, file))) throw new Error(`Candidate file changed: ${file}`)
  }
  // The signed manifest authenticates every payload hash and the signing mode.
  // Neither an edited JSON label nor an attestation from a branch is sufficient.
  await execute('gh', ['attestation', 'verify', manifest, '--repo', 'UnlikeOtherAI/Nessie',
    '--signer-workflow', 'UnlikeOtherAI/Nessie/.github/workflows/executor-cli.yml',
    '--source-ref', 'refs/heads/main', '--source-digest', candidate.commit, '--deny-self-hosted-runners'])
  return candidate
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const platform = process.argv[2]
  const version = releaseVersion()
  const signing = process.env.NESSIE_CLI_SIGNING
  if (!['verification', 'release'].includes(signing)) throw new Error('Declare the candidate signing mode explicitly.')
  const directory = join(REPOSITORY, 'dist/executor-cli')
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY })
  const files = {}
  for (const file of candidateFiles(platform, version)) files[file] = await digest(join(directory, file))
  await writeFile(join(directory, `${platform}-candidate.json`), JSON.stringify({
    platform, version, commit: stdout.trim(), signing, files,
  }, null, 2))
}
