import { captureRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { createRetainedCatalogService } from '../../dist/t3-session/catalog/service.js'
import { engineFixture } from '../t3-session-import/engine-fixture.mjs'

/** Synthetic authorities only. No fixture is exported by production source. */
export async function catalogFixture(options) {
  const fixture = await engineFixture(options)
  try {
    grantCatalogFixture(fixture)
    const capture = await captureRetainedT3(fixture.ports, fixture.manifest, fixture.source.admittedRootKey)
    const selection = { manifest: fixture.manifest, ...fixture.source, generation: capture.generation }
    const service = createRetainedCatalogService(fixture.ports, selection)
    return { ...fixture, capture, selection, service }
  } catch (error) { fixture.close(); throw error }
}

export function grantCatalogFixture(fixture, selection = {
  basis: 'historical-continuity', revision: 'synthetic:selection:1', scope: 'environment-owner',
}) {
  fixture.ports.catalogAuthority = { withCatalogReadScope: async (_input, use) => use({
    selection, recheckSelection: async () => {}, recheckSource: async () => {}, recheckThread: async () => {},
  }) }
}
