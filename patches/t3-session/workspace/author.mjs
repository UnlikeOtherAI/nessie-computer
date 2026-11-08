import { writeFileSync } from 'node:fs'
import { sourceSnapshot } from '../../../test/t3-session-workspace/source-fixture.mjs'
import { generateWorkspaceManifest } from './generate.mjs'

const manifest = generateWorkspaceManifest(sourceSnapshot())
writeFileSync(new URL('./boundary-patches.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${manifest.patches.length} workspace source transformations authored; no runtime executed\n`)
