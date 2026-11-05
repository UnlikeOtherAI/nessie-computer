# Contributing

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
