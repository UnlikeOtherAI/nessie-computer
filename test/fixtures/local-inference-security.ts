import { execFile } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'

import { assertStateSecurityHelperResponse, type StateSecurityHelper } from '../../src/state-security.js'

const execute = promisify(execFile)
export const nativeInferenceSecurityHelper = process.env.NESSIE_TEST_NATIVE_SECURITY_HELPER

/** An explicit native-helper path runs that artifact; otherwise the portable fixture supplies the wire verdict. */
export const verifyInferenceTestState: StateSecurityHelper = async (command, path) => {
  if (nativeInferenceSecurityHelper) {
    let answer: string
    try { answer = (await execute(nativeInferenceSecurityHelper, [command, path], { encoding: 'utf8' })).stdout }
    catch (error) {
      const failed = error as NodeJS.ErrnoException & { stdout?: string }
      if (!failed.stdout) throw error
      answer = failed.stdout
    }
    return assertStateSecurityHelperResponse(answer, path)
  }
  if (command === 'secure-directory') await mkdir(path, { recursive: true, mode: 0o700 })
  try { await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    assertStateSecurityHelperResponse(JSON.stringify({ code: 'EXECUTOR_STATE_SECURITY_NOT_FOUND' }), path)
  }
}
