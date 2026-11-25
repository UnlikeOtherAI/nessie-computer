#!/bin/sh
# Build the Intel CLI runtime with a deployment target that includes Monterey.
set -eu
test "$(uname -sm)" = "Darwin x86_64"
destination=${1:?pass an empty build directory}
mkdir -p "$destination"
cd "$destination"
version=24.15.0
source_archive="node-v$version.tar.xz"
curl -fSL --retry 3 "https://nodejs.org/dist/v$version/$source_archive" -o "$source_archive"
echo "a4f653d79ed140aaad921e8c22a3b585ca85cfdab80d4030f6309e4663a8a1c8  $source_archive" | shasum -a 256 -c -
tar -xf "$source_archive"
cd "node-v$version"
python3 - <<'PY'
from pathlib import Path
gyp = Path("common.gypi")
source = gyp.read_text()
target = "'MACOSX_DEPLOYMENT_TARGET': '13.5'"
if source.count(target) != 1:
    raise SystemExit("Review the upstream Node deployment target before building.")
gyp.write_text(source.replace(target, "'MACOSX_DEPLOYMENT_TARGET': '12.0'"))
PY
export MACOSX_DEPLOYMENT_TARGET=12.0
./configure --dest-cpu=x64
make -j"$(sysctl -n hw.logicalcpu)"
mkdir -p ../runtime/bin
cp out/Release/node ../runtime/bin/node
cp LICENSE ../runtime/LICENSE
../runtime/bin/node -p 'process.arch + " " + process.version'
