/** Engine-capable bridge operations use the original admitted request, not the
 * legacy session/message DTO. The owning bridge supplies source routing and
 * runtime custody after its canonical admission; no fallback to native discovery.
 * Exporting this seam installs no handler and starts no provider.
 */
export { executeSessionControl, type SessionControlRequest } from '../t3-session/control/operations.js'
export { observeSessionCommand, waitForSessionWork } from '../t3-session/control/receipts.js'
export { executeSessionSchedule, subscribeSessionSchedules } from '../t3-session/control/schedules.js'
