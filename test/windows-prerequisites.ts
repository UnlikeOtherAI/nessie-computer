import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { packagedNativeHelperPath } from '../src/state-security.js'

/** Windows source tests use the fixed sibling Debug helper for real DACLs.
 * The public ACL commands do not require installed-runtime admission. The test
 * runner places unmarked Node beside that helper before loading these tests.
 */
const stateHelper = process.platform === 'win32' && existsSync(packagedNativeHelperPath())
const packagedRuntime = stateHelper && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'

export const WINDOWS_STATE_HELPER_SKIP: string | false = process.platform === 'win32' && !stateHelper
  ? 'Windows executor state needs the native ACL helper beside the running Node; run the repository test runner after cargo build.'
  : false

/**
 * Windows verifies guest VM artifacts against the installed package's own
 * resources (`resources/guest/…` beside its `nessie-executor-runtime.exe`), which a helper built
 * on its own does not bring.
 */
export const WINDOWS_GUEST_RESOURCES_SKIP: string | false = process.platform === 'win32'
  && !(packagedRuntime && existsSync(join(dirname(process.execPath), 'resources', 'guest', 'build-initrd.exe')))
  ? 'Windows guest VM artifacts are verified against the installed executor package, whose nessie-executor-runtime.exe must run this test.'
  : false

const canCreateSymlinks = (): boolean => {
  const directory = mkdtempSync(join(tmpdir(), 'nessie-symlink-probe-'))
  try {
    writeFileSync(join(directory, 'target'), '')
    symlinkSync(join(directory, 'target'), join(directory, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

/** A file symlink on Windows needs Developer Mode or an elevated token. */
export const WINDOWS_SYMLINK_SKIP: string | false = process.platform === 'win32' && !canCreateSymlinks()
  ? 'Creating a symbolic link on Windows needs Developer Mode or an elevated token, which this process lacks.'
  : false
