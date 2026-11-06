declare const __NESSIE_EXECUTOR_VERSION__: string
declare const __NESSIE_EXECUTOR_SOURCE_COMMIT__: string

/** These values are baked into the signed bundle; environment variables cannot replace them. */
export const executorSoftwareVersion = (): string =>
  typeof __NESSIE_EXECUTOR_VERSION__ === 'string' ? __NESSIE_EXECUTOR_VERSION__ : 'development'

export const executorSoftwareRevision = (): string | undefined =>
  typeof __NESSIE_EXECUTOR_SOURCE_COMMIT__ === 'string'
    && /^[a-f0-9]{40}$/u.test(__NESSIE_EXECUTOR_SOURCE_COMMIT__) ? __NESSIE_EXECUTOR_SOURCE_COMMIT__ : undefined
