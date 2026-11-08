import { win32 } from 'node:path'
import { requireCapture } from '../state/sqlite.js'
import type { T3SourceManifest } from '../import/manifest.js'

export interface ConfiguredT3Home {
  readonly admittedRootKey: string
  readonly kind: T3SourceManifest['homes'][number]['kind']
  /** Explicitly registered original state directory, not a discovery parent. */
  readonly stateDirectory: string
}

/** Local policy only. Registration does not prove a physical root or human owner. */
export function parseT3Homes(value: unknown): readonly ConfiguredT3Home[] {
  requireCapture(Array.isArray(value) && value.length <= 128, 't3_source_configuration_invalid')
  const keys = new Set<string>()
  return Object.freeze(value.map((item: unknown) => {
    requireCapture(item && typeof item === 'object', 't3_source_configuration_invalid')
    const row = item as Record<string, unknown>
    requireCapture(Object.keys(row).sort().join(',') === 'admittedRootKey,kind,stateDirectory'
      && typeof row.admittedRootKey === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(row.admittedRootKey)
      && !keys.has(row.admittedRootKey)
      && ['desktop-userdata', 'desktop-development', 'server-home', 'configured-home'].includes(String(row.kind))
      && typeof row.stateDirectory === 'string' && row.stateDirectory.length <= 1024
      && /^[a-zA-Z]:\\/u.test(row.stateDirectory)
      && !row.stateDirectory.slice(3).split('\\').some(part => !part || part === '.' || part === '..'
        || /[:/\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part))
      && win32.basename(row.stateDirectory) === (row.kind === 'desktop-development' ? 'dev' : 'userdata'),
    't3_source_configuration_invalid')
    keys.add(row.admittedRootKey)
    return Object.freeze({ admittedRootKey: row.admittedRootKey,
      kind: row.kind as ConfiguredT3Home['kind'], stateDirectory: row.stateDirectory })
  }))
}
