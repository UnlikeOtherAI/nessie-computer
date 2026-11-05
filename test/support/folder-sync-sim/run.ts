import { convergence, replicaHonesty, serverInvariants, zeroDataLoss } from './oracles.js'
import { SimWorld } from './world.js'

/**
 * One simulator run: set a world up from the seed, take `steps` random steps,
 * quiesce, judge. A run never throws; it answers what went wrong, with the
 * trace that led there.
 */

export type SimOptions = {
  steps: number
  /** Computers; by default two, sometimes three. */
  replicas?: number
  /** Leave the temp folders for inspection. */
  keep?: boolean
  /** Transfers one at a time, so a replay repeats every detail (see the README). */
  serial?: boolean
}

export type SimResult = { seed: number; problems: string[]; trace: string[]; ms: number; actionFailures: number }

export const runSimulation = async (seed: number, options: SimOptions): Promise<SimResult> => {
  const started = performance.now()
  const world = new SimWorld(seed)
  world.attachDebugLog()
  const problems: string[] = []
  let actionFailures = 0
  const consoleError = console.error
  console.error = (...args: unknown[]) => {
    actionFailures += 1
    world.log(`console.error: ${args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')}`)
  }
  try {
    await world.setUp({
      replicas: options.replicas ?? (world.rng.chance(0.25) ? 3 : 2),
      seedPages: world.rng.between(1, 5),
      skew: world.rng.chance(0.3),
      serial: options.serial === true,
    })
    for (let step = 0; step < options.steps; step += 1) await world.step()
    const quiet = await world.quiesce()
    problems.push(...world.problems)
    problems.push(...await zeroDataLoss(world))
    problems.push(...serverInvariants(world))
    if (quiet) {
      const diverged = await convergence(world)
      problems.push(...diverged)
      const labels = new Set(diverged.map((problem) => problem.slice(0, problem.indexOf(':'))))
      problems.push(...await replicaHonesty(world, labels))
    }
  } catch (error) {
    problems.push(`the run threw: ${(error as Error)?.stack ?? String(error)}`)
  } finally {
    console.error = consoleError
    if (!options.keep) await world.cleanup().catch(() => undefined)
    else world.log(`kept: ${world.replicas.map((replica) => replica.tmp).join(', ')}`)
  }
  return { seed, problems: [...new Set(problems)], trace: world.trace, ms: performance.now() - started, actionFailures }
}

/** Decomposed accents are shown escaped, so an NFD name is told apart from its NFC twin. */
const visible = (text: string): string => text.replace(/́/gu, '\\u0301')

/** A failure as a person reads it: the seed to replay, what broke, and how the run got there. */
export const describeFailure = (result: SimResult, traceLines = Number(process.env.SIM_TRACE ?? 120)): string => [
  `seed ${result.seed} failed — replay with SEED=${result.seed}:`,
  ...result.problems.map((problem) => `  ✗ ${visible(problem)}`),
  '  trace:',
  ...result.trace.slice(-traceLines).map((line) => `    ${visible(line)}`),
].join('\n')
