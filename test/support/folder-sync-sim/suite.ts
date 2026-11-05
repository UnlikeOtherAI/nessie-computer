import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { describeFailure, runSimulation, type SimResult } from './run.js'

/**
 * The simulator as `node:test` suites. The random runs and the known seeds
 * are split into shards, one per test file, so the test runner runs them in
 * parallel processes.
 *
 * Environment (all optional):
 * - `SEED=<n>`        replay one seed (every shard runs it; use one file).
 * - `SIM_RUNS=<n>`    random runs per shard (default 8; `SIM_LONG=1`: 60).
 * - `SIM_STEPS=<n>`   random steps per run (default 12; `SIM_LONG=1`: 40).
 * - `SIM_START=<n>`   first seed (default 1; `random` for a fresh one, printed on failure).
 * - `SIM_KEEP=1`      keep a failing run's temp folders for inspection.
 * - `SIM_KNOWN=0`     skip the known seeds (a batch exploring new seeds).
 * - `SIM_SERIAL=1`    one transfer at a time in the random runs and replays (the known seeds always are).
 */

export type KnownSeed = { seed: number; steps: number; replicas?: number; found: string }

const long = process.env.SIM_LONG === '1'
const numberFrom = (name: string, fallback: number): number => {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : Number(value)
}

export const knownSeeds = (): KnownSeed[] =>
  JSON.parse(readFileSync(new URL('./known-seeds.json', import.meta.url), 'utf8')) as KnownSeed[]

const judge = (results: readonly SimResult[]): void => {
  const failed = results.filter((result) => result.problems.length > 0)
  assert.equal(failed.length, 0, `\n${failed.map((result) => describeFailure(result)).join('\n\n')}\n`)
}

/** Register one shard of the random runs: seeds `start + shard`, `start + shard + shards`, … */
export const registerShard = (shard: number, shards: number): void => {
  const replay = process.env.SEED
  const runs = numberFrom('SIM_RUNS', long ? 60 : 8)
  const steps = numberFrom('SIM_STEPS', long ? 40 : 12)
  const start = process.env.SIM_START === 'random' ? Date.now() % 1_000_000_000 : numberFrom('SIM_START', 1)
  const seeds = replay ? [Number(replay)] : Array.from({ length: runs }, (_, n) => start + shard + n * shards)
  const title = replay
    ? `simulator: replay seed ${replay}`
    : `simulator shard ${shard + 1}/${shards}: ${runs} random runs of ${steps} steps from seed ${start + shard} converge with zero data loss`
  test(title, { timeout: 20 * 60 * 1000 }, async () => {
    const results: SimResult[] = []
    for (const seed of seeds) {
      results.push(await runSimulation(seed, {
        steps, keep: process.env.SIM_KEEP === '1', serial: process.env.SIM_SERIAL === '1',
      }))
    }
    const ms = results.reduce((sum, result) => sum + result.ms, 0)
    console.log(`[folder-sync-sim] shard ${shard + 1}/${shards}: ${results.length} runs in ${Math.round(ms)} ms; seeds ${seeds[0]}…${seeds.at(-1)}`)
    judge(results)
  })
}

/** This shard's share of the seeds that once failed, kept as permanent regressions (`known-seeds.json`). */
export const registerKnownSeeds = (shard: number, shards: number): void => {
  if (process.env.SEED || process.env.SIM_KNOWN === '0') return
  const seeds = knownSeeds().filter((_, index) => index % shards === shard)
  test(`simulator shard ${shard + 1}/${shards}: ${seeds.length} seeds that once broke the engine stay fixed`, { timeout: 20 * 60 * 1000 }, async () => {
    const results: SimResult[] = []
    for (const known of seeds) {
      // Serial: the gate must not flake on the order concurrent transfers finish in.
      results.push(await runSimulation(known.seed, {
        steps: known.steps, serial: true, ...(known.replicas ? { replicas: known.replicas } : {}),
      }))
    }
    judge(results)
  })
}
