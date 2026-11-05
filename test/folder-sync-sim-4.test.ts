import { registerKnownSeeds, registerShard } from './support/folder-sync-sim/suite.js'

/** One shard of the simulator; see `folder-sync-sim.test.ts` for how to replay a seed. */
registerShard(3, 4)
registerKnownSeeds(3, 4)
