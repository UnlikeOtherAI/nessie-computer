import type { Readable, Writable } from 'node:stream'

import { executorApi, type ExecutorApiClient } from './api-client.js'
import { createBrowserCookieImportBridge, type BrowserCookieImportOffer } from './browser-cookie-import-bridge.js'
import { decodeChromeNativeMessages, encodeChromeNativeMessage } from './chrome-native-messaging.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

const failedHostFrame = (): Record<string, unknown> => ({
  code: 'BROWSER_COOKIE_IMPORT_UNAVAILABLE',
  type: 'browser_cookie_import.result.v1',
})

const requireLiveConnection = (state: ExecutorLocalState): string => {
  if (!state.connectionEpoch) throw new Error('Browser cookie import requires a live paired executor connection.')
  return state.connectionEpoch
}

const offerFromApi = (value: BrowserCookieImportOffer): BrowserCookieImportOffer => value

export const serveBrowserCookieImportNativeHost = async (input: {
  api?: ExecutorApiClient
  callerOrigin: string
  expectedExtensionOrigin: string
  requireDevelopmentLocalApi?: boolean
  states: ExecutorLocalState[]
  stdin?: Readable
  stdout?: Writable
}): Promise<void> => {
  if (input.callerOrigin !== input.expectedExtensionOrigin) {
    throw new Error('Native host caller is not the release-pinned Nessie extension.')
  }
  const api = input.api ?? executorApi
  const states = input.requireDevelopmentLocalApi
    ? input.states.filter((state) => state.apiBaseUrl === 'http://127.0.0.1:5454')
    : input.states
  let selectedState: ExecutorLocalState | null = null
  const pending = async (): Promise<BrowserCookieImportOffer | null> => {
    for (const state of states) {
      try {
        const connectionEpoch = requireLiveConnection(state)
        const observedAt = new Date().toISOString()
        const payload = { connectionEpoch, executorId: state.executorId, observedAt }
        const result = await api.pollBrowserCookieImport(state.apiBaseUrl, {
          ...payload,
          signature: signExecutorDaemonPayload(state.machinePrivateKey, 'browser_cookie_import.poll', payload),
        })
        if (result.offer) {
          selectedState = state
          return offerFromApi(result.offer)
        }
      } catch {
        // A stale pairing must not stop another verified pairing from offering
        // its own user-authorized import. No state or cookie data is emitted.
      }
    }
    return null
  }
  const bridge = createBrowserCookieImportBridge({
    pending,
    upload: async (value) => {
      const state = selectedState
      if (!state) throw new Error('Browser cookie import has no selected paired executor.')
      const connectionEpoch = requireLiveConnection(state)
      const submittedAt = new Date().toISOString()
      const payload = {
        connectionEpoch,
        cookies: value.cookies,
        executorId: state.executorId,
        payloadDigest: value.payloadDigest,
        requestId: value.requestId,
        selectedOrigins: value.selectedOrigins,
        submittedAt,
      }
      await api.uploadBrowserCookieImport(state.apiBaseUrl, {
        ...payload,
        signature: signExecutorDaemonPayload(state.machinePrivateKey, 'browser_cookie_import.upload', payload),
      })
    },
  })
  const stdin = input.stdin ?? process.stdin
  const stdout = input.stdout ?? process.stdout
  let buffered = Buffer.alloc(0)
  for await (const chunk of stdin) {
    try {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      const decoded = decodeChromeNativeMessages(buffered)
      buffered = Buffer.from(decoded.remainder)
      for (const frame of decoded.frames) {
        const response = await bridge.handle(frame).catch(failedHostFrame)
        stdout.write(encodeChromeNativeMessage(response))
      }
    } catch {
      stdout.write(encodeChromeNativeMessage(failedHostFrame()))
      return
    }
  }
  // A partial frame is never interpreted. Chrome closing the port drops it
  // instead of attempting a retry.
}
