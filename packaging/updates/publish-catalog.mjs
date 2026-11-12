// Protected-main release entry point. No package signing credential leaves its OS.
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { releaseVersion } from '../cli/release-plan.mjs'
import { publishCatalog } from './catalog-history.mjs'

const repository = 'UnlikeOtherAI/nessie-computer'
const execute = promisify(execFile)

export const githubCatalogPublisher = async (directory) => {
  await mkdir(directory, { recursive: true })
  let download = 0
  let saved
  const gh = args => execute('gh', args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'EXECUTOR_UPDATE_SIGNING_KEY')) })
  const api = async path => JSON.parse((await gh(['api', path])).stdout)
  const file = async envelope => {
    if (saved !== undefined) {
      if (saved !== envelope) throw new Error('A publication cannot substitute signed catalog bytes.')
    } else {
      await writeFile(join(directory, 'catalog.json'), envelope, { flag: 'wx', mode: 0o600 })
      saved = envelope
    }
    return join(directory, 'catalog.json')
  }
  return {
    async assertSource(sourceCommit) {
      const comparison = await api('repos/' + repository + '/compare/' + sourceCommit + '...main')
      if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('The source must be on protected main.')
      const runs = await api('repos/' + repository + '/actions/runs?head_sha=' + sourceCommit + '&event=push&per_page=100')
      const latest = runs.workflow_runs.filter(run => run.path === '.github/workflows/ci.yml' && run.head_branch === 'main')
        .sort((a, b) => b.id - a.id)[0]
      if (latest?.conclusion !== 'success') throw new Error('The source needs its successful main CI run.')
    },
    async getRelease(tag) {
      let release
      try { release = await api('repos/' + repository + '/releases/tags/' + tag) }
      catch (error) {
        let status
        try { status = JSON.parse(error.stdout).status } catch { /* No authenticated 404 answer. */ }
        if (status === '404') return undefined
        throw new Error('GitHub could not read the release: ' + tag)
      }
      return { ...release, hasCatalog: release.assets.some(asset => asset.name === 'catalog.json') }
    },
    async verifyTag(tag, sourceCommit) {
      if ((await api('repos/' + repository + '/commits/' + tag)).sha !== sourceCommit) {
        throw new Error('The release tag differs from its declared source: ' + tag)
      }
    },
    async readCatalog(tag) {
      const target = join(directory, 'download-' + ++download)
      await mkdir(target)
      await gh(['release', 'download', tag, '--repo', repository, '--pattern', 'catalog.json', '--dir', target])
      return readFile(join(target, 'catalog.json'), 'utf8')
    },
    async archiveCatalog({ tag, sourceCommit, envelope, existing }) {
      const catalog = await file(envelope)
      if (!existing) {
        await gh(['release', 'create', tag, '--repo', repository, '--target', sourceCommit,
          '--draft', '--prerelease', '--latest=false', '--title', tag,
          '--notes', 'Signed executor update metadata. The catalog binds versioned packages, hashes and source.',
          catalog])
      } else if (!existing.hasCatalog) {
        await gh(['release', 'upload', tag, catalog, '--repo', repository])
      }
      await gh(['release', 'edit', tag, '--repo', repository, '--draft=false'])
    },
    async replaceChannelCatalog(tag, envelope) {
      await gh(['release', 'upload', tag, await file(envelope), '--repo', repository, '--clobber'])
    },
  }
}

async function main() {
  const [assets, output] = process.argv.slice(2)
  if (!assets || !output || process.argv.length !== 4) {
    throw new Error('Usage: pnpm exec tsx packaging/updates/publish-catalog.mjs <assets> <work-directory>')
  }
  const { CHANNEL: channel, VERSION: version, SOURCE_COMMIT: sourceCommit, SEQUENCE } = process.env
  releaseVersion(version)
  const sequence = Number(SEQUENCE)
  if (!['stable', 'preview'].includes(channel) || !/^[a-f0-9]{40}$/u.test(sourceCommit ?? '')
    || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid catalog release inputs.')
  const github = await githubCatalogPublisher(resolve(output))
  await github.assertSource(sourceCommit)
  const result = await publishCatalog({ directory: resolve(assets), channel, version, sourceCommit, sequence,
    days: Number(process.env.VALID_DAYS ?? '30'), privateKey: process.env.EXECUTOR_UPDATE_SIGNING_KEY }, github)
  process.stdout.write('Published ' + result.archiveTag + '; SHA-256 ' + result.sha256
    + (result.reused ? ' (reused immutable bytes).\n' : '.\n'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    process.stderr.write((error instanceof Error && !error.message.includes('-----BEGIN')
      ? error.message : 'Catalog publication failed.') + '\n')
    process.exitCode = 1
  })
}
