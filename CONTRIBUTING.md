# Contributing

## Build from source

Use Node 22 and pnpm 10.22.0. No Nessie checkout, database, private Git package
or production signing credential is needed for source verification.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm start --version
```

Native packages need their platform toolchains. Unsigned development builds
cannot hold ChatGPT sign-ins and must never be published or installed as
official releases. Browser journeys run locally and headless, separate from CI
unit tests.

On Windows, build the native ACL helper before running unit tests:
`cargo build --manifest-path native/Cargo.toml`. The test runner puts its own
unmarked Node beside that helper so state-security tests exercise real DACLs
without enabling installed-only update or custody paths. The helper is resolved
only beside that runtime, never through PATH or an environment override. Debug
helpers exercise real Job Objects and ConPTY without the release helper's
installed-factory requirement. This test context never establishes signed
release or credential eligibility.

Automatic updates follow [automatic updates](docs/automatic-updates.md).
Computer telemetry, Claude/Codex account probes, native history and human input
follow [computer data](docs/computer-data.md).

## Intel Mac command line

On an Intel Mac running macOS Monterey 12 or later, build the workspace from
source with the commands above. Run `pnpm start add` to get a pairing code.
In Nessie, open **Computers → Add a computer** in the team that should own it.
Run `pnpm start status` to check the connection. The team can use shared
workspace files and configured MCP servers. Operations that need a guest VM
require a different computer.

Automatic launch at login needs a Developer ID signed CLI installation. The
Intel CLI package build uses an x64 Node 24 runtime and native helper built for
macOS 12. The Apple silicon menu bar app has its own installer.

## Pull requests

Open a focused pull request with the behaviour changed and the checks run.
Use `pnpm verify` for the public TypeScript workspace. Run native tests on the
platform they exercise. UI changes also need local headless browser journeys
and matching before/after captures of the states they visibly change.

Keep files cohesive and under 500 lines. Shared wire contracts belong in
`packages/protocol`; shared transport belongs in `packages/support`. Do not add
dependencies on Nessie's private server packages or duplicate protocol types.

Production signing and publication happen only through protected release
workflows. Source verification does not require those credentials. Do not
commit generated build output, local state, signing tools or secrets.

Contributions are provided under the repository's existing FSL-1.1-ALv2
licence. Preserve third-party copyright and licence notices.
