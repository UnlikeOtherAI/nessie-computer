import { spawn } from 'node:child_process'
import { packagedNativeHelperPath } from '../../state-security.js'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { RetainedImportApprovalReceiptV1, RetainedImportChallengeV1, RetainedImportVerificationV1 } from './consent-contract.js'

/** Verification has no approve operation. The native client authenticates the
 * actual protected issuer process through the kernel before supplying a frame. */
export async function verifyNativeRetainedConsent(input: {
  readonly operation: 'consume' | 'recheck' | 'revoke'
  readonly challenge: RetainedImportChallengeV1
  readonly receipt: RetainedImportApprovalReceiptV1
  readonly consumption?: string
  readonly verification?: RetainedImportVerificationV1
}): Promise<Record<string, unknown>> {
  requireCapture(process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
    'retained_import_protected_windows_required')
  return new Promise((resolve, reject) => {
    const child = spawn(packagedNativeHelperPath(), ['t3-retained-verify'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    })
    let bytes = Buffer.alloc(0)
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true; clearTimeout(timer); child.kill()
      reject(new CaptureFailure('retained_import_local_consent_unavailable'))
    }
    const timer = setTimeout(fail, 20_000)
    child.once('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > 8192) fail()
    })
    child.once('close', code => {
      if (settled) return
      if (code !== 0) return fail()
      try {
        const value: unknown = JSON.parse(bytes.toString('utf8'))
        requireCapture(value && typeof value === 'object' && !Array.isArray(value), 'retained_import_native_invalid')
        settled = true; clearTimeout(timer)
        resolve(value as Record<string, unknown>)
      } catch { fail() }
    })
    child.stdin.end(JSON.stringify(input))
  })
}
