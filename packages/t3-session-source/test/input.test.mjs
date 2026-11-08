import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { sessionContractsAliasPlugin } from '../input.mjs'

test('shared Effect resolver preserves metadata and enforces both identity markers', async () => {
  const root = resolve(import.meta.dirname, '..')
  const callbacks = []
  const resolutions = []
  sessionContractsAliasPlugin({ dependencyDirectory: root }).setup({
    onResolve: (options, callback) => callbacks.push({ options, callback }),
    resolve: async (path, options) => { resolutions.push({ path, options }); return { path } },
  })
  const effect = callbacks.find(entry => entry.options.filter.test('effect/Schema')).callback
  const original = { unrelated: { source: 'preserve' }, nessieSharedEffect: true }
  await effect({ path: 'effect/Schema', kind: 'import-statement', pluginData: original })
  assert.deepEqual(resolutions[0].options.pluginData, { ...original, nessieSharedEffectRoot: root })
  assert.deepEqual(original, { unrelated: { source: 'preserve' }, nessieSharedEffect: true })
  assert.equal(await effect({ path: 'effect/Schema', pluginData: resolutions[0].options.pluginData }), undefined)
  assert.throws(() => effect({ path: 'effect/Schema', pluginData: { nessieSharedEffectRoot: resolve(root, 'other') } }),
    /ROOT_MISMATCH/)
  assert.throws(() => sessionContractsAliasPlugin({ dependencyDirectory: '.' }), /ROOT_REQUIRED/)
  const alias = callbacks.find(entry => entry.options.filter.test('@nessie/t3-session-source/contracts')).callback
  await alias({ path: '@nessie/t3-session-source/contracts/settings', kind: 'import-statement',
    resolveDir: root, pluginData: original })
  assert.equal(resolutions[1].path, 't3-source:packages/contracts/src/settings.ts')
  assert.equal(resolutions[1].options.pluginData, original)
})
