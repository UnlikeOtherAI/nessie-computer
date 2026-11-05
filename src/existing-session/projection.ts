import type { PathRewriter } from '../coding-session/path-rewrite.js'
import { createProjector, SECRET_NAME } from '../coding-session/projection.js'

const IDENTIFIERS = new Set(['sessionId', 'nativeId', 'ownerKey', 'providerMessageId', 'nativeQueueId',
  'nextCursor', 'nextCursorProvider', 'incarnation', 'id', 'provider', 'agent', 'origin', 'state', 'status'])

/** Native prose uses the same credential/path projection as managed coding output. */
export const createExistingProjection = (rewriter: PathRewriter) => {
  const projector = createProjector(rewriter)
  const secrets = Object.entries(process.env).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value)
  projector.redactSecrets(secrets)
  const project = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return IDENTIFIERS.has(key) ? value : projector.text(value, 16_000)
    if (Array.isArray(value)) return value.map((item) => project(item))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, project(item, name)]))
  }
  return <T>(value: T): T => project(value) as T
}
