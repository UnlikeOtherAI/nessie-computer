import { createHash } from 'node:crypto'

export type ExistingProvider = 'codex' | 'claude'
export type ExistingSession = {
  sessionId: string
  nativeId: string
  provider: ExistingProvider
  title: string
  cwd: string
  status: 'working' | 'waiting_for_input' | 'unknown'
  updatedAt: string
  client: string
  incarnation?: string
  turnId?: string
  capabilities: { queue: boolean; push: boolean; steer: false; interrupt: false; reason: string }
}

/** A native session is scoped to the provider profile, never selected by title, path or PID. */
export const existingSessionId = (provider: ExistingProvider, profile: string, nativeId: string): string => {
  const hex = createHash('sha256').update(JSON.stringify([provider, profile, nativeId])).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const nativeIdIsValid = (value: unknown): value is string => (
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
)

export const textOf = (value: unknown, maximum = 120): string => (
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, maximum) : ''
)

export const objectOf = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
)
