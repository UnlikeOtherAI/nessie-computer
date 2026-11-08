import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'

const local = new BlockList()
for (const [address, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
  local.addSubnet(address, prefix, 'ipv4')
}
local.addAddress('::1', 'ipv6')
local.addSubnet('fc00::', 7, 'ipv6')

/** Owner-entered LAN endpoints cannot become arbitrary internet or metadata relays. */
export const isInferenceNetworkAddress = (address: string): boolean => {
  const family = isIP(address)
  return family !== 0 && local.check(address, family === 6 ? 'ipv6' : 'ipv4')
}
export const inferenceEndpointUrl = (value: string): string => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(url.pathname)) throw new Error('endpoint_configuration_invalid')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isInferenceNetworkAddress(host)) throw new Error('endpoint_configuration_invalid')
  return url.toString().replace(/\/$/, '')
}

export const resolveInferenceAddresses = async (hostname: string,
  resolve: (host: string) => Promise<string[]> = async host => (await lookup(host, { all: true })).map(item => item.address),
): Promise<string[]> => {
  const host = hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await resolve(host)
  if (!addresses.length || addresses.some(address => !isInferenceNetworkAddress(address))) {
    throw new Error('endpoint_network_address_required')
  }
  return addresses
}

const agents = new Map<string, Agent>()
/** Resolve on every request and pin the actual socket. Never follow a redirect with credentials or prompts. */
export const inferenceNetworkFetch = async (value: string, init: RequestInit): Promise<Response> => {
  const url = new URL(value)
  const addresses = await resolveInferenceAddresses(url.hostname)
  const key = [...addresses].sort().join(',')
  let agent = agents.get(key)
  if (!agent) {
    agent = new Agent({ connect: { lookup: (_host, options, callback) => {
      const records = addresses.map(address => ({ address, family: isIP(address) }))
      if (options.all) callback(null, records)
      else callback(null, records[0]!.address, records[0]!.family)
    } } })
    agents.set(key, agent)
    if (agents.size > 32) {
      const oldest = agents.keys().next().value!
      const retired = agents.get(oldest)
      agents.delete(oldest)
      void retired?.close().catch(() => undefined)
    }
  }
  return undiciFetch(url, { ...init, redirect: 'error', dispatcher: agent } as UndiciRequestInit) as unknown as Promise<Response>
}
