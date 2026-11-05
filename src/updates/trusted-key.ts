// Public release verification key. The private key never enters source.
import key from './public-key.json' with { type: 'json' }

export const EXECUTOR_UPDATE_PUBLIC_KEY = key.publicKey
