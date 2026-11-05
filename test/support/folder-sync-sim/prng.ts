/** A seeded PRNG (mulberry32): the simulator's only source of choices, so a seed replays a run. */
export class Prng {
  private state: number

  constructor(readonly seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(below: number): number {
    return Math.floor(this.next() * below)
  }

  between(min: number, max: number): number {
    return min + this.int(max - min + 1)
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Nothing to pick from.')
    return items[this.int(items.length)]!
  }

  /** One of `choices`, by weight. */
  weighted<T>(choices: ReadonlyArray<readonly [number, T]>): T {
    const total = choices.reduce((sum, [weight]) => sum + weight, 0)
    let roll = this.next() * total
    for (const [weight, value] of choices) {
      roll -= weight
      if (roll < 0) return value
    }
    return choices[choices.length - 1]![1]
  }
}
