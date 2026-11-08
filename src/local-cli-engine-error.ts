import type { LocalCliErrorCode } from '@nessie/executor-protocol'

/** A CLI engine's closed refusal; its code goes to Nessie in the error frame and receipt diagnostics. */
export class LocalCliEngineError extends Error {
  override readonly name = 'LocalCliEngineError'
  constructor(readonly code: LocalCliErrorCode) { super(code) }
}

/** The shared turn runner's plain errors, as engine codes. */
export const localCliTurnError = (error: unknown): LocalCliEngineError => {
  if (error instanceof LocalCliEngineError) return error
  const message = error instanceof Error ? error.message : ''
  return new LocalCliEngineError(message === 'CANCELLED' ? 'cancelled' : 'inference_incomplete')
}
