import { join } from 'node:path'

export type ChannelRegistration = {
  nativeId: string
  profile: string
  incarnation: string
  heartbeatAt: number
}

export type ChannelEvent = {
  queuedAt: number
  commandId: string
  sessionId: string
  incarnation: string
  message: string
  expiresAt: number
}

export const channelsDir = (stateDir: string): string => join(stateDir, 'existing-channels')
export const channelRegistrationPath = (stateDir: string, sessionId: string): string => (
  join(channelsDir(stateDir), `${sessionId}.json`)
)
export const channelInboxDir = (stateDir: string, sessionId: string): string => (
  join(channelsDir(stateDir), sessionId)
)
