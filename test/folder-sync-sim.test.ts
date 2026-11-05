/**
 * README — the folder sync simulator (plan §7 T8, amendment A12.11).
 *
 * A seeded PRNG drives two or three computers — each a real engine over its own
 * temp folder, state directory and clock (one may run a day off) — and one fake
 * Nessie through random interleavings: people editing, creating, renaming,
 * moving and deleting files and folders; colleagues and agents doing the same in
 * Nessie, publishing pages, renaming spaces and losing access to them; offline
 * windows, refused calls, lost answers, crashes at a transfer or between a
 * journal record and its rename, daemon restarts, watcher hints that miss the
 * change, and people answering conflicts and held deletes. After a quiescence
 * the oracles in `support/folder-sync-sim/oracles.ts` judge the world: every
 * folder equals Nessie's tree; every byte anyone wrote and nobody deleted is
 * still somewhere (Nessie, a folder, a copy, the trash); every daemon write
 * passed its base guard; one effect per operation; a tree-shaped parent graph
 * and valid names; open rows the same here and in Nessie; nothing stuck
 * without a row; `up_to_date` exactly when it is.
 *
 * Replay a seed (the failure message prints it):
 *
 *   cd executor
 *   SEED=1234 SIM_STEPS=12 node --test --import tsx test/folder-sync-sim.test.ts
 *
 * Use the step count the failing run had (12 by default, 40 with `SIM_LONG=1`,
 * 25 for the known seeds). `SIM_KEEP=1` keeps the run's temp folders and
 * `SIM_TRACE=<lines>` prints more of the trace (120 by default).
 *
 * Determinism. A seed fixes every choice the simulator makes, but a pass runs
 * up to three downloads or two uploads at once, and the order they finish in
 * is the disk's: which transfer a "during the transfer" interference lands
 * on, the order of their random draws, and which rename an armed crash hits
 * can then differ between two runs of one seed, and the rest of the run with
 * them. `SIM_SERIAL=1` runs one transfer at a time (the engine's
 * `transferConcurrency`), which makes a replay repeat every detail; the known
 * seeds always run that way, so the gate never flakes on timing. The random
 * runs keep the engine's real concurrency, because some bugs live only there
 * (seed 133): a seed found that way that does not fail with `SIM_SERIAL=1`
 * needs a few plain replays to reproduce.
 *
 * Explore new ground with `SIM_START=<n>` (each shard takes every fourth seed
 * from there) and `SIM_RUNS=<n>`, with `SIM_KNOWN=0` to leave the known seeds
 * out; the long soak is `SIM_LONG=1`. A seed that once failed and is fixed
 * goes into `support/folder-sync-sim/known-seeds.json`, with a focused test in
 * `folder-sync-sim-regressions.test.ts` where the rule can be pinned.
 */
import { registerKnownSeeds, registerShard } from './support/folder-sync-sim/suite.js'

registerShard(0, 4)
registerKnownSeeds(0, 4)
