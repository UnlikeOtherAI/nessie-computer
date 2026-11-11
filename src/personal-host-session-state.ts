import type { PersonalHostRegistration } from './personal-inference-guard.js'
import { createAdmissionProcessInspector, type AdmissionProcessInspector } from './personal-admission-lock.js'

/** Positive live-controller evidence supplies the useful refusal before native
 * inventory rejects its unisolated children. False is not compatibility proof:
 * the independent inventory and archived retirement remain mandatory. */
export const hasKnownLiveHostExecution = async (
  registrations: readonly PersonalHostRegistration[], bootId: string | undefined,
  processes: AdmissionProcessInspector = createAdmissionProcessInspector(),
): Promise<boolean> => {
  if (!bootId) return false
  const seen = new Set<string>()
  for (const item of registrations) {
    if (item.kind !== 'host_execution' || item.bootId !== bootId) continue
    const generation = item.pid + '/' + item.startedAt
    if (seen.has(generation)) continue
    seen.add(generation)
    if (!processes.isAlive(item.pid)) continue
    const current = await processes.identify(item.pid)
    if (current?.pid === item.pid && current.startedAt === item.startedAt) return true
  }
  return false
}
