import { releaseVersion, RELEASES } from './release-plan.mjs'

export const stableAppTag = (tag) => {
  if (!/^(?:executor-)?v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag ?? '')) {
    throw new Error('App manifests require an immutable vMAJOR.MINOR.PATCH release, never an edge URL.')
  }
  return tag
}
const digest = (value) => {
  if (!/^[a-fA-F0-9]{64}$/.test(value ?? '')) throw new Error('A verified installer SHA-256 is required.')
  return value
}

const releaseBase = (repository) => {
  if (!['UnlikeOtherAI/nessie-executor', 'UnlikeOtherAI/Nessie'].includes(repository)) {
    throw new Error('Choose an official executor or Desktop release repository.')
  }
  return `https://github.com/${repository}/releases`
}

export const appCask = ({ app, version, tag, sha256, releaseRepository }) => {
  releaseVersion(version)
  stableAppTag(tag)
  digest(sha256)
  const executor = app === 'executor'
  if (!executor && app !== 'desktop') throw new Error('Choose desktop or executor.')
  const token = executor ? 'nessie-executor-app' : 'nessie'
  const name = executor ? 'Nessie Computer' : 'Nessie'
  // The bundle keeps its folder name: updates and custody find it there.
  const bundle = executor ? 'Nessie Executor' : 'Nessie'
  const asset = executor ? 'Nessie-Executor-macOS-Apple-Silicon.dmg' : 'Nessie-macOS-Apple-Silicon.dmg'
  const releases = releaseBase(releaseRepository ?? (executor ? 'UnlikeOtherAI/nessie-executor' : 'UnlikeOtherAI/Nessie'))
  return `cask "${token}" do
  version "${version}"
  sha256 "${sha256.toLowerCase()}"
  url "${releases}/download/${tag}/${asset}"
  name "${name}"
  desc "${executor ? 'Connect your computer to Nessie with local per-team permissions' : 'Team collaboration with agents that do the work'}"
  homepage "https://nessie.works"
  depends_on arch: :arm64
  depends_on macos: ">= :sequoia"
  depends_on formula: "git"
  depends_on formula: "tmux"
${executor ? '' : '  auto_updates true\n'}
  app "${bundle}.app"
  # Pairing keys and permissions deliberately survive uninstall; no zap stanza.
end
`
}

export const wingetManifests = ({ version, tag, sha256, productCode, releaseRepository, licenseRevision = tag }) => {
  releaseVersion(version)
  stableAppTag(tag)
  digest(sha256)
  if (licenseRevision !== tag && !/^[a-f0-9]{40}$/.test(licenseRevision)) throw new Error('Use the reviewed public source revision.')
  const releases = releaseRepository ? releaseBase(releaseRepository) : RELEASES
  if (!/^\{[A-Fa-f0-9-]{36}\}$/.test(productCode ?? '')) throw new Error('Read ProductCode from the actual signed MSI.')
  const id = 'UnlikeOtherAI.NessieExecutor'
  const common = `PackageIdentifier: ${id}\nPackageVersion: ${version}\n`
  const schema = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.9.0.schema.json\n`
  return {
    [`${id}.yaml`]: schema('version') + common + 'DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.9.0\n',
    [`${id}.locale.en-US.yaml`]: schema('defaultLocale') + common + `PackageLocale: en-US
Publisher: UnlikeOtherAI
PublisherUrl: https://nessie.works
PackageName: Nessie Computer
PackageUrl: https://nessie.works/docs/executor-setup
License: FSL-1.1-ALv2
LicenseUrl: https://github.com/UnlikeOtherAI/nessie-executor/blob/${licenseRevision}/LICENSE
ShortDescription: Connect your computer to Nessie with local per-team permissions.
Moniker: nessie-computer
ManifestType: defaultLocale
ManifestVersion: 1.9.0
`,
    [`${id}.installer.yaml`]: schema('installer') + common + `InstallerType: wix
Scope: machine
UpgradeBehavior: install
Commands:
  - nessie-computer
  - nessie-executor
Installers:
  - Architecture: x64
    InstallerUrl: ${releases}/download/${tag}/Nessie-Executor-Windows.msi
    InstallerSha256: ${sha256.toUpperCase()}
    ProductCode: '${productCode}'
    AppsAndFeaturesEntries:
      - DisplayName: Nessie Computer
        Publisher: UnlikeOtherAI
        DisplayVersion: ${version}
        ProductCode: '${productCode}'
ManifestType: installer
ManifestVersion: 1.9.0
`,
  }
}
