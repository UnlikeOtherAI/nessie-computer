#!/usr/bin/env node
/**
 * A Kelpie CLI whose `describe` never answers — an mDNS sweep that hangs — so
 * detection has to stop it. It writes its own pid to NESSIE_TEST_PID_FILE
 * first, which lets a test see whether the process under a `.cmd` shim was
 * stopped too or left behind when only the shim's `cmd.exe` was.
 *
 * With NESSIE_TEST_CHILD_PID_FILE it also starts a sleeping process of its
 * own that holds describe's stdout, as a helper Kelpie started would, and
 * writes that pid there before its own. With NESSIE_TEST_EXIT_EARLY as well,
 * Kelpie itself then exits, and that process alone holds describe's stdout,
 * so its pipes never close.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

if (process.env.NESSIE_TEST_CHILD_PID_FILE) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 60000)'], {
    stdio: ['ignore', 'inherit', 'ignore'],
    windowsHide: true,
  })
  writeFileSync(process.env.NESSIE_TEST_CHILD_PID_FILE, String(child.pid))
}
if (process.env.NESSIE_TEST_PID_FILE) writeFileSync(process.env.NESSIE_TEST_PID_FILE, String(process.pid))
if (process.env.NESSIE_TEST_EXIT_EARLY) process.exit(0)
setInterval(() => undefined, 60_000)
