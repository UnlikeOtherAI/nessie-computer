# Nessie Executor

Public source for the local software that connects a computer to Nessie.
It includes the CLI, Windows service and tray, macOS menu bar app, native
runtime guards, sandbox tools and local controls. Nessie's server and product
repository remain private.

The computer's owner controls local folders and commands. Each paired team has
separate permissions. Provider credentials, pairing keys and local files are
not part of an update check. Read [the security model](SECURITY.md) before
changing native launch, credential custody or installation code.

## Build and check

Use Node 22 and pnpm 10.22.0. No Nessie checkout, database, private Git package
or production signing credential is required for source verification.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm start --version
```

Native packages require their platform toolchains. Unsigned development
artifacts cannot establish personal credential custody and must never be
published or installed as official releases. Browser journeys run locally and
headless; they are deliberately separate from ordinary CI unit tests.

Automatic updates are being built; they are not active in installed releases.
The policy, trust model and remaining delivery gates are in
[automatic updates](docs/automatic-updates.md).

On Windows, build the native ACL helper before running unit tests:
`cargo build --release --manifest-path native/Cargo.toml`. The test runner puts
its own Node beside that helper so state-security tests exercise real DACLs.
This test context never establishes signed release or credential eligibility.

## Licence

This repository uses [FSL-1.1-ALv2](LICENSE), the existing Nessie licence.
It permits use, inspection, modification and redistribution for permitted
purposes, including internal commercial use. Competing commercial offerings
are restricted. Each version becomes available under Apache 2.0 after two
years. This is fair source / source available software.

Bundled third-party components retain their own licences and notices.

Computer telemetry, Claude/Codex account probes, native history and human input follow
[computer data](docs/computer-data.md), including their independent viewer cursor and focused checks.
