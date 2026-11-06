import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const RELEASES = 'https://github.com/UnlikeOtherAI/nessie-executor/releases'
export const PACKAGE_SITE = 'https://packages.nessie.works'

export const releaseVersion = (value = process.env.NESSIE_EXECUTOR_VERSION) => {
  if (!value || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Set NESSIE_EXECUTOR_VERSION to a stable three-part version, for example 1.0.0.')
  }
  return value
}

export const releaseTag = (version) => `executor-v${releaseVersion(version)}`
export const archiveName = (version) => `nessie-executor_${releaseVersion(version)}_darwin_arm64.tar.gz`

export const homebrewFormula = (version, sha256) => {
  releaseVersion(version)
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('The macOS archive needs its SHA-256 digest.')
  return `class NessieExecutor < Formula
  desc "Pair your computer with Nessie and manage its local resources"
  homepage "https://nessie.works/docs/executor-setup"
  url "${RELEASES}/download/${releaseTag(version)}/${archiveName(version)}"
  version "${version}"
  sha256 "${sha256}"
  license "FSL-1.1-ALv2"
  depends_on arch: :arm64
  depends_on macos: :sequoia
  depends_on "git"
  depends_on "tmux"

  def install
    libexec.install "runtime"
    (bin/"nessie-executor").write <<~SH
      #!/bin/sh
      unset NODE_OPTIONS NODE_PATH
      export NESSIE_EXECUTOR_PACKAGED_CLI=1
      export NESSIE_EXECUTOR_LAUNCHER="#{opt_bin}/nessie-executor"
      exec "#{opt_libexec}/runtime/nessie-executor-runtime" "#{opt_libexec}/runtime/nessie-executor.cjs" "$@"
    SH
    (bin/"nessie-executor").chmod 0755
  end

  def caveats
    <<~EOS
      Pair a team: nessie-executor login --api nessie --workspace /path/to/work
      Each team has its own launchd service and local permissions.
      List teams: nessie-executor teams
      Stop startup: nessie-executor disable <executor-id>
      Pairing keys and permissions are kept outside the Homebrew Cellar.
      Uninstalling this formula does not revoke or erase paired teams.
    EOS
  end

  test do
    assert_equal "nessie-executor ${version}", shell_output("#{bin}/nessie-executor --version").strip
    assert_equal "[]", shell_output("#{bin}/nessie-executor teams --json --state-root #{testpath}/state").strip
  end
end
`
}

export const linuxPackage = (version, payload, format, signingKey) => {
  releaseVersion(version)
  if (!['deb', 'rpm'].includes(format)) throw new Error('Package format must be deb or rpm.')
  return {
    name: 'nessie-executor', arch: 'amd64', platform: 'linux', version,
    maintainer: 'Nessie <desktop@nessie.works>', homepage: 'https://nessie.works',
    description: 'Nessie executor CLI with per-team local permissions and systemd user services.',
    license: 'FSL-1.1-ALv2',
    depends: format === 'deb'
      ? ['libc6 (>= 2.31)', 'libgcc-s1', 'libstdc++6', 'systemd', 'git', 'tmux', 'ca-certificates', 'gpgv']
      : ['glibc >= 2.31', 'libgcc', 'libstdc++', 'systemd', 'git', 'tmux', 'ca-certificates', 'gnupg2'],
    contents: [{ src: `${payload}/usr/`, dst: '/usr', type: 'tree' }],
    scripts: { postinstall: `${payload}/install-custody-barrier.sh` },
    rpm: { compression: 'gzip', ...(signingKey ? { signature: { key_file: signingKey } } : {}) },
  }
}
