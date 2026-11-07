import type { ExecutorT3Request } from './request.js'
import ledger from './ledger.json' with { type: 'json' }

/** Structural checks only; admission and source implementations belong to their owners. */
export const isAdmissibleT3Request = (request: ExecutorT3Request): boolean => {
  const rule = ledger.rpc[request.method]
  if (rule.receipt !== 'none' && rule.receipt !== 'conditional-provider-session' && !request.commandId) return false
  if (request.method === 'server.refreshProviders') {
    if (request.input.reloadSecrets === true) return false
    if (request.input.refreshModels === true && !request.commandId) return false
  }
  if (request.method === 'server.updateSettings') {
    if (request.input.providerInstanceMutation !== undefined) return false
    if (!Object.keys(request.input.patch).every(field => Object.entries(ledger.settingsFields)
      .some(([name, policy]) => name === field && policy.status === 'pending'))) return false
  }
  if (request.method === 'scheduledTasks.upsert' && request.input.schedule.type === 'webhook') {
    const signature = request.input.schedule.signature
    if (signature && (signature.secret !== undefined || signature.secretRef !== undefined)) return false
  }
  const input = request.input
  if (input && typeof input === 'object') {
    if ('commandId' in input && request.commandId !== input.commandId) return false
    if ('usageLimitsCommand' in input && input.usageLimitsCommand === true
      || 'usageLimitSources' in input && input.usageLimitSources === true) return false
  }
  return true
}
