import { PersonalInferenceGuard, type PersonalHostExecutionLease } from './personal-inference-guard.js'
import { acquireWindowsMachineHostLease, assertWindowsMachineHostAllowed } from './windows-machine-host.js'

/**
 * Packaged product runtimes participate before credentials exist. Unpackaged
 * developer/test processes retain their existing inactive behavior, and cannot
 * enable credentials: independent activation inventory must reject them.
 */
export const admitPersonalHostExecution = async (
  label: string, authority: unknown = null, guard = PersonalInferenceGuard.open(),
): Promise<PersonalHostExecutionLease | null> => {
  const state = await guard.status()
  if (process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1' && state.protection === null) return null
  const machine = await acquireWindowsMachineHostLease()
  try {
    const local = await guard.admitHostExecution(label, authority)
    return { id: local.id, bindExecution: local.bindExecution,
      release: async () => { await machine?.release(); await local.release() },
      // The local registration and the service's durable host lease both stay;
      // only the barrier process that would otherwise outlive this admission ends.
      ...(machine ? { abandon: machine.abandon } : {}) }
  } catch (error) {
    await machine?.release()
    throw error
  }
}

/** Read-only calls still recheck the current fence, including already-open MCP processes. */
export const assertPersonalHostExecution = async (authority: unknown = null): Promise<void> => {
  await assertWindowsMachineHostAllowed()
  await PersonalInferenceGuard.open().assertExecutionAuthority(authority)
}
