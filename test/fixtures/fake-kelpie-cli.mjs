#!/usr/bin/env node
/**
 * A stand-in for Kelpie's CLI (`node …/packages/cli/bin/kelpie.js`), so
 * detection can be run as a real process through the same command shapes a
 * policy names: `node <script> mcp`, a `kelpie.cmd` shim on Windows, and the
 * alias-pinned `--browser <alias> mcp`.
 *
 * It answers only `[--browser <alias>] describe --json --scan-timeout 5000`,
 * and exits 2 for anything else, the way the real CLI rejects an unknown
 * command. The answer is the shape Kelpie CLI 0.1.12 printed for an
 * alias-pinned Windows browser — found only through its loopback probe, with
 * no display size and `paired: false` — with the device's model reporting what
 * environment describe was given.
 */
const args = process.argv.slice(2)
let alias
if (args[0] === '--browser') {
  alias = args[1]
  args.splice(0, 2)
}
if (args.join(' ') !== 'describe --json --scan-timeout 5000') {
  process.stderr.write(`unknown command: ${args.join(' ')}\n`)
  process.exit(2)
}

const device = {
  id: alias ? 'local:127.0.0.1:8420' : 'kelpie-mac-1',
  name: alias ?? 'Unpinned Kelpie',
  // Which environment describe ran in: the policy's own KELPIE_HOME, and
  // whether a variable of the daemon's that the MCP session never sees leaked.
  model: `home=${process.env.KELPIE_HOME ?? 'unset'} leak=${process.env.NESSIE_TEST_DAEMON_ONLY ?? 'unset'}`,
  platform: alias ? 'windows' : 'macos',
  version: '0.1.1',
  address: '127.0.0.1',
  port: 8420,
  display: { width: 0, height: 0 },
  paired: false,
  lastSeenAt: '2026-09-22T21:37:56.146Z',
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  cli: { version: '0.1.12' },
  mcp: { available: true, serverVersion: '0.1.0' },
  tools: { count: alias ? 94 : 157 },
  discovery: { scanTimeoutMs: 5000, mdns: 'ok', deviceCount: 1, devices: [device] },
}, null, 2)}\n`)
