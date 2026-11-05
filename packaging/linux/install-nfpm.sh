#!/bin/sh
set -eu
# Pinned publisher archive and digest, shared by local verification and CI.
destination=${1:?Pass a tool directory}
mkdir -p "$destination"
archive="$destination/nfpm_2.47.0_Linux_x86_64.tar.gz"
curl --fail --location --retry 3 --output "$archive" \
  https://github.com/goreleaser/nfpm/releases/download/v2.47.0/nfpm_2.47.0_Linux_x86_64.tar.gz
printf '%s  %s\n' 0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783 "$archive" | sha256sum --check -
tar -xzf "$archive" -C "$destination" nfpm
