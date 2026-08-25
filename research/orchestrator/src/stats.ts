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

// True iff rate A exceeds rate B: the two-sample MOVER (Newcombe) lower bound
// on (pA - pB) is above zero. This is the difference-test analogue of
// rateNonInferior and the statistic MERGE_Z was derived for; it is about
// sqrt(2) less conservative than requiring the one-sample Wilson intervals
// not to overlap (rateImprovesCI).
export function rateSuperiorCI(aSucc: number, aN: number, bSucc: number, bN: number, z = 1.96): boolean {
  const pA = aN > 0 ? aSucc / aN : 0;
  const pB = bN > 0 ? bSucc / bN : 0;
  const [aLower] = wilson(aSucc, aN, z);
  const [, bUpper] = wilson(bSucc, bN, z);
  return pA - pB - Math.sqrt((pA - aLower) ** 2 + (bUpper - pB) ** 2) > 0;
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

// ---------------------------------------------------------------------------
// Seeded Bayesian rate comparison (used by the sequential evaluation).
// Candidate and baseline rates get independent Beta posteriors under a
// Jeffreys prior; probabilities are Monte Carlo estimates from a seeded
// generator, so a decision is reproducible from its inputs.
// ---------------------------------------------------------------------------

export function seededUniform(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(u: () => number): number {
  let x = 0;
  while (x === 0) x = u();
  return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u());
}

// Marsaglia-Tsang gamma sampler; shapes below 1 use the boosting identity.
export function gammaSample(shape: number, u: () => number): number {
  if (shape < 1) {
    return gammaSample(shape + 1, u) * Math.pow(u(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(u);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const r = u();
    if (r < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(r) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(a: number, b: number, u: () => number): number {
  const x = gammaSample(a, u);
  const y = gammaSample(b, u);
  return x / (x + y);
}

export interface RateComparison {
  pGreater: number;     // P(candidate rate > baseline rate)
  pAtLeastMei: number;  // P(candidate rate >= baseline * (1 + meiRel))
  pRegress: number;     // P(candidate rate < baseline * (1 - marginRel))
  meanRatio: number;    // posterior mean of candidate / baseline
  candMean: number;
  baseMean: number;
}

export function compareRates(
  candSucc: number, candN: number, baseSucc: number, baseN: number,
  meiRel: number, marginRel: number, draws = 2000, seed = 1,
): RateComparison {
  if (candN <= 0 || baseN <= 0) {
    return { pGreater: 0.5, pAtLeastMei: 0, pRegress: 0, meanRatio: 1, candMean: 0, baseMean: 0 };
  }
  const u = seededUniform(seed);
  let greater = 0;
  let mei = 0;
  let regress = 0;
  let ratio = 0;
  for (let i = 0; i < draws; i++) {
    const pc = betaSample(candSucc + 0.5, candN - candSucc + 0.5, u);
    const pb = betaSample(baseSucc + 0.5, baseN - baseSucc + 0.5, u);
    if (pc > pb) greater++;
    if (pc >= pb * (1 + meiRel)) mei++;
    if (pc < pb * (1 - marginRel)) regress++;
    ratio += pb > 0 ? pc / pb : 1;
  }
  return {
    pGreater: greater / draws,
    pAtLeastMei: mei / draws,
    pRegress: regress / draws,
    meanRatio: ratio / draws,
    candMean: (candSucc + 0.5) / (candN + 1),
    baseMean: (baseSucc + 0.5) / (baseN + 1),
  };
}

export function selfTestPosteriors(): string[] {
  const failures: string[] = [];
  const u = seededUniform(7);
  let s = 0;
  let s2 = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) { const x = betaSample(2, 5, u); s += x; s2 += x * x; }
  const mean = s / n;
  const varc = s2 / n - mean * mean;
  if (Math.abs(mean - 2 / 7) > 0.01) failures.push(`beta(2,5) mean ${mean.toFixed(4)} != 0.2857`);
  if (Math.abs(varc - (2 * 5) / (49 * 8)) > 0.003) failures.push(`beta(2,5) variance ${varc.toFixed(4)} != 0.0255`);
  const flat = compareRates(230, 64800, 228, 64800, 0.4, 0.25, 2000, 3);
  if (flat.pGreater < 0.35 || flat.pGreater > 0.65) failures.push(`equal rates pGreater ${flat.pGreater}`);
  if (flat.pAtLeastMei > 0.02) failures.push(`equal rates pAtLeastMei ${flat.pAtLeastMei}`);
  const up = compareRates(105, 20000, 228, 64800, 0.4, 0.25, 2000, 3); // +49% at 20k runs
  if (up.pGreater < 0.99) failures.push(`+49% at 20k pGreater ${up.pGreater}`);
  const down = compareRates(600, 20000, 3222, 64800, 0.25, 0.25, 2000, 3); // -40% on a 5% rate
  if (down.pRegress < 0.95) failures.push(`-40% pRegress ${down.pRegress}`);
  return failures;
}
