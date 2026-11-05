#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
identity=${NESSIE_EXECUTOR_SIGNING_IDENTITY:--}

swift build --package-path "$package_dir" --configuration release
helper="$package_dir/.build/release/nessie-executor-vm"
codesign --force --sign "$identity" \
  --entitlements "$package_dir/nessie-executor-vm.entitlements" \
  "$helper"
codesign --verify --strict "$helper"
codesign -d --entitlements :- "$helper" >/dev/null 2>&1
printf '%s\n' "$helper"
