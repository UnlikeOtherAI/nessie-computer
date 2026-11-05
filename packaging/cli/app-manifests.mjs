import { releaseVersion, RELEASES } from './release-plan.mjs'

export const stableAppTag = (tag) => {
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag ?? '')) {
    throw new Error('App manifests require an immutable vMAJOR.MINOR.PATCH release, never an edge URL.')
  }
  return tag
}
const digest = (value) => {
  if (!/^[a-fA-F0-9]{64}$/.test(value ?? '')) throw new Error('A verified installer SHA-256 is required.')
  return value
}

export const appCask = ({ app, version, tag, sha256 }) => {
  releaseVersion(version)
  stableAppTag(tag)
  digest(sha256)
  const executor = app === 'executor'
  if (!executor && app !== 'desktop') throw new Error('Choose desktop or executor.')
  const token = executor ? 'nessie-executor-app' : 'nessie'
  const name = executor ? 'Nessie Executor' : 'Nessie'
  const asset = executor ? 'Nessie-Executor-macOS-Apple-Silicon.dmg' : 'Nessie-macOS-Apple-Silicon.dmg'
  return `cask "${token}" do
  version "${version}"
  sha256 "${sha256.toLowerCase()}"
  url "${RELEASES}/download/${tag}/${asset}"
  name "${name}"
  desc "${executor ? 'Connect your computer to Nessie with local per-team permissions' : 'Team collaboration with agents that do the work'}"
  homepage "https://nessie.works"
  depends_on arch: :arm64
  depends_on macos: ">= :sequoia"
  depends_on formula: "git"
  depends_on formula: "tmux"
${executor ? '' : '  auto_updates true\n'}
  app "${name}.app"
  # Pairing keys and permissions deliberately survive uninstall; no zap stanza.
end
`
}

export const wingetManifests = ({ version, tag, sha256, productCode }) => {
  releaseVersion(version)
  stableAppTag(tag)
  digest(sha256)
  if (!/^\{[A-Fa-f0-9-]{36}\}$/.test(productCode ?? '')) throw new Error('Read ProductCode from the actual signed MSI.')
  const id = 'UnlikeOtherAI.NessieExecutor'
  const common = `PackageIdentifier: ${id}\nPackageVersion: ${version}\n`
  const schema = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.9.0.schema.json\n`
  return {
    [`${id}.yaml`]: schema('version') + common + 'DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.9.0\n',
    [`${id}.locale.en-US.yaml`]: schema('defaultLocale') + common + `PackageLocale: en-US
Publisher: UnlikeOtherAI
PublisherUrl: https://nessie.works
PackageName: Nessie Executor
PackageUrl: https://nessie.works/docs/executor-setup
License: FSL-1.1-ALv2
LicenseUrl: https://github.com/UnlikeOtherAI/Nessie/blob/${tag}/LICENSE
ShortDescription: Connect your computer to Nessie with local per-team permissions.
Moniker: nessie-executor
ManifestType: defaultLocale
ManifestVersion: 1.9.0
`,
    [`${id}.installer.yaml`]: schema('installer') + common + `InstallerType: wix
Scope: machine
UpgradeBehavior: install
Installers:
  - Architecture: x64
    InstallerUrl: ${RELEASES}/download/${tag}/Nessie-Executor-Windows.msi
    InstallerSha256: ${sha256.toUpperCase()}
    ProductCode: '${productCode}'
    AppsAndFeaturesEntries:
      - DisplayName: Nessie Executor
        Publisher: UnlikeOtherAI
        DisplayVersion: ${version}
        ProductCode: '${productCode}'
ManifestType: installer
ManifestVersion: 1.9.0
`,
  }
}
