#!/usr/bin/env bash
# Builds the Hyper-V guest kernel: a bzImage with the EFI stub, the Hyper-V
# drivers, and the built-in command line the firmware cannot supply.
#
#   build.sh <output-directory> [source-tarball]
#
# Runs on Linux with a C toolchain, flex, bison, bc, libelf and libssl headers.
# The source is the exact tarball PIN names, verified against the SHA-256
# kernel.org publishes before a byte is extracted; with no tarball given it is
# downloaded. Nothing else about the build is left to the machine: the base is
# the in-tree `x86_64_defconfig`, `config` is merged over it, and
# `make olddefconfig` resolves the rest, so the same source and the same
# fragment give the same configuration everywhere.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${here}/PIN"

output="${1:?usage: build.sh <output-directory> [source-tarball]}"
tarball="${2:-}"
jobs="${KERNEL_BUILD_JOBS:-$(nproc)}"

mkdir -p "${output}"
output="$(cd "${output}" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

if [ -z "${tarball}" ]; then
  tarball="${work}/linux-${KERNEL_VERSION}.tar.xz"
  curl --fail --silent --show-error --location --output "${tarball}" "${KERNEL_URL}"
fi

echo "${KERNEL_SHA256}  ${tarball}" | sha256sum --check --status || {
  echo "the guest kernel source does not match the digest PIN records" >&2
  exit 1
}

tar --extract --file "${tarball}" --directory "${work}"
source_directory="${work}/linux-${KERNEL_VERSION}"

# `make bzImage` builds only what is built in, so the `=m` drivers
# x86_64_defconfig carries cost nothing: they are never compiled and never
# shipped, and everything this guest needs is forced to `=y` by the fragment.
make --directory "${source_directory}" --jobs "${jobs}" x86_64_defconfig
"${source_directory}/scripts/kconfig/merge_config.sh" \
  -m -O "${source_directory}" \
  "${source_directory}/.config" "${here}/config"
make --directory "${source_directory}" --jobs "${jobs}" olddefconfig

# Every option the fragment asked for must actually be set. merge_config.sh
# warns about a value it could not honour and carries on, and a kernel with no
# EFI stub or no Hyper-V socket does not fail until a guest silently never
# boots.
for required in CONFIG_EFI_STUB CONFIG_CMDLINE_BOOL CONFIG_HYPERV \
  CONFIG_HYPERV_STORAGE CONFIG_HYPERV_VSOCKETS CONFIG_VSOCKETS CONFIG_EXT4_FS \
  CONFIG_OVERLAY_FS CONFIG_BLK_DEV_INITRD CONFIG_SYSFS CONFIG_BLK_DEV_SD \
  CONFIG_EFI_GENERIC_STUB_INITRD_CMDLINE_LOADER; do
  grep --quiet "^${required}=y$" "${source_directory}/.config" || {
    echo "${required} is not set in the resolved configuration" >&2
    exit 1
  }
done
grep --quiet '^CONFIG_CMDLINE="console=ttyS0 ' "${source_directory}/.config" || {
  echo "the built-in command line was not applied" >&2
  exit 1
}

make --directory "${source_directory}" --jobs "${jobs}" bzImage

install -m 0644 "${source_directory}/arch/x86/boot/bzImage" "${output}/bzImage"
install -m 0644 "${source_directory}/.config" "${output}/bzImage.config"
sha256sum "${output}/bzImage" | tee "${output}/bzImage.sha256"
