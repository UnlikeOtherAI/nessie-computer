#!/usr/bin/env bash
# Builds "Nessie Executor.app" and prints its absolute path as the last line of
# stdout. That contract is what the packaging pipeline consumes: it signs the
# bundle this prints with the configured `Developer ID Application` identity and
# wraps it in a notarized DMG.
#
#   build-app.sh [--configuration Debug|Release] [--output <dir>]
#
# Nothing here signs anything. A build produced by this script is unsigned and is
# never installable — the macOS release-signing policy in
# docs/standards/build-and-release.md owns that step, and an ad-hoc bundle is
# never presented as a release.
#
# Every diagnostic goes to stderr so the last stdout line is always the .app.
set -euo pipefail

configuration=Release
output=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --configuration)
      configuration="${2:?--configuration needs a value}"
      shift 2
      ;;
    --output)
      output="${2:?--output needs a value}"
      shift 2
      ;;
    *)
      echo "Usage: build-app.sh [--configuration Debug|Release] [--output <dir>]" >&2
      exit 2
      ;;
  esac
done

case "$configuration" in
  Debug|Release) ;;
  *)
    echo "build-app.sh: --configuration must be Debug or Release, not ${configuration}." >&2
    exit 2
    ;;
esac

app_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repository_directory="$(cd "${app_directory}/.." && pwd)"
build_directory="${output:-${app_directory}/build}"
mkdir -p "${build_directory}"
build_directory="$(cd "${build_directory}" && pwd)"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "build-app.sh: ${1} is required. ${2}" >&2
    exit 1
  }
}

require xcodegen "Install it with: brew install xcodegen"
require xcodebuild "Install the Xcode command line tools."
require swiftlint "Install it with: brew install swiftlint"
require node "Install Node 22 — it is the runtime this app packages."
require cargo "Install the Rust toolchain — the native custody helper is bundled with this app."

echo "build-app.sh: checking Swift lint…" >&2
swiftlint lint --strict --config "${repository_directory}/.swiftlint.yml" \
  "${app_directory}/Sources" "${app_directory}/Tests" >&2

# The bundled CLI and its pinned Node, laid down by the one producer of that
# layout. Doing it before xcodebuild means the copy phase below always has a
# complete runtime to copy, and a failure here fails the build rather than
# producing an app whose menu says its runtime is missing.
echo "build-app.sh: preparing the packaged executor runtime…" >&2
runtime_directory="${build_directory}/executor-runtime"
node "${app_directory}/scripts/prepare-runtime.mjs" "${runtime_directory}" >&2

echo "build-app.sh: generating the Xcode project…" >&2
xcodegen generate --spec "${app_directory}/project.yml" --project "${app_directory}" >&2

derived_data="${build_directory}/DerivedData"
echo "build-app.sh: building ${configuration}…" >&2
set --
if [[ -n "${NESSIE_EXECUTOR_VERSION:-}" ]]; then
  if [[ ! "${NESSIE_EXECUTOR_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "build-app.sh: NESSIE_EXECUTOR_VERSION must be a numeric release version." >&2
    exit 2
  fi
  set -- "MARKETING_VERSION=${NESSIE_EXECUTOR_VERSION}" "CURRENT_PROJECT_VERSION=${NESSIE_EXECUTOR_VERSION}"
fi
xcodebuild \
  -jobs 2 \
  "$@" \
  -project "${app_directory}/NessieExecutorMenuBar.xcodeproj" \
  -scheme NessieExecutorMenuBar \
  -configuration "${configuration}" \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "${derived_data}" \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO \
  build >&2

app_path="${derived_data}/Build/Products/${configuration}/Nessie Executor.app"
if [[ ! -d "${app_path}" ]]; then
  echo "build-app.sh: xcodebuild produced no app at ${app_path}." >&2
  exit 1
fi

# An app with no icon still builds and runs, and every surface that lists it
# quietly shows the generic application icon instead, so the absence is caught
# here rather than by somebody opening Login Items.
icon_file="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "${app_path}/Contents/Info.plist" 2>/dev/null || true)"
if [[ -z "${icon_file}" || ! -f "${app_path}/Contents/Resources/${icon_file%.icns}.icns" ]]; then
  echo "build-app.sh: the bundle carries no application icon." >&2
  exit 1
fi

# Resources, not a subdirectory of the executable's own folder: the app resolves
# the runtime through `Bundle.main.resourceURL` and nothing else.
resources="${app_path}/Contents/Resources/executor-runtime"
rm -rf "${resources}"
mkdir -p "$(dirname "${resources}")"
cp -R "${runtime_directory}" "${resources}"

for required in nessie-executor-runtime nessie-executor.cjs manifest.json NODE_LICENSE; do
  if [[ ! -f "${resources}/${required}" ]]; then
    echo "build-app.sh: the packaged runtime is missing ${required}." >&2
    exit 1
  fi
done
chmod 0755 "${resources}/nessie-executor-runtime"
mkdir -p "${app_path}/Contents/Library/LaunchDaemons"
cp "${app_directory}/LaunchDaemons/com.unlikeotherai.nessie.executor.updater.plist" \
  "${app_path}/Contents/Library/LaunchDaemons/"

# The bundle is left exactly as xcodebuild produced it: no code signature is
# applied here, not even an ad-hoc one. `CODE_SIGNING_ALLOWED=NO` leaves the
# bundle unsealed, which is why the runtime can be copied in afterwards, and the
# packaging pipeline seals the whole thing once with the real identity.
echo "build-app.sh: done. This bundle is unsigned; the packaging pipeline signs and notarizes it." >&2
echo "${app_path}"
