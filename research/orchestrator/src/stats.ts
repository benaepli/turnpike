// Pure statistics helpers for gate decisions. No IO.

/**
 * Wilson score interval for a binomial proportion.
 * Returns [lower, upper], both clamped to [0, 1]; [0, 0] when n === 0.
 */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * True iff rate A is better than rate B with CI separation: the Wilson lower
 * bound of A strictly exceeds the Wilson upper bound of B.
 */
export function rateImprovesCI(aSucc: number, aN: number, bSucc: number, bN: number, z = 1.96): boolean {
  const [aLower] = wilson(aSucc, aN, z);
  const [, bUpper] = wilson(bSucc, bN, z);
  return aLower > bUpper;
}

/**
 * True iff A is non-inferior to B by more than `margin`: the conservative
 * lower confidence bound on (pA - pB) is >= -margin.
 *
 * Uses Newcombe's hybrid score (MOVER) interval built from the Wilson bounds:
 *   lower(pA - pB) = (pA^ - pB^) - sqrt((pA^ - wilsonLower(A))^2 + (wilsonUpper(B) - pB^)^2)
 *
 * Note: the naive bound `wilsonUpper(B) - wilsonLower(A) <= margin` is NOT
 * used - it stacks both full half-widths, so at moderate n it rejects even
 * A identical to B (e.g. 10/100 vs 10/100 fails at margin 0.1). Newcombe's
 * combination is the standard conservative non-inferiority check.
 */
export function rateNonInferior(
  aSucc: number,
  aN: number,
  bSucc: number,
  bN: number,
  margin: number,
  z = 1.96,
): boolean {
  const pA = aN > 0 ? aSucc / aN : 0;
  const pB = bN > 0 ? bSucc / bN : 0;
  const [aLower] = wilson(aSucc, aN, z);
  const [, bUpper] = wilson(bSucc, bN, z);
  const diffLower = pA - pB - Math.sqrt((pA - aLower) ** 2 + (bUpper - pB) ** 2);
  return diffLower >= -margin;
}

/** Pool binomial counts across entries. */
export function poolCounts(entries: Array<{ succ: number; n: number }>): { succ: number; n: number } {
  let succ = 0;
  let n = 0;
  for (const e of entries) {
    succ += e.succ;
    n += e.n;
  }
  return { succ, n };
}

/** Returns a list of failed assertions (empty = all pass). */
export function selfTestStats(): string[] {
  const failures: string[] = [];
  const check = (cond: boolean, msg: string): void => {
    if (!cond) failures.push(msg);
  };

  const w00 = wilson(0, 0);
  check(w00[0] === 0 && w00[1] === 0, `wilson(0,0) should be [0,0], got [${w00[0]}, ${w00[1]}]`);

  const w50 = wilson(50, 100);
  check(
    w50[0] < 0.5 && w50[1] > 0.5,
    `wilson(50,100) should contain 0.5, got [${w50[0]}, ${w50[1]}]`,
  );

  check(rateImprovesCI(90, 100, 10, 100), "rateImprovesCI(90,100,10,100) should be true");
  check(!rateImprovesCI(11, 100, 10, 100), "rateImprovesCI(11,100,10,100) should be false");
  check(rateNonInferior(9, 100, 10, 100, 0.1), "rateNonInferior(9,100,10,100,0.1) should be true");

  const pooled = poolCounts([
    { succ: 3, n: 10 },
    { succ: 4, n: 20 },
  ]);
  check(pooled.succ === 7 && pooled.n === 30, `poolCounts should pool to {7,30}, got {${pooled.succ},${pooled.n}}`);

  return failures;
}
