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

// ---------------------------------------------------------------------------
// Rates per unit of exposure. Rung events are counted over explore seconds
// (or over runs, for the per-run guards), so the natural statistic is the
// log ratio of two Poisson rates: se = sqrt(1/a + 1/b), plus any variance the
// exposure itself carries (throughput jitter between chunks).
// ---------------------------------------------------------------------------

export interface LogRateRatio {
  ratio: number;
  se: number;
}

export function logRateRatio(
  aCount: number, aExposure: number, bCount: number, bExposure: number, extraVar = 0,
): LogRateRatio {
  if (aCount <= 0 || bCount <= 0 || aExposure <= 0 || bExposure <= 0) {
    return { ratio: aCount > 0 && bCount <= 0 ? Infinity : aCount <= 0 && bCount > 0 ? 0 : 1, se: Infinity };
  }
  return {
    ratio: (aCount / aExposure) / (bCount / bExposure),
    se: Math.sqrt(1 / aCount + 1 / bCount + Math.max(0, extraVar)),
  };
}

// True iff rate A exceeds rate B at z: the lower bound of the log rate ratio
// is above zero. A zero count on either side never separates; a rung the
// baseline never reaches is the jackpot rule's business, not this test's.
export function rateRatioSeparated(
  aCount: number, aExposure: number, bCount: number, bExposure: number, z: number, extraVar = 0,
): boolean {
  const r = logRateRatio(aCount, aExposure, bCount, bExposure, extraVar);
  if (!Number.isFinite(r.se) || !Number.isFinite(r.ratio) || r.ratio <= 0) return false;
  return Math.log(r.ratio) - z * r.se > 0;
}

// Coefficient of variation of per-chunk throughput, floored at the value
// measured on the baseline binary so a lucky pair of chunks cannot claim
// less jitter than the host has.
export const THROUGHPUT_CV_FLOOR = 0.01;
export function throughputCv(rps: number[]): number {
  const xs = rps.filter((x) => Number.isFinite(x) && x > 0);
  if (xs.length < 2) return THROUGHPUT_CV_FLOOR;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean <= 0) return THROUGHPUT_CV_FLOOR;
  const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.max(THROUGHPUT_CV_FLOOR, Math.sqrt(varc) / mean);
}

// Gamma-Poisson posterior comparison under a Jeffreys prior: each rate is
// Gamma(count + 1/2) scaled by its exposure, and each draw carries half of
// the extra log variance so the ratio carries all of it.
export function compareRatesPoisson(
  candCount: number, candExposure: number, baseCount: number, baseExposure: number,
  meiRel: number, marginRel: number, draws = 2000, seed = 1, extraVar = 0,
): RateComparison {
  if (candExposure <= 0 || baseExposure <= 0) {
    return { pGreater: 0.5, pAtLeastMei: 0, pRegress: 0, meanRatio: 1, candMean: 0, baseMean: 0 };
  }
  const u = seededUniform(seed);
  const jitter = Math.sqrt(Math.max(0, extraVar) / 2);
  let greater = 0;
  let mei = 0;
  let regress = 0;
  let ratio = 0;
  for (let i = 0; i < draws; i++) {
    let lc = gammaSample(candCount + 0.5, u) / candExposure;
    let lb = gammaSample(baseCount + 0.5, u) / baseExposure;
    if (jitter > 0) {
      lc *= Math.exp(standardNormal(u) * jitter);
      lb *= Math.exp(standardNormal(u) * jitter);
    }
    if (lc > lb) greater++;
    if (lc >= lb * (1 + meiRel)) mei++;
    if (lc < lb * (1 - marginRel)) regress++;
    ratio += lb > 0 ? lc / lb : 1;
  }
  return {
    pGreater: greater / draws,
    pAtLeastMei: mei / draws,
    pRegress: regress / draws,
    meanRatio: ratio / draws,
    candMean: (candCount + 0.5) / candExposure,
    baseMean: (baseCount + 0.5) / baseExposure,
  };
}

// ---------------------------------------------------------------------------
// Time to first event. A campaign on a host that violates often resolves as
// a Poisson rate; one that violates rarely resolves as censored first-hit
// times, compared by the log-rank test and summarised by a Kaplan-Meier
// median.
// ---------------------------------------------------------------------------

export interface Censored {
  // Active time to the event, or to the end of observation when censored.
  time: number;
  event: boolean;
}

// Two-sample z on Poisson counts over exposures: log rate ratio over its
// standard error. Zero on either side returns 0 with no exposure, or the
// signed conservative value of a one-count comparison otherwise, so a
// member that never violates cannot produce a large z by accident.
export function poissonRateRatioZ(candCount: number, candExposure: number, baseCount: number, baseExposure: number): number {
  if (candExposure <= 0 || baseExposure <= 0) return 0;
  const c = Math.max(candCount, 0.5);
  const b = Math.max(baseCount, 0.5);
  if (candCount === 0 && baseCount === 0) return 0;
  const ratio = (c / candExposure) / (b / baseExposure);
  return Math.log(ratio) / Math.sqrt(1 / c + 1 / b);
}

// Log-rank statistic for candidate against baseline: positive when the
// candidate reaches its events sooner. Ties in time are handled by the
// usual pooled-risk-set formula.
export function logRankZ(cand: Censored[], base: Censored[]): number {
  const all = [...cand.map((c) => ({ ...c, g: 0 })), ...base.map((c) => ({ ...c, g: 1 }))]
    .sort((a, b) => a.time - b.time);
  let atRisk0 = cand.length;
  let atRisk1 = base.length;
  let observed0 = 0;
  let expected0 = 0;
  let variance = 0;
  let i = 0;
  while (i < all.length) {
    const t = all[i]!.time;
    let d0 = 0;
    let d1 = 0;
    let c0 = 0;
    let c1 = 0;
    while (i < all.length && all[i]!.time === t) {
      const x = all[i]!;
      if (x.event) { if (x.g === 0) d0++; else d1++; } else if (x.g === 0) c0++; else c1++;
      i++;
    }
    const n = atRisk0 + atRisk1;
    const d = d0 + d1;
    if (n > 0 && d > 0) {
      const e0 = (d * atRisk0) / n;
      observed0 += d0;
      expected0 += e0;
      if (n > 1) variance += (d * (atRisk0 / n) * (1 - atRisk0 / n) * (n - d)) / (n - 1);
    }
    atRisk0 -= d0 + c0;
    atRisk1 -= d1 + c1;
  }
  if (variance <= 0) return 0;
  return (observed0 - expected0) / Math.sqrt(variance);
}

// Kaplan-Meier median: the first time the survival estimate drops to 0.5 or
// below, or null when it never does within the observations.
export function kmMedian(sample: Censored[]): number | null {
  const sorted = [...sample].sort((a, b) => a.time - b.time);
  let atRisk = sorted.length;
  let survival = 1;
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i]!.time;
    let d = 0;
    let c = 0;
    while (i < sorted.length && sorted[i]!.time === t) {
      if (sorted[i]!.event) d++; else c++;
      i++;
    }
    if (d > 0 && atRisk > 0) {
      survival *= 1 - d / atRisk;
      if (survival <= 0.5) return t;
    }
    atRisk -= d + c;
  }
  return null;
}

export function selfTestSurvival(): string[] {
  const f: string[] = [];
  const same: Censored[] = [1, 2, 3, 5, 8].map((t) => ({ time: t, event: true }));
  if (Math.abs(logRankZ(same, same)) > 1e-9) f.push(`identical samples must give log-rank z 0, got ${logRankZ(same, same)}`);
  const faster: Censored[] = [0.5, 0.7, 0.9, 1.1, 1.3].map((t) => ({ time: t, event: true }));
  const slower: Censored[] = [4, 5, 6, 7, 8].map((t) => ({ time: t, event: true }));
  const z = logRankZ(faster, slower);
  if (!(z > 2.5)) f.push(`a clearly faster candidate must give a large positive log-rank z, got ${z}`);
  if (!(logRankZ(slower, faster) < -2.5)) f.push("the sign must flip with the arms");
  const censored: Censored[] = [{ time: 10, event: false }, { time: 10, event: false }, { time: 10, event: false }];
  if (logRankZ(censored, censored) !== 0) f.push("all-censored samples give z 0");
  if (kmMedian(same) !== 3) f.push(`km median of 1,2,3,5,8 is 3, got ${kmMedian(same)}`);
  if (kmMedian(censored) !== null) f.push("km median of an all-censored sample is null");
  const mixed: Censored[] = [{ time: 1, event: true }, { time: 2, event: false }, { time: 3, event: true }, { time: 4, event: true }];
  if (kmMedian(mixed) !== 3) f.push(`km median with a censored point, got ${kmMedian(mixed)}`);
  // 3 events against 0 at equal exposure: log(3/0.5)/sqrt(1/3+1/0.5).
  const z30 = poissonRateRatioZ(3, 10, 0, 10);
  const expected = Math.log(6) / Math.sqrt(1 / 3 + 2);
  if (Math.abs(z30 - expected) > 1e-9) f.push(`3 vs 0 events z ${z30} != ${expected}`);
  if (poissonRateRatioZ(0, 10, 0, 10) !== 0) f.push("0 vs 0 events is z 0");
  if (Math.abs(poissonRateRatioZ(40, 10, 40, 10)) > 1e-9) f.push("equal rates give z 0");
  if (!(poissonRateRatioZ(20, 10, 40, 10) < -2)) f.push("half the rate gives a negative z");
  return f;
}

export function selfTestPosteriors(): string[] {
  const failures: string[] = [];
  // Rate ratios at the measured baseline counts: 3533 depth>=6 events over
  // 361 s of baseline, 883 per 90 s chunk.
  const flatP = compareRatesPoisson(3533, 361, 3533, 361, 0.064, 0.25, 2000, 5);
  if (flatP.pGreater < 0.4 || flatP.pGreater > 0.6) failures.push(`poisson equal rates pGreater ${flatP.pGreater}`);
  if (flatP.pAtLeastMei > 0.02) failures.push(`poisson equal rates pAtLeastMei ${flatP.pAtLeastMei}`);
  const upP = compareRatesPoisson(1104, 361, 3533, 1444, 0.064, 0.25, 2000, 5); // +25% over 4 chunks
  if (upP.pGreater < 0.99) failures.push(`poisson +25% pGreater ${upP.pGreater}`);
  if (!rateRatioSeparated(1104, 361, 883, 361, 2.7)) failures.push("+25% on 883 events must separate at z 2.7");
  if (rateRatioSeparated(900, 361, 883, 361, 2.7)) failures.push("+2% on 883 events must not separate at z 2.7");
  if (rateRatioSeparated(5, 361, 0, 361, 2.7)) failures.push("a zero baseline count must never separate");
  const jittered = compareRatesPoisson(3533, 361, 3533, 361, 0.064, 0.25, 2000, 5, 0.01);
  if (jittered.pGreater < 0.4 || jittered.pGreater > 0.6) failures.push(`jittered equal rates pGreater ${jittered.pGreater}`);
  // Direction agrees with the binomial test when exposure is the run count.
  if (rateRatioSeparated(228, 64800, 230, 64800, 2.7) || rateRatioSeparated(230, 64800, 228, 64800, 2.7)) failures.push("near-equal binomial counts must not separate as rates");
  if (!rateRatioSeparated(340, 64800, 228, 64800, 2.7)) failures.push("+49% on 228 events must separate as a rate");
  const cv = throughputCv([603, 601, 600, 589]);
  if (cv < THROUGHPUT_CV_FLOOR || cv > 0.02) failures.push(`throughput cv ${cv}`);
  if (throughputCv([600]) !== THROUGHPUT_CV_FLOOR) failures.push("one chunk has the floor cv");
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
