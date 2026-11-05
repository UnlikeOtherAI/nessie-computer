import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { releaseVersion, REPOSITORY, PACKAGE_SITE } from '../cli/release-plan.mjs'

const run = promisify(execFile)
const version = releaseVersion()
const fingerprint = process.env.NESSIE_REPOSITORY_SIGNING_FINGERPRINT
if (!fingerprint || !/^[A-F0-9]{40}$/.test(fingerprint)) throw new Error('Provide the full repository signing-key fingerprint.')
const output = resolve(process.env.NESSIE_PACKAGE_DIRECTORY ?? join(REPOSITORY, 'dist/executor-cli'))
const site = join(output, 'repository')
// A candidate is one complete repository snapshot, never a merge of old builds.
await rm(site, { recursive: true, force: true })
const apt = join(site, 'apt')
const rpm = join(site, 'rpm')
await mkdir(join(apt, 'pool/main'), { recursive: true })
await mkdir(join(apt, 'dists/stable/main/binary-amd64'), { recursive: true })
await mkdir(rpm, { recursive: true })
const debFile = `nessie-executor_${version}_amd64.deb`
const rpmFile = `nessie-executor_${version}_x86_64.rpm`
await copyFile(join(output, debFile), join(apt, 'pool/main', debFile))
await copyFile(join(output, rpmFile), join(rpm, rpmFile))
// Both repository metadata and the RPM package carry signatures.
await run('rpmkeys', ['--checksig', join(rpm, rpmFile)]).then(({ stdout }) => {
  if (!stdout.includes('signatures OK')) throw new Error('The RPM needs a trusted package signature before publication.')
})
const packages = await run('apt-ftparchive', ['packages', 'pool'], { cwd: apt })
await writeFile(join(apt, 'dists/stable/main/binary-amd64/Packages'), packages.stdout)
const release = await run('apt-ftparchive', [
  '-o', 'APT::FTPArchive::Release::Origin=Nessie',
  '-o', 'APT::FTPArchive::Release::Label=Nessie Executor',
  '-o', 'APT::FTPArchive::Release::Suite=stable',
  '-o', 'APT::FTPArchive::Release::Codename=stable',
  '-o', 'APT::FTPArchive::Release::Architectures=amd64',
  '-o', 'APT::FTPArchive::Release::Components=main',
  'release', 'dists/stable',
], { cwd: apt })
const releasePath = join(apt, 'dists/stable/Release')
await writeFile(releasePath, release.stdout)
const gpg = async (args) => run('gpg', ['--batch', '--yes', '--local-user', fingerprint, ...args])
await gpg(['--clearsign', '--output', join(apt, 'dists/stable/InRelease'), releasePath])
await gpg(['--armor', '--detach-sign', '--output', `${releasePath}.gpg`, releasePath])
await run('createrepo_c', [rpm])
await gpg(['--armor', '--detach-sign', '--output', join(rpm, 'repodata/repomd.xml.asc'), join(rpm, 'repodata/repomd.xml')])
const key = await run('gpg', ['--armor', '--export', fingerprint])
await writeFile(join(site, 'nessie-executor.asc'), key.stdout)
await writeFile(join(output, 'nessie-executor.asc'), key.stdout)
await writeFile(join(site, 'CNAME'), 'packages.nessie.works\n')
await writeFile(join(site, '.nojekyll'), '')
await writeFile(join(site, 'nessie-executor.repo'), `[nessie-executor]
name=Nessie Executor
baseurl=${PACKAGE_SITE}/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=${PACKAGE_SITE}/nessie-executor.asc
`)
await writeFile(join(site, 'index.html'), '<!doctype html><title>Nessie Executor packages</title><a href="https://nessie.works/docs/executor-setup">Installation instructions</a>\n')
await writeFile(join(site, 'version.json'), JSON.stringify({ version, fingerprint }))
await run('tar', ['-czf', join(output, `nessie-executor_${version}_repository.tar.gz`), '-C', site, '.'])
const sums = []
for (const file of [debFile, rpmFile, `nessie-executor_${version}_repository.tar.gz`].sort()) {
  sums.push(`${createHash('sha256').update(await readFile(join(output, file))).digest('hex')}  ${file}`)
}
await writeFile(join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`)
await gpg(['--armor', '--detach-sign', '--output', join(output, 'SHA256SUMS.asc'), join(output, 'SHA256SUMS')])
process.stdout.write(`${site}\n`)
