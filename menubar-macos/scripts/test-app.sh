#!/usr/bin/env bash
# The app's unit tests: the logic that decides a menu state, a CLI argument
# vector, an approved API origin and a permitted program, all without a GUI, a
# window server or a host application.
#
#   test-app.sh [--configuration Debug|Release]
set -euo pipefail

configuration=Debug
while [[ $# -gt 0 ]]; do
  case "$1" in
    --configuration)
      configuration="${2:?--configuration needs a value}"
      shift 2
      ;;
    *)
      echo "Usage: test-app.sh [--configuration Debug|Release]" >&2
      exit 2
      ;;
  esac
done

app_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
xcodegen generate --spec "${app_directory}/project.yml" --project "${app_directory}"
exec xcodebuild test \
  -project "${app_directory}/NessieExecutorMenuBar.xcodeproj" \
  -scheme NessieExecutorMenuBar \
  -configuration "${configuration}" \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "${app_directory}/build/DerivedData" \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO
