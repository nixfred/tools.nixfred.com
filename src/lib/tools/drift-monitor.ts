/**
 * Drift Monitor, statistical engine.
 *
 * PRD: tools-nixfred-prds/tools/12-DRIFT-MONITOR.md
 * User outcome: tell a real behavior change apart from ordinary
 * sampling noise before you go chasing it.
 *
 * SCOPE NOTE, worth stating plainly because the PRD text and this file
 * do not match line for line. The PRD's listed acceptance criteria
 * describe a full system snapshot differ (prompts, tools, permissions,
 * knowledge sources, model settings, with permission expansion called
 * out for prominent treatment). This build implements the specific
 * instrument for the "evaluation results" input the PRD also lists,
 * and that framing was handed down directly for this build: compare a
 * baseline pass rate against a current pass rate and answer, with real
 * statistics, whether the movement is a real change or ordinary
 * sampling noise. Structural snapshot diffing is out of scope here.
 *
 * THE WHOLE VALUE OF THIS TOOL IS GETTING THE MATH RIGHT. A scary
 * looking drop that is actually noise, or an unremarkable drop that is
 * actually real, are both useless findings if the arithmetic is wrong.
 * Every function below states its method and its assumptions rather
 * than presenting a bare number, and tests/tool-drift-monitor.mjs
 * checks each one against a hand worked or independently derived
 * reference value, not just against itself.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

import type { ValidationIssue } from '../../data/types';

/* ====================================================================
   1. NUMERICAL PRIMITIVES

   Everything above the line level statistics (Wilson, the two tests,
   power) is built on three general purpose functions: the normal CDF,
   its inverse, and the log gamma function. None of these are specific
   to proportions; they are standard, widely published approximations,
   used here so every later formula can ask for "the z value for a 99
   percent interval" or "the exact hypergeometric probability of this
   table" without a special case for each confidence level.
   ==================================================================== */

/**
 * Error function, via the Abramowitz and Stegun 7.1.26 rational
 * approximation. Maximum absolute error 1.5e-7, far tighter than
 * anything this tool displays (four decimal places at most), so it is
 * treated as exact throughout.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal cumulative distribution function, P(Z <= z). */
export function normalCDF(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Inverse standard normal CDF (the probit function), via Peter
 * Acklam's rational approximation (2003). Accurate to about 1.15e-9
 * relative error. Used to turn a confidence level or a target power
 * into the z value the rest of this file's formulas are built from,
 * so a 90 percent interval, a 99 percent interval, and an 80 percent
 * power target all run through the same exact math as the 95 percent
 * default rather than a hardcoded table of special cases.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0) || !(p < 1)) {
    throw new RangeError(`normalQuantile: p must be strictly between 0 and 1, got ${p}`);
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/**
 * Natural log of the gamma function, via the Lanczos approximation
 * (g=7, 9 term series, the widely published coefficient set). Used
 * only to build binomial coefficients through logChoose below, so
 * this file never exponentiates a raw factorial and overflows on
 * sample sizes in the thousands.
 */
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula extends the approximation below its native
    // domain.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xx = x - 1;
  let a = LANCZOS_COEFFICIENTS[0];
  const t = xx + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) {
    a += LANCZOS_COEFFICIENTS[i] / (xx + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log(n choose k), safe for n into the hundreds of thousands. */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  if (k === 0 || k === n) return 0;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/* ====================================================================
   2. STATE SHAPE

   The tool only ever asks for aggregate counts, not per item results,
   because that is what an eval report or a monitoring dashboard
   actually hands you. See the independence assumption in
   ASSUMPTIONS_TEXT below for what that costs.
   ==================================================================== */

export interface DriftSnapshot {
  /** Sample size. Must be at least 1. */
  n: number;
  /** Count of successes. Must be between 0 and n inclusive. */
  successes: number;
}

export type EvalSetChanged = 'no' | 'yes';

export interface DriftState {
  /** Free text label for what is being measured. Shown in every export. */
  metricName: string;
  baseline: DriftSnapshot;
  current: DriftSnapshot;
  /** Significance level for the single metric case, e.g. 0.05. */
  alpha: number;
  /** How many metrics are being monitored in the same sweep. Drives
   * the Bonferroni correction. Must be a whole number, at least 1. */
  metricsMonitored: number;
  /** Target statistical power (0 to 1) for the minimum detectable
   * effect calculation, e.g. 0.8 for the conventional 80 percent. */
  targetPower: number;
  /** The smallest change, as a fraction (0.05 = 5 percentage points),
   * that would actually matter for this metric. Drives the noise versus
   * insufficient data distinction. */
  minMeaningfulEffect: number;
  /** Whether the evaluation set itself changed between the two
   * measurements. "yes" invalidates the comparison entirely. */
  evalSetChanged: EvalSetChanged;
}

export function emptyState(): DriftState {
  return {
    metricName: '',
    baseline: { n: 0, successes: 0 },
    current: { n: 0, successes: 0 },
    alpha: 0.05,
    metricsMonitored: 1,
    targetPower: 0.8,
    minMeaningfulEffect: 0.05,
    evalSetChanged: 'no',
  };
}

export function reset(): DriftState {
  return emptyState();
}

export function validate(state: DriftState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const checkSnapshot = (snap: DriftSnapshot, label: string, field: string) => {
    if (!Number.isFinite(snap.n) || snap.n < 1 || !Number.isInteger(snap.n)) {
      issues.push({
        field: `${field}.n`,
        message: `${label} sample size must be a whole number of at least 1.`,
        severity: 'error',
      });
      return;
    }
    if (
      !Number.isFinite(snap.successes) ||
      snap.successes < 0 ||
      snap.successes > snap.n ||
      !Number.isInteger(snap.successes)
    ) {
      issues.push({
        field: `${field}.successes`,
        message: `${label} successes must be a whole number between 0 and the sample size.`,
        severity: 'error',
      });
    }
  };

  checkSnapshot(state.baseline, 'Baseline', 'baseline');
  checkSnapshot(state.current, 'Current', 'current');

  if (
    !Number.isFinite(state.metricsMonitored) ||
    state.metricsMonitored < 1 ||
    !Number.isInteger(state.metricsMonitored)
  ) {
    issues.push({
      field: 'metricsMonitored',
      message: 'Number of metrics monitored must be a whole number of at least 1.',
      severity: 'error',
    });
  }

  if (!Number.isFinite(state.alpha) || state.alpha <= 0 || state.alpha >= 1) {
    issues.push({
      field: 'alpha',
      message: 'Significance level must be strictly between 0 and 1.',
      severity: 'error',
    });
  }

  if (!Number.isFinite(state.targetPower) || state.targetPower <= 0 || state.targetPower >= 1) {
    issues.push({
      field: 'targetPower',
      message: 'Target power must be strictly between 0 and 1.',
      severity: 'error',
    });
  }

  if (!Number.isFinite(state.minMeaningfulEffect) || state.minMeaningfulEffect <= 0) {
    issues.push({
      field: 'minMeaningfulEffect',
      message: 'The smallest change that matters must be greater than zero.',
      severity: 'error',
    });
  }

  if (state.evalSetChanged === 'yes') {
    issues.push({
      field: 'evalSetChanged',
      message:
        'The evaluation set changed between the two measurements, so no verdict below is valid until they are re run on an identical set.',
      severity: 'warning',
    });
  }

  return issues;
}

/* ====================================================================
   3. WILSON SCORE INTERVAL

   The confidence interval for a single proportion. Used instead of
   the textbook p_hat +/- z*sqrt(p_hat(1-p_hat)/n) normal approximation
   because that one produces intervals that fall outside 0 to 1 and
   collapses to a zero width interval at p_hat = 0 or 1, exactly where
   eval pass rates often sit. Wilson corrects both failures and is the
   interval R's binom.test and most modern statistics texts recommend
   as the default.
   ==================================================================== */

export interface Interval {
  lower: number;
  upper: number;
}

export interface WilsonInterval extends Interval {
  /** The score interval's own center, which is not p_hat except when
   * p_hat = 0.5. Kept because Newcombe's difference interval below is
   * built from these bounds, not from p_hat directly. */
  center: number;
}

export function wilsonInterval(
  successes: number,
  n: number,
  confidence: number,
): WilsonInterval {
  // Defensive only: validate() keeps n >= 1 in the UI, so this branch
  // is not reachable from the page, but a pure function that can
  // divide by zero on bad input is a bug waiting to happen.
  const nSafe = n > 0 ? n : 1;
  const p = successes / nSafe;
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const z2 = z * z;
  const denom = 1 + z2 / nSafe;
  const center = (p + z2 / (2 * nSafe)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / nSafe + z2 / (4 * nSafe * nSafe))) / denom;
  return {
    center,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

/* ====================================================================
   4. TWO PROPORTION Z TEST

   The standard large sample test: pool the two counts into one rate,
   use it to compute the standard error under the null hypothesis that
   both groups share a true rate, and compare the observed difference
   to that error. Valid when the normal approximation to the binomial
   holds, which is what WHICH_TEST_APPLIES below checks before trusting
   this test's p value over the exact one.
   ==================================================================== */

export interface ZTestResult {
  pooledProportion: number;
  standardError: number;
  z: number;
  /** Two sided p value. */
  pValue: number;
}

export function twoProportionZTest(
  current: DriftSnapshot,
  baseline: DriftSnapshot,
): ZTestResult {
  const p1 = current.successes / current.n;
  const p2 = baseline.successes / baseline.n;
  const pooledProportion =
    (current.successes + baseline.successes) / (current.n + baseline.n);
  const variance =
    pooledProportion * (1 - pooledProportion) * (1 / current.n + 1 / baseline.n);
  const standardError = Math.sqrt(variance);

  // Degenerate case: both groups sit at the same boundary rate (both
  // all success or both all failure), so the pooled proportion is
  // exactly 0 or 1 and the plug in variance is exactly 0. The naive
  // formula divides the (also zero) difference by that zero and
  // returns NaN. There is genuinely no evidence of any difference in
  // this situation, so z is 0 and p is 1, not NaN.
  if (standardError === 0) {
    return { pooledProportion, standardError, z: 0, pValue: 1 };
  }

  const z = (p1 - p2) / standardError;
  const pValue = Math.min(1, 2 * (1 - normalCDF(Math.abs(z))));
  return { pooledProportion, standardError, z, pValue };
}

/* ====================================================================
   5. FISHER EXACT TEST

   Small samples are the common case in eval work: a hand curated eval
   set is often a few dozen to a few hundred cases, not thousands. The
   z test's normal approximation is unreliable there, so this computes
   the exact two sided p value from the hypergeometric distribution:
   the probability, under the two groups having a shared true rate, of
   seeing a table this lopsided or more, summed over every 2 by 2 table
   with the same row and column totals.

   WHICH TEST APPLIES, stated once here and surfaced by
   describePrimaryTest below: Cochran's rule of thumb says the normal
   approximation the z test relies on is trustworthy when every
   expected cell in the 2 by 2 table (n times the pooled rate, and n
   times one minus the pooled rate, for each group) is at least 5.
   Below that, this exact test is the one to trust.
   ==================================================================== */

export interface FisherResult {
  pValue: number;
  /** False only when the combined sample was too large for a direct
   * enumeration to be worth computing; see FISHER_MAX_TOTAL_N. */
  computed: boolean;
  note: string;
}

/** Direct enumeration is O(N). Even 200,000 iterations of simple
 * arithmetic is milliseconds, and past this size the z test's normal
 * approximation is exact for any practical purpose anyway, so this
 * cap exists to avoid pointless work rather than because the method
 * breaks down. */
const FISHER_MAX_TOTAL_N = 200_000;

function hypergeometricPMF(
  k: number,
  successesTotal: number,
  populationTotal: number,
  drawTotal: number,
): number {
  const logP =
    logChoose(successesTotal, k) +
    logChoose(populationTotal - successesTotal, drawTotal - k) -
    logChoose(populationTotal, drawTotal);
  return Math.exp(logP);
}

export function fisherExactTest(
  current: DriftSnapshot,
  baseline: DriftSnapshot,
): FisherResult {
  const populationTotal = current.n + baseline.n;
  const successesTotal = current.successes + baseline.successes;
  const drawTotal = current.n;
  const observed = current.successes;

  if (populationTotal > FISHER_MAX_TOTAL_N) {
    return {
      pValue: NaN,
      computed: false,
      note: `Skipped: the combined sample of ${populationTotal} is past the size where an exact test earns its cost. The two proportion z test above is reliable on its own at this scale.`,
    };
  }

  const kMin = Math.max(0, drawTotal - (populationTotal - successesTotal));
  const kMax = Math.min(drawTotal, successesTotal);
  const observedP = hypergeometricPMF(observed, successesTotal, populationTotal, drawTotal);

  // A table counts as "at least as extreme" as the observed one when
  // its probability is no larger, the standard definition of the
  // two sided Fisher exact p value. The small relative tolerance below
  // keeps the observed table itself counted despite floating point
  // rounding in the log space arithmetic above.
  const TOLERANCE = 1 + 1e-9;
  let pValue = 0;
  for (let k = kMin; k <= kMax; k++) {
    const p = hypergeometricPMF(k, successesTotal, populationTotal, drawTotal);
    if (p <= observedP * TOLERANCE) pValue += p;
  }

  return {
    pValue: Math.min(1, pValue),
    computed: true,
    note: 'Exact two sided p value: the hypergeometric probability of every table with the same row and column totals that is at least as lopsided as the one observed.',
  };
}

/** Cochran's rule of thumb for trusting the normal approximation. */
const MIN_EXPECTED_CELL = 5;

export interface PrimaryTestVerdict {
  primaryTest: 'z' | 'fisher';
  smallestExpectedCell: number;
  reason: string;
}

export function describePrimaryTest(
  current: DriftSnapshot,
  baseline: DriftSnapshot,
  pooledProportion: number,
  fisher: FisherResult,
): PrimaryTestVerdict {
  const expectedCells = [
    current.n * pooledProportion,
    current.n * (1 - pooledProportion),
    baseline.n * pooledProportion,
    baseline.n * (1 - pooledProportion),
  ];
  const smallestExpectedCell = Math.min(...expectedCells);
  const normalApproximationHolds = smallestExpectedCell >= MIN_EXPECTED_CELL;

  if (!fisher.computed) {
    return {
      primaryTest: 'z',
      smallestExpectedCell,
      reason:
        'The combined sample is large enough that the exact test was skipped for cost. The normal approximation is reliable here regardless of the cell count check.',
    };
  }
  if (normalApproximationHolds) {
    return {
      primaryTest: 'z',
      smallestExpectedCell,
      reason: `Every expected cell in the 2 by 2 table is at least ${MIN_EXPECTED_CELL} (the smallest is ${smallestExpectedCell.toFixed(1)}), so the normal approximation holds. Read the z test as primary; the exact test alongside it is confirmation.`,
    };
  }
  return {
    primaryTest: 'fisher',
    smallestExpectedCell,
    reason: `At least one expected cell in the 2 by 2 table is below ${MIN_EXPECTED_CELL} (the smallest is ${smallestExpectedCell.toFixed(1)}), the threshold Cochran's rule sets for trusting a normal approximation. Read the exact test as primary; the z test alongside it is shown for reference only, and may overstate significance here.`,
  };
}

/* ====================================================================
   6. CONFIDENCE INTERVAL ON THE DIFFERENCE

   Whether this interval crosses zero is the actual answer to "is this
   real", which is why it gets top billing in the UI rather than the p
   value. Built by Newcombe's hybrid score method (Newcombe, R.G.,
   "Interval estimation for the difference between independent
   proportions: comparison of eleven methods", Statistics in Medicine,
   1998, method 10), which composes the two Wilson intervals above
   rather than running a fresh normal approximation on the difference
   itself. That is what keeps this interval well behaved at extreme
   rates and small samples, the same reason Wilson was chosen for each
   rate individually.
   ==================================================================== */

export interface DifferenceInterval extends Interval {
  /** current rate minus baseline rate. Positive means current is
   * higher; this file makes no judgment about whether that is good. */
  diff: number;
}

export function differenceInterval(
  current: DriftSnapshot,
  baseline: DriftSnapshot,
  confidence: number,
): DifferenceInterval {
  const p1 = current.successes / current.n;
  const p2 = baseline.successes / baseline.n;
  const diff = p1 - p2;
  const w1 = wilsonInterval(current.successes, current.n, confidence);
  const w2 = wilsonInterval(baseline.successes, baseline.n, confidence);
  const lowerMargin = Math.sqrt((p1 - w1.lower) ** 2 + (w2.upper - p2) ** 2);
  const upperMargin = Math.sqrt((w1.upper - p1) ** 2 + (p2 - w2.lower) ** 2);
  return {
    diff,
    lower: Math.max(-1, diff - lowerMargin),
    upper: Math.min(1, diff + upperMargin),
  };
}

/* ====================================================================
   7. MULTIPLE COMPARISONS

   Monitor 20 metrics at alpha 0.05 and roughly one will read
   significant by chance alone even if nothing changed anywhere. The
   correction here is Bonferroni: divide alpha by the number of
   metrics monitored (equivalently, multiply the p value by it). It is
   the most conservative common correction and the easiest to explain,
   which is the point: a user who monitors many metrics needs to see a
   visibly stricter bar, not a footnote.
   ==================================================================== */

export function bonferroniAlpha(alpha: number, metricsMonitored: number): number {
  return alpha / Math.max(1, metricsMonitored);
}

export function bonferroniPValue(pValue: number, metricsMonitored: number): number {
  return Math.min(1, pValue * Math.max(1, metricsMonitored));
}

/* ====================================================================
   8. STATISTICAL POWER: MINIMUM DETECTABLE EFFECT

   Given the sample sizes actually collected, what is the smallest true
   difference this comparison could have caught? That reframes "not
   significant" from "nothing changed" to "nothing bigger than this
   moved", which is a very different claim when the answer is large.

   This deliberately does NOT compute "observed power" (power as a
   function of the effect actually seen). Observed power is a fixed,
   uninformative rescaling of the p value already reported elsewhere in
   this analysis and is considered bad practice in applied statistics
   for exactly that reason. What is useful, and what this computes
   instead, is the DESIGN question: at these sample sizes, independent
   of what was observed, what could this test have found?

   ASSUMPTION, stated because it does real work: this uses the fixed
   variance approximation standard in sample size calculators, treating
   the variance as roughly constant at the pooled rate across the
   range of effect sizes being asked about. It degrades for a
   hypothesized effect so large the two rates would sit far apart on
   the 0 to 1 scale, a case this number is not needed for: a change
   that big does not require a power calculation to notice.
   ==================================================================== */

export function minimumDetectableEffect(
  current: DriftSnapshot,
  baseline: DriftSnapshot,
  alpha: number,
  power: number,
): number {
  const pooledProportion =
    (current.successes + baseline.successes) / (current.n + baseline.n);
  const variance =
    pooledProportion * (1 - pooledProportion) * (1 / current.n + 1 / baseline.n);
  const pooledSE = Math.sqrt(variance);
  // Both groups pinned to the same boundary rate: see the z test's
  // matching guard above. There is no plug in variance to scale here.
  if (pooledSE === 0) return 0;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  return (zAlpha + zPower) * pooledSE;
}

/* ====================================================================
   9. ASSUMPTIONS, STATED RATHER THAN HIDDEN

   00-PRODUCT-VISION.md principle 3: assumptions must be visible. These
   are the ones every calculation above leans on and cannot check for
   itself; only the person reading the numbers knows if they hold.
   ==================================================================== */

export const ASSUMPTIONS_TEXT: string[] = [
  'Independence: every test case counted in a sample is assumed independent of every other. This tool only receives aggregate counts, not per case results, so it cannot detect correlated failures (for example, five failures that all trace to one flaky dependency counted as five independent data points).',
  'Unpaired design: baseline and current are treated as two independent samples. If the identical fixed test cases were scored in both, the two outcomes per case are actually paired, and a paired test such as the McNemar test would use that structure and detect a smaller real change. Because only aggregate counts are available here, this tool cannot run that test; the independent samples test it does run is typically the more conservative choice in that situation, not the less trustworthy one.',
  'Stationarity: each sample is assumed to reflect one stable underlying rate for the whole window it was collected in, not a rate that itself drifted while that window was being measured.',
  'Identical eval set: the comparison is only meaningful if baseline and current were scored against the same evaluation set. A changed eval set produces a changed pass rate on its own, with no statistical test able to tell that apart from a real behavior change.',
];

/* ====================================================================
   10. THE VERDICT

   Three honest answers, in plain language, from the numbers above:
     - real-change: the corrected confidence interval on the
       difference excludes zero.
     - noise: the interval includes zero, AND this comparison had
       enough power to have caught a change of the size that was said
       to matter, so its absence is informative.
     - insufficient-data: the interval includes zero, but this
       comparison could not have reliably detected a change as small as
       the size that was said to matter, so absence of significance
       here is not evidence of absence.
   A fourth state, invalid-comparison, exists outside that three way
   split for the one case where no verdict is honest at all: the eval
   set changed between measurements.
   ==================================================================== */

export type Verdict = 'real-change' | 'noise' | 'insufficient-data' | 'invalid-comparison';

export interface DriftAnalysis {
  baselineRate: number;
  currentRate: number;
  baselineInterval: WilsonInterval;
  currentInterval: WilsonInterval;
  zTest: ZTestResult;
  fisher: FisherResult;
  primary: PrimaryTestVerdict;
  /** The un corrected p value from whichever test is primary. */
  primaryPValue: number;
  /** That same p value after the Bonferroni correction. */
  adjustedPValue: number;
  adjustedAlpha: number;
  adjustedConfidence: number;
  differenceInterval: DifferenceInterval;
  minimumDetectableEffect: number;
  verdict: Verdict;
  verdictReason: string;
  warnings: string[];
}

function formatPoints(fraction: number): string {
  return `${(fraction * 100).toFixed(2)} points`;
}

function formatSignedPoints(fraction: number): string {
  const value = fraction * 100;
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)} points`;
}

export function analyzeDrift(state: DriftState): DriftAnalysis {
  const { current, baseline } = state;

  const adjustedAlpha = bonferroniAlpha(state.alpha, state.metricsMonitored);
  const adjustedConfidence = 1 - adjustedAlpha;
  const rawConfidence = 1 - state.alpha;

  const baselineInterval = wilsonInterval(baseline.successes, baseline.n, rawConfidence);
  const currentInterval = wilsonInterval(current.successes, current.n, rawConfidence);
  const zTest = twoProportionZTest(current, baseline);
  const fisher = fisherExactTest(current, baseline);
  const primary = describePrimaryTest(current, baseline, zTest.pooledProportion, fisher);
  const primaryPValue = primary.primaryTest === 'z' ? zTest.pValue : fisher.pValue;
  const adjustedPValue = bonferroniPValue(primaryPValue, state.metricsMonitored);

  // The verdict reads the DIFFERENCE interval at the corrected
  // confidence level, which is the Bonferroni correction applied as a
  // wider simultaneous interval rather than as a separate adjustment
  // bolted onto a p value: testing m hypotheses at family wise alpha
  // is equivalent to reading each one against a 1 - alpha/m interval.
  const diffInterval = differenceInterval(current, baseline, adjustedConfidence);
  const mde = minimumDetectableEffect(current, baseline, adjustedAlpha, state.targetPower);

  const warnings: string[] = [];
  if (state.metricsMonitored > 1) {
    warnings.push(
      `Monitoring ${state.metricsMonitored} metrics at once means a naive ${(state.alpha * 100).toFixed(0)} percent threshold would flag roughly one of them by chance alone even with no real change anywhere. Every number below that depends on significance already uses the corrected threshold: alpha ${adjustedAlpha.toFixed(4)}, confidence ${(adjustedConfidence * 100).toFixed(2)} percent.`,
    );
  }
  if (primary.primaryTest === 'fisher') {
    warnings.push(
      'Small sample regime: the exact test, not the z test, is the number to trust here.',
    );
  }

  let verdict: Verdict;
  let verdictReason: string;

  if (state.evalSetChanged === 'yes') {
    verdict = 'invalid-comparison';
    verdictReason =
      'The evaluation set changed between the two measurements. A changed pass rate could come entirely from the test cases being different, with no relationship to any change in the system. Every number above is still computed from what was entered, but none of them is a valid measure of drift until baseline and current are re run on an identical eval set.';
  } else {
    const excludesZero = diffInterval.lower > 0 || diffInterval.upper < 0;
    if (excludesZero) {
      verdict = 'real-change';
      verdictReason = `The confidence interval on the difference, ${formatSignedPoints(diffInterval.lower)} to ${formatSignedPoints(diffInterval.upper)}, does not include zero. This is a real change, not sampling noise, at the stated confidence level.`;
    } else if (mde > state.minMeaningfulEffect) {
      verdict = 'insufficient-data';
      verdictReason = `The interval on the difference includes zero, but at these sample sizes this comparison could only reliably detect a change of about ${formatPoints(mde)} or larger. That is bigger than the ${formatPoints(state.minMeaningfulEffect)} that was said to matter, so the absence of significance here is not evidence of absence. Collect more data before concluding anything either way.`;
    } else {
      verdict = 'noise';
      verdictReason = `The confidence interval on the difference includes zero, and this comparison had enough power to detect a change as small as ${formatPoints(mde)}, at or under the ${formatPoints(state.minMeaningfulEffect)} that was said to matter. If a real change that size existed, this comparison would likely have caught it. The observed movement is consistent with ordinary sampling noise.`;
    }
  }

  return {
    baselineRate: baseline.successes / baseline.n,
    currentRate: current.successes / current.n,
    baselineInterval,
    currentInterval,
    zTest,
    fisher,
    primary,
    primaryPValue,
    adjustedPValue,
    adjustedAlpha,
    adjustedConfidence,
    differenceInterval: diffInterval,
    minimumDetectableEffect: mde,
    verdict,
    verdictReason,
    warnings,
  };
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  'real-change': 'Real change',
  noise: 'Consistent with noise',
  'insufficient-data': 'Insufficient data to tell',
  'invalid-comparison': 'Invalid comparison',
};

/* ====================================================================
   11. SAMPLES

   03-SHARED-PLATFORM.md tool module contract requires a deterministic
   sample state. Four ship, each tuned (by running the real functions
   above, not by hand waving) to land on a different verdict, because
   the four way split IS the thing this tool teaches.
   ==================================================================== */

export interface Sample {
  id: string;
  name: string;
  teaches: string;
  state: DriftState;
}

export const SAMPLES: Sample[] = [
  {
    id: 'small-sample-cant-tell',
    name: 'A twelve point drop, forty runs in each group',
    teaches:
      'The verdict most tools refuse to give. The raw drop looks alarming, but forty runs per side is too small to tell a real regression from ordinary noise. More data is the honest answer, not a confident call either way.',
    state: {
      metricName: 'Eval pass rate',
      baseline: { n: 40, successes: 32 },
      current: { n: 40, successes: 27 },
      alpha: 0.05,
      metricsMonitored: 1,
      targetPower: 0.8,
      minMeaningfulEffect: 0.05,
      evalSetChanged: 'no',
    },
  },
  {
    id: 'scary-drop-is-noise',
    name: 'A six point drop that is noise',
    teaches:
      'A drop big enough to trigger an incident channel, on a sample large enough to trust its own silence: not significant, and well powered enough to have caught the ten point change that would actually matter here.',
    state: {
      metricName: 'Eval pass rate',
      baseline: { n: 500, successes: 250 },
      current: { n: 500, successes: 220 },
      alpha: 0.05,
      metricsMonitored: 1,
      targetPower: 0.8,
      minMeaningfulEffect: 0.1,
      evalSetChanged: 'no',
    },
  },
  {
    id: 'quiet-drop-is-real',
    name: 'An unremarkable two point drop, huge sample',
    teaches:
      'The other half of the same lesson: a two point movement that reads as barely worth mentioning is a real, statistically solid change once the sample is large enough to say so.',
    state: {
      metricName: 'Eval pass rate',
      baseline: { n: 50000, successes: 45000 },
      current: { n: 50000, successes: 44000 },
      alpha: 0.05,
      metricsMonitored: 1,
      targetPower: 0.8,
      minMeaningfulEffect: 0.05,
      evalSetChanged: 'no',
    },
  },
  {
    id: 'twenty-metrics-one-false-alarm',
    name: 'One metric out of twenty, borderline on its own',
    teaches:
      'The multiple comparisons trap: at the ordinary 0.05 level this single metric clears the bar by itself (p is about 0.023), but it is one of twenty being watched in the same sweep, and the corrected bar this tool applies says the evidence is not there yet.',
    state: {
      metricName: 'Metric 14 of 20 monitored',
      baseline: { n: 400, successes: 200 },
      current: { n: 400, successes: 232 },
      alpha: 0.05,
      metricsMonitored: 20,
      targetPower: 0.8,
      minMeaningfulEffect: 0.05,
      evalSetChanged: 'no',
    },
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

export function sampleState(id: string = SAMPLES[0].id): DriftState {
  const sample = getSample(id) ?? SAMPLES[0];
  return {
    ...sample.state,
    baseline: { ...sample.state.baseline },
    current: { ...sample.state.current },
  };
}

/* ====================================================================
   12. EXPORT

   03-SHARED-PLATFORM.md tool module contract: an optional export
   adapter, required here since the registry marks supportsExport true.
   Markdown carries the full plain language verdict and reasoning;
   JSON carries every number this file computed, for a user who wants
   to keep a record or feed it to something else.
   ==================================================================== */

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: DriftState, format: ExportFormat): string {
  const analysis = analyzeDrift(state);

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Drift Monitor',
        note: 'Local statistical analysis. No model or external service produced these numbers.',
        input: state,
        assumptions: ASSUMPTIONS_TEXT,
        analysis,
      },
      null,
      2,
    );
  }

  const lines = [
    '# Drift Monitor report',
    '',
    `Metric: ${state.metricName || '(unlabeled)'}`,
    '',
    'Local statistical analysis. No model or external service produced these numbers.',
    '',
    '## Verdict',
    '',
    `**${VERDICT_LABELS[analysis.verdict]}**`,
    '',
    analysis.verdictReason,
    '',
    '## Inputs',
    '',
    `- Baseline: ${state.baseline.successes} of ${state.baseline.n} (${formatPoints(analysis.baselineRate)})`,
    `- Current: ${state.current.successes} of ${state.current.n} (${formatPoints(analysis.currentRate)})`,
    `- Significance level (alpha): ${state.alpha}`,
    `- Metrics monitored together: ${state.metricsMonitored}`,
    `- Target power for minimum detectable effect: ${(state.targetPower * 100).toFixed(0)} percent`,
    `- Smallest change said to matter: ${formatPoints(state.minMeaningfulEffect)}`,
    `- Evaluation set changed between measurements: ${state.evalSetChanged}`,
    '',
    '## Rates and intervals',
    '',
    `- Baseline Wilson ${((1 - state.alpha) * 100).toFixed(0)} percent interval: ${formatPoints(analysis.baselineInterval.lower)} to ${formatPoints(analysis.baselineInterval.upper)}`,
    `- Current Wilson ${((1 - state.alpha) * 100).toFixed(0)} percent interval: ${formatPoints(analysis.currentInterval.lower)} to ${formatPoints(analysis.currentInterval.upper)}`,
    `- Difference (current minus baseline): ${formatSignedPoints(analysis.differenceInterval.diff)}`,
    `- ${(analysis.adjustedConfidence * 100).toFixed(2)} percent confidence interval on the difference: ${formatSignedPoints(analysis.differenceInterval.lower)} to ${formatSignedPoints(analysis.differenceInterval.upper)}`,
    '',
    '## Significance tests',
    '',
    `- Two proportion z test: z = ${analysis.zTest.z.toFixed(4)}, p = ${analysis.zTest.pValue.toFixed(4)}`,
    `- Fisher exact test: ${analysis.fisher.computed ? `p = ${analysis.fisher.pValue.toFixed(4)}` : analysis.fisher.note}`,
    `- Which applies: ${analysis.primary.reason}`,
    `- Bonferroni corrected p value for the primary test: ${analysis.adjustedPValue.toFixed(4)} (raw ${analysis.primaryPValue.toFixed(4)}, ${state.metricsMonitored} metric(s))`,
    '',
    '## Power',
    '',
    `- Minimum detectable effect at ${(state.targetPower * 100).toFixed(0)} percent power: ${formatPoints(analysis.minimumDetectableEffect)}`,
    '',
    '## Warnings',
    '',
    analysis.warnings.length ? analysis.warnings.map((w) => `1. ${w}`).join('\n') : 'None.',
    '',
    '## Assumptions',
    '',
    ...ASSUMPTIONS_TEXT.map((a) => `1. ${a}`),
    '',
  ];
  return lines.join('\n');
}

export function filename(_state: DriftState, _format: ExportFormat): string {
  return 'drift-monitor-report';
}
