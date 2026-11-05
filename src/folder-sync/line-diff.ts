/**
 * A line diff (Myers, "An O(ND) Difference Algorithm") for the three-way
 * merge. Lines are compared as exact strings — no normalisation — so two
 * lines are equal only when their bytes are.
 *
 * The search is bounded: past `maxEdits` differences it gives up and the
 * merge falls back to keeping both versions (R2), which is always safe.
 */

/** One change against the base: `base[start, end)` becomes `lines`. */
export type LineChange = { start: number; end: number; lines: readonly string[] }

/** The changes that turn `base` into `other`, in base order; null past `maxEdits`. */
export const diffLines = (
  base: readonly string[],
  other: readonly string[],
  maxEdits: number,
): LineChange[] | null => {
  let prefix = 0
  while (prefix < base.length && prefix < other.length && base[prefix] === other[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < base.length - prefix && suffix < other.length - prefix
    && base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) suffix += 1
  const a = base.slice(prefix, base.length - suffix)
  const b = other.slice(prefix, other.length - suffix)
  const pairs = matchedPairs(a, b, maxEdits)
  if (pairs === null) return null

  const changes: LineChange[] = []
  let ai = 0
  let bi = 0
  for (const [ma, mb] of [...pairs, [a.length, b.length] as const]) {
    if (ma > ai || mb > bi) changes.push({ start: prefix + ai, end: prefix + ma, lines: b.slice(bi, mb) })
    ai = ma + 1
    bi = mb + 1
  }
  return changes
}

/** The matched (a index, b index) pairs of a shortest edit script, in order. */
const matchedPairs = (a: readonly string[], b: readonly string[], maxEdits: number): Array<[number, number]> | null => {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, offset, n, m, d, a, b)
    }
  }
  return null
}

const backtrack = (
  trace: readonly Int32Array[],
  offset: number,
  n: number,
  m: number,
  depth: number,
  a: readonly string[],
  b: readonly string[],
): Array<[number, number]> => {
  const pairs: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = depth; d > 0; d -= 1) {
    const v = trace[d]!
    const k = x - y
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
    const prevK = down ? k + 1 : k - 1
    const prevX = v[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      pairs.push([x, y])
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    x -= 1
    y -= 1
    pairs.push([x, y])
  }
  return pairs.reverse()
}
