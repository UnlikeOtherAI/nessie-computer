#!/bin/sh
# Run inside a disposable native Linux container with the signed repository at /packages.
set -eu
format="${1:?deb or rpm}"
version="${2:?version}"
if [ "$format" = deb ]; then
  install -d -m0755 /etc/apt/keyrings
  cp /packages/nessie-executor.asc /etc/apt/keyrings/nessie-executor.asc
  printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/nessie-executor.asc] file:/packages/apt stable main' > /etc/apt/sources.list.d/nessie-executor.list
  apt-get update
  apt-get install -y "nessie-executor=$version"
elif [ "$format" = rpm ]; then
  cat > /etc/yum.repos.d/nessie-executor.repo <<'REPO'
[nessie-executor]
name=Nessie Executor verification
baseurl=file:///packages/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=file:///packages/nessie-executor.asc
REPO
  # Minimal Fedora images do not include runuser, which this user-flow fixture needs.
  dnf install -y util-linux
  dnf install -y "nessie-executor-$version"
else
  echo 'Choose deb or rpm.' >&2
  exit 1
fi
test "$(NODE_OPTIONS=--invalid-option nessie-executor --version)" = "nessie-executor $version"
useradd --create-home nessie-package-test
test "$(runuser -u nessie-package-test -- nessie-executor teams --json)" = '[]'
release=$(readlink -f /usr/lib/nessie-executor/current)
test "$(stat -c '%U:%G' "$release/nessie-executor-runtime")" = root:root
test "$(stat -c '%a' "$release/nessie-executor-runtime")" = 555
test "$(stat -c '%a' "$release/nessie-executor.cjs")" = 444
test "$(sha256sum "$release/manifest.json" | cut -d' ' -f1)" = "$(basename "$release")"
test -x "$release/nessie-executor-native"
test -f /usr/lib/systemd/user/nessie-executor@.service
# Machine custody is durable local state, not package content. Removal must
# preserve the same fixed admission inode, including unresolved public claims.
barrier_inode=$(stat -c '%d:%i' /var/lib/nessie-executor/custody-admission.lock)
test "$(stat -c '%U:%G:%a' /var/lib/nessie-executor/custody-admission.lock)" = root:root:644
# A package removal must not erase a user's local state.
runuser -u nessie-package-test -- mkdir -p /home/nessie-package-test/.local/state/nessie-executor
runuser -u nessie-package-test -- touch /home/nessie-package-test/.local/state/nessie-executor/preserve-me
if [ "$format" = deb ]; then apt-get remove -y nessie-executor; else dnf remove -y nessie-executor; fi
test -f /home/nessie-package-test/.local/state/nessie-executor/preserve-me
test "$(stat -c '%d:%i' /var/lib/nessie-executor/custody-admission.lock)" = "$barrier_inode"
echo "PASS: $format $version installed with repository signature verification, ran as a user, and preserved state on removal."
