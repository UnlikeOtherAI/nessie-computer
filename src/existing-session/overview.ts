import { objectOf, textOf } from './types.js'

/** The existing session viewer shows decisions and delivery limits, rather than adapter JSON. */
export const existingSessionOverview = (value: Record<string, unknown>): string => {
  const capabilities = objectOf(value.capabilities)
  const delivery = objectOf(value.lastDelivery)
  const actions = [capabilities.queue === true ? 'Queue native input' : '',
    capabilities.push === true ? 'Push a channel event' : ''].filter(Boolean)
  return [
    textOf(value.title),
    '',
    `Provider: ${value.provider === 'codex' ? 'Codex' : 'Claude Code'}`,
    `Native source: ${textOf(value.client)}`,
    `Session: ${textOf(value.nativeId)}`,
    `State: ${value.status === 'unknown' ? 'Live state unknown' : textOf(value.status).replaceAll('_', ' ')}`,
    `Observed: ${textOf(value.observedAt)}`,
    '',
    `Available input: ${actions.join(', ') || 'None for this session'}`,
    textOf(capabilities.reason, 600),
    '',
    ...(delivery.state ? [`Last input: ${textOf(delivery.state).replaceAll('_', ' ')}`,
      textOf(delivery.behavior || delivery.reason, 600), ''] : []),
    'Ask your Nessie agent to send input or inspect recent messages.',
    'The original client owns this session and handles its permission prompts.',
  ].join('\n')
}
