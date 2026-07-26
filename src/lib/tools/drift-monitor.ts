/**
 * Drift Monitor.
 *
 * PRD: tools-nixfred-prds/tools/12-DRIFT-MONITOR.md
 * User outcome: compare two snapshots of an AI system, catch the
 * change nobody flagged, especially a widened permission, and tell a
 * real behavior change in the eval numbers apart from ordinary
 * sampling noise before you go chasing it.
 *
 * REVISION HISTORY, kept because the first version of this file
 * shipped the wrong tool and it is worth being honest about that. The
 * first build read the PRD's "evaluation results" input as the whole
 * product and implemented only a two proportion significance engine
 * (sections 1 through 12 below). That missed all four of the PRD's
 * actual acceptance criteria: it separated nothing, gave permissions
 * no treatment at all, cited no field paths, and had no versioned
 * snapshot format. This revision adds the snapshot differ the PRD
 * actually specifies as sections 13 onward, and PROMOTES IT to the
 * primary function. Sections 1 through 12 are UNCHANGED on purpose:
 * that engine was correct, every one of its 155 checks still passes,
 * and it is now the secondary panel that tests the "evaluation
 * results" field of each snapshot, one legitimate input among the
 * seven the PRD lists rather than the whole tool.
 *
 * THE WHOLE VALUE OF THIS TOOL IS GETTING THE MATH AND THE CITATIONS
 * RIGHT. A permission that quietly widened, a scary looking eval drop
 * that is actually noise, or an unremarkable drop that is actually
 * real, are all useless findings if the underlying arithmetic or the
 * field path pointing at them is wrong. Every function below states
 * its method and its assumptions rather than presenting a bare
 * conclusion, and tests/tool-drift-monitor.mjs checks each one against
 * a hand worked or independently derived reference value, or against a
 * path that is proven to resolve in the actual snapshot, not just
 * against itself.
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

/* ====================================================================
   13. SNAPSHOT SHAPE

   03-SHARED-PLATFORM.md and the PRD's own acceptance criterion 4:
   "snapshot format is versioned and exportable." SNAPSHOT_SCHEMA_VERSION
   is bumped whenever a field is added, renamed, or removed below, and
   validateSnapshot rejects anything that does not declare a version
   this file understands, rather than guessing at an old shape.

   The seven inputs are the PRD's own list: versioned prompts, tools,
   permissions, knowledge sources, model settings, evaluation results,
   and optional metrics. evaluation reuses DriftSnapshot from section 2
   above unchanged, which is what lets the significance engine run
   against it with no changes of its own.
   ==================================================================== */

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface PromptVersion {
  /** Stable identifier, e.g. "system-prompt". Field paths cite this. */
  id: string;
  /** Free text version label, e.g. "1.5.0" or a commit hash. */
  version: string;
  text: string;
}

export interface ToolDefinition {
  /** Stable identifier. Field paths cite this. */
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * Ordinal scale of how much a permission grants, widest last. The
 * order here, not the label text, is what widened and narrowed are
 * computed from, via permissionRank below.
 */
export const PERMISSION_LEVELS = [
  'none',
  'read-only',
  'scoped',
  'read-write',
  'unrestricted',
] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export function permissionRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

export interface PermissionGrant {
  /** Stable identifier, e.g. "filesystem", "network", "payments". */
  name: string;
  level: PermissionLevel;
  /** Free text scope description, e.g. "project directory only". */
  detail: string;
}

export interface KnowledgeSource {
  /** Stable identifier. Field paths cite this. */
  id: string;
  description: string;
}

export interface ModelSettings {
  modelName: string;
  temperature: number;
  maxOutputTokens: number;
  topP: number;
}

export interface MetricValue {
  /** Stable identifier, e.g. "p50-latency-ms". */
  key: string;
  value: number;
  unit?: string;
}

/**
 * Criterion 1: "separates intentional change from unexplained drift."
 * A changelog entry cites the same field path a finding would cite,
 * so isIntentional below is a direct lookup, not a fuzzy match. This
 * lives on the CURRENT snapshot because it explains what changed to
 * arrive at this snapshot from whatever came before it, the same way
 * a real release changelog does.
 */
export interface ChangelogEntry {
  path: string;
  note: string;
}

export interface SystemSnapshot {
  schemaVersion: number;
  /** Human label, e.g. "v1.5, this week's release". */
  label: string;
  /** Free text date or version marker. Not parsed, only displayed. */
  capturedAt: string;
  prompts: PromptVersion[];
  tools: ToolDefinition[];
  permissions: PermissionGrant[];
  knowledgeSources: KnowledgeSource[];
  modelSettings: ModelSettings;
  /** The one input with a real significance test behind it. See
   * section 2 through 10 above. */
  evaluation: DriftSnapshot;
  metrics: MetricValue[];
  changelog: ChangelogEntry[];
  /**
   * Field paths (or category prefixes) this snapshot's evaluation is
   * asserted to actually exercise. Empty by default, which is the
   * honest default: a single aggregate pass rate does not, on its own,
   * tell you which changed surface it covers. See
   * missingEvaluationCoverage below for what this drives.
   */
  evaluationCoverage: string[];
}

export function emptySnapshot(label: string): SystemSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    label,
    capturedAt: '',
    prompts: [],
    tools: [],
    permissions: [],
    knowledgeSources: [],
    modelSettings: { modelName: '', temperature: 0, maxOutputTokens: 0, topP: 1 },
    evaluation: { n: 0, successes: 0 },
    metrics: [],
    changelog: [],
    evaluationCoverage: [],
  };
}

/**
 * Shape and range checks. Deliberately permissive about label and
 * capturedAt (free text, not load bearing for any calculation) and
 * strict about everything the diff and significance engines actually
 * read, since a bad value there produces a silently wrong finding
 * rather than a loud error.
 */
export function validateSnapshot(snapshot: SystemSnapshot): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const req = (cond: boolean, field: string, message: string) => {
    if (!cond) issues.push({ field, message, severity: 'error' });
  };

  req(
    snapshot.schemaVersion === SNAPSHOT_SCHEMA_VERSION,
    'schemaVersion',
    `Snapshot schema version must be ${SNAPSHOT_SCHEMA_VERSION}, got ${snapshot.schemaVersion}.`,
  );
  req(Array.isArray(snapshot.prompts), 'prompts', 'Prompts must be an array.');
  req(Array.isArray(snapshot.tools), 'tools', 'Tools must be an array.');
  req(Array.isArray(snapshot.permissions), 'permissions', 'Permissions must be an array.');
  req(
    Array.isArray(snapshot.knowledgeSources),
    'knowledgeSources',
    'Knowledge sources must be an array.',
  );
  req(Array.isArray(snapshot.metrics), 'metrics', 'Metrics must be an array.');
  req(Array.isArray(snapshot.changelog), 'changelog', 'Changelog must be an array.');
  req(
    Array.isArray(snapshot.evaluationCoverage),
    'evaluationCoverage',
    'Evaluation coverage must be an array of field paths.',
  );

  for (const p of snapshot.permissions ?? []) {
    req(
      PERMISSION_LEVELS.includes(p.level),
      `permissions.${p.name}`,
      `Permission "${p.name}" has an unknown level "${p.level}". Must be one of ${PERMISSION_LEVELS.join(', ')}.`,
    );
  }

  const modelSettings = snapshot.modelSettings ?? ({} as ModelSettings);
  req(
    Number.isFinite(modelSettings.temperature),
    'modelSettings.temperature',
    'Model temperature must be a number.',
  );
  req(
    Number.isFinite(modelSettings.maxOutputTokens) && modelSettings.maxOutputTokens >= 0,
    'modelSettings.maxOutputTokens',
    'Max output tokens must be a number of at least 0.',
  );
  req(
    Number.isFinite(modelSettings.topP),
    'modelSettings.topP',
    'Model top P must be a number.',
  );

  const evaluation = snapshot.evaluation ?? ({} as DriftSnapshot);
  req(
    Number.isFinite(evaluation.n) && evaluation.n >= 1 && Number.isInteger(evaluation.n),
    'evaluation.n',
    'Evaluation sample size must be a whole number of at least 1.',
  );
  req(
    Number.isFinite(evaluation.successes) &&
      evaluation.successes >= 0 &&
      evaluation.successes <= (evaluation.n ?? 0) &&
      Number.isInteger(evaluation.successes),
    'evaluation.successes',
    'Evaluation successes must be a whole number between 0 and the sample size.',
  );

  return issues;
}

export function serializeSnapshot(snapshot: SystemSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export type ParsedSnapshot =
  | { ok: true; snapshot: SystemSnapshot }
  | { ok: false; error: string };

/**
 * Never throws. A tool that crashes the page on a malformed paste is
 * worse than one that shows a clear, specific parse error, per Law 7,
 * fail loudly rather than silently or catastrophically.
 */
export function parseSnapshotJSON(text: string): ParsedSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Snapshot must be a JSON object.' };
  }
  const candidate = raw as Partial<SystemSnapshot>;
  const filled: SystemSnapshot = {
    schemaVersion: candidate.schemaVersion ?? -1,
    label: candidate.label ?? '',
    capturedAt: candidate.capturedAt ?? '',
    prompts: candidate.prompts ?? [],
    tools: candidate.tools ?? [],
    permissions: candidate.permissions ?? [],
    knowledgeSources: candidate.knowledgeSources ?? [],
    modelSettings: candidate.modelSettings ?? { modelName: '', temperature: 0, maxOutputTokens: 0, topP: 1 },
    evaluation: candidate.evaluation ?? { n: 0, successes: 0 },
    metrics: candidate.metrics ?? [],
    changelog: candidate.changelog ?? [],
    evaluationCoverage: candidate.evaluationCoverage ?? [],
  };
  const issues = validateSnapshot(filled);
  const blocking = issues.filter((i) => i.severity === 'error');
  if (blocking.length) {
    return { ok: false, error: blocking.map((i) => i.message).join(' ') };
  }
  return { ok: true, snapshot: filled };
}

/* ====================================================================
   14. FIELD PATH RESOLUTION

   Criterion 3: "each finding cites its changed fields." A citation
   that cannot be traced back to the actual data is decoration, not
   evidence, the same lesson prompt-lab's exact character offsets
   teach for prompt text. resolveFieldPath is the trace: given a
   snapshot and a path a finding cited, it returns the real value at
   that path, or undefined if the path names nothing. tests/
   tool-drift-monitor.mjs calls this on every path every finding cites
   and checks it resolves where the finding's direction says it should.

   Path grammar: "<category>.<itemKey>" for a whole item, or
   "<category>.<itemKey>.<field>" for one field of it. modelSettings
   has no itemKey, since it is a single object rather than a keyed
   list: "modelSettings.temperature" resolves directly.
   ==================================================================== */

function findByKey<T>(items: T[] | undefined, key: string, getKey: (item: T) => string): T | undefined {
  return (items ?? []).find((item) => getKey(item) === key);
}

export function resolveFieldPath(snapshot: SystemSnapshot, path: string): unknown {
  const [category, ...rest] = path.split('.');

  switch (category) {
    case 'prompts': {
      const [id, field] = rest;
      const item = findByKey(snapshot.prompts, id, (p) => p.id);
      if (!item) return undefined;
      return field ? (item as Record<string, unknown>)[field] : item;
    }
    case 'tools': {
      const [name, field] = rest;
      const item = findByKey(snapshot.tools, name, (t) => t.name);
      if (!item) return undefined;
      return field ? (item as Record<string, unknown>)[field] : item;
    }
    case 'permissions': {
      const [name, field] = rest;
      const item = findByKey(snapshot.permissions, name, (p) => p.name);
      if (!item) return undefined;
      return field ? (item as Record<string, unknown>)[field] : item;
    }
    case 'knowledgeSources': {
      const [id, field] = rest;
      const item = findByKey(snapshot.knowledgeSources, id, (k) => k.id);
      if (!item) return undefined;
      return field ? (item as Record<string, unknown>)[field] : item;
    }
    case 'modelSettings': {
      const [field] = rest;
      if (!field) return snapshot.modelSettings;
      return (snapshot.modelSettings as unknown as Record<string, unknown>)[field];
    }
    case 'metrics': {
      const [key, field] = rest;
      const item = findByKey(snapshot.metrics, key, (m) => m.key);
      if (!item) return undefined;
      return field ? (item as Record<string, unknown>)[field] : item;
    }
    default:
      return undefined;
  }
}

/* ====================================================================
   15. STRUCTURED DIFF

   Criterion 3 again, plus criterion 2, permission expansion prominent,
   and criterion 1, intentional versus unexplained. Every category
   below produces DriftFinding records with the same shape, so sorting,
   the rollback checklist, and the missing coverage check all work
   against one uniform list regardless of which of the seven inputs a
   finding came from.
   ==================================================================== */

export type ChangeCategory =
  | 'prompt'
  | 'tool'
  | 'permission'
  | 'knowledge-source'
  | 'model-setting'
  | 'metric';

export type ChangeDirection = 'added' | 'removed' | 'modified' | 'widened' | 'narrowed';

/**
 * widened and narrowed exist ONLY for the permission category, on
 * purpose: those are the two words the PRD uses, and reserving them
 * for the one category that has a real ordinal scale (permissionRank
 * above) keeps them meaning exactly one thing everywhere they appear,
 * rather than becoming a vague synonym for "got bigger" applied loosely
 * to tools or prompts.
 */
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const RISK_RANK: Record<RiskLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export interface FieldChange {
  path: string;
  before: string;
  after: string;
}

export interface DriftFinding {
  /** Stable id, derived from the primary field path. */
  id: string;
  category: ChangeCategory;
  direction: ChangeDirection;
  risk: RiskLevel;
  /** One or more cited fields. The first is the primary one that
   * missing coverage and the rollback checklist key off of. */
  fields: FieldChange[];
  headline: string;
  likelyEffect: string;
  /** True when the current snapshot's changelog explains this exact
   * field path. Criterion 1: unmarked is unexplained drift. */
  intentional: boolean;
}

function isIntentional(current: SystemSnapshot, ...paths: string[]): boolean {
  const changelog = current.changelog ?? [];
  return paths.some((path) => changelog.some((entry) => entry.path === path));
}

function diffPrompts(baseline: SystemSnapshot, current: SystemSnapshot): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const before = byKeyMap(baseline.prompts, (p) => p.id);
  const after = byKeyMap(current.prompts, (p) => p.id);
  for (const id of allKeys(before, after)) {
    const b = before.get(id);
    const a = after.get(id);
    const path = `prompts.${id}`;
    if (!b && a) {
      findings.push({
        id: path,
        category: 'prompt',
        direction: 'added',
        risk: 'medium',
        fields: [{ path: `${path}.text`, before: '(not present)', after: a.text }],
        headline: `Prompt "${id}" is new, at version ${a.version}.`,
        likelyEffect:
          'A new instruction surface exists that did not exist in the baseline. Review it with the same scrutiny as any other instruction the model receives.',
        intentional: isIntentional(current, path, `${path}.text`),
      });
      continue;
    }
    if (b && !a) {
      findings.push({
        id: path,
        category: 'prompt',
        direction: 'removed',
        risk: 'medium',
        fields: [{ path: `${path}.text`, before: b.text, after: '(not present)' }],
        headline: `Prompt "${id}" was removed. It was at version ${b.version}.`,
        likelyEffect: 'Any behavior that depended on this instruction is now unconstrained by it.',
        intentional: isIntentional(current, path, `${path}.text`),
      });
      continue;
    }
    if (b && a && (b.text !== a.text || b.version !== a.version)) {
      findings.push({
        id: `${path}.text`,
        category: 'prompt',
        direction: 'modified',
        risk: 'medium',
        fields: [
          { path: `${path}.version`, before: b.version, after: a.version },
          { path: `${path}.text`, before: b.text, after: a.text },
        ],
        headline: `Prompt "${id}" changed from version ${b.version} to ${a.version}.`,
        likelyEffect:
          'Instruction text the model reads on every turn is different. This is usually the highest leverage change in the whole comparison and the least visible from the outside.',
        intentional: isIntentional(current, path, `${path}.text`, `${path}.version`),
      });
    }
  }
  return findings;
}

function diffTools(baseline: SystemSnapshot, current: SystemSnapshot): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const before = byKeyMap(baseline.tools, (t) => t.name);
  const after = byKeyMap(current.tools, (t) => t.name);
  for (const name of allKeys(before, after)) {
    const b = before.get(name);
    const a = after.get(name);
    const path = `tools.${name}`;
    if (!b && a) {
      findings.push({
        id: path,
        category: 'tool',
        direction: 'added',
        risk: a.enabled ? 'medium' : 'low',
        fields: [{ path: `${path}.enabled`, before: '(not present)', after: String(a.enabled) }],
        headline: `Tool "${name}" is new${a.enabled ? ' and enabled' : ', currently disabled'}.`,
        likelyEffect: a.enabled
          ? `The model can now call "${name}": ${a.description}`
          : 'Defined but disabled, so it grants no capability yet. Worth watching for a future change that flips it on.',
        intentional: isIntentional(current, path, `${path}.enabled`),
      });
      continue;
    }
    if (b && !a) {
      findings.push({
        id: path,
        category: 'tool',
        direction: 'removed',
        risk: 'low',
        fields: [{ path: `${path}.enabled`, before: String(b.enabled), after: '(not present)' }],
        headline: `Tool "${name}" was removed.`,
        likelyEffect: `Any behavior relying on "${name}" being callable will fail or fall back to something else.`,
        intentional: isIntentional(current, path, `${path}.enabled`),
      });
      continue;
    }
    if (b && a && b.enabled !== a.enabled) {
      findings.push({
        id: `${path}.enabled`,
        category: 'tool',
        direction: 'modified',
        risk: a.enabled ? 'medium' : 'low',
        fields: [{ path: `${path}.enabled`, before: String(b.enabled), after: String(a.enabled) }],
        headline: `Tool "${name}" was ${a.enabled ? 'enabled' : 'disabled'}.`,
        likelyEffect: a.enabled
          ? `The model gained the ability to call "${name}": ${a.description}`
          : `The model lost the ability to call "${name}".`,
        intentional: isIntentional(current, `${path}.enabled`),
      });
    }
    if (b && a && b.description !== a.description) {
      findings.push({
        id: `${path}.description`,
        category: 'tool',
        direction: 'modified',
        risk: 'info',
        fields: [{ path: `${path}.description`, before: b.description, after: a.description }],
        headline: `Tool "${name}" description text changed.`,
        likelyEffect:
          "The model's own sense of when to call this tool may shift, since it reads this description to decide.",
        intentional: isIntentional(current, `${path}.description`),
      });
    }
  }
  return findings;
}

/**
 * THE HEADLINE CATEGORY. Criterion 2: permission expansion receives
 * prominent treatment, and a narrowing is not the same event as a
 * widening. Both directions are computed from the same permissionRank
 * comparison; only the risk assigned and the language used differ.
 * An absent grant on either side counts as rank 0, "none", which is
 * what makes a brand new permission read as a widening from nothing
 * and a fully revoked one read as a narrowing to nothing, with no
 * special casing needed for either.
 */
function diffPermissions(baseline: SystemSnapshot, current: SystemSnapshot): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const before = byKeyMap(baseline.permissions, (p) => p.name);
  const after = byKeyMap(current.permissions, (p) => p.name);
  for (const name of allKeys(before, after)) {
    const b = before.get(name);
    const a = after.get(name);
    const beforeLevel: PermissionLevel = b?.level ?? 'none';
    const afterLevel: PermissionLevel = a?.level ?? 'none';
    const path = `permissions.${name}`;

    if (beforeLevel === afterLevel) {
      const beforeDetail = b?.detail ?? '';
      const afterDetail = a?.detail ?? '';
      if (beforeDetail !== afterDetail) {
        findings.push({
          id: `${path}.detail`,
          category: 'permission',
          direction: 'modified',
          risk: 'low',
          fields: [{ path: `${path}.detail`, before: beforeDetail || '(none)', after: afterDetail || '(none)' }],
          headline: `Permission "${name}" scope description changed while staying at the ${afterLevel} level.`,
          likelyEffect:
            'The boundary of what this permission covers moved without changing its overall level. Read the detail text; a level that did not change can still cover different ground.',
          intentional: isIntentional(current, path, `${path}.detail`),
        });
      }
      continue;
    }

    const widened = permissionRank(afterLevel) > permissionRank(beforeLevel);
    if (widened) {
      findings.push({
        id: path,
        category: 'permission',
        direction: 'widened',
        risk: afterLevel === 'unrestricted' ? 'critical' : 'high',
        fields: [{ path: `${path}.level`, before: beforeLevel, after: afterLevel }],
        headline: `Permission "${name}" widened from ${beforeLevel} to ${afterLevel}.`,
        likelyEffect: `The system can now do strictly more than the baseline allowed under "${name}"${
          a?.detail ? `. Current scope: ${a.detail}.` : '.'
        } Review this before anything else in the comparison, not after.`,
        intentional: isIntentional(current, path, `${path}.level`),
      });
    } else {
      findings.push({
        id: path,
        category: 'permission',
        direction: 'narrowed',
        risk: 'info',
        fields: [{ path: `${path}.level`, before: beforeLevel, after: afterLevel }],
        headline: `Permission "${name}" narrowed from ${beforeLevel} to ${afterLevel}.`,
        likelyEffect:
          'The system can now do strictly less than the baseline allowed here. This reduces blast radius. It is not the same event as a widening and is not treated as a risk.',
        intentional: isIntentional(current, path, `${path}.level`),
      });
    }
  }
  return findings;
}

function diffKnowledgeSources(baseline: SystemSnapshot, current: SystemSnapshot): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const before = byKeyMap(baseline.knowledgeSources, (k) => k.id);
  const after = byKeyMap(current.knowledgeSources, (k) => k.id);
  for (const id of allKeys(before, after)) {
    const b = before.get(id);
    const a = after.get(id);
    const path = `knowledgeSources.${id}`;
    if (!b && a) {
      findings.push({
        id: path,
        category: 'knowledge-source',
        direction: 'added',
        risk: 'medium',
        fields: [{ path: `${path}.description`, before: '(not present)', after: a.description }],
        headline: `Knowledge source "${id}" is new.`,
        likelyEffect: `The model can now draw on material it could not see before: ${a.description}`,
        intentional: isIntentional(current, path, `${path}.description`),
      });
      continue;
    }
    if (b && !a) {
      findings.push({
        id: path,
        category: 'knowledge-source',
        direction: 'removed',
        risk: 'low',
        fields: [{ path: `${path}.description`, before: b.description, after: '(not present)' }],
        headline: `Knowledge source "${id}" was removed.`,
        likelyEffect: 'Answers that relied on this source will lose that grounding.',
        intentional: isIntentional(current, path, `${path}.description`),
      });
      continue;
    }
    if (b && a && b.description !== a.description) {
      findings.push({
        id: `${path}.description`,
        category: 'knowledge-source',
        direction: 'modified',
        risk: 'info',
        fields: [{ path: `${path}.description`, before: b.description, after: a.description }],
        headline: `Knowledge source "${id}" description changed.`,
        likelyEffect: 'What this source actually covers may be different from what its name implies.',
        intentional: isIntentional(current, `${path}.description`),
      });
    }
  }
  return findings;
}

const MODEL_SETTING_RISK: Record<keyof ModelSettings, RiskLevel> = {
  modelName: 'high',
  temperature: 'medium',
  maxOutputTokens: 'low',
  topP: 'low',
};

const MODEL_SETTING_EFFECT: Record<keyof ModelSettings, string> = {
  modelName: 'A different model can differ in every dimension at once: capability, style, safety behavior, and cost.',
  temperature: 'Higher values spread the output distribution wider, so the same prompt gets less consistent answers.',
  maxOutputTokens: 'Changes the hard ceiling on response length, which can silently truncate output near the old limit.',
  topP: 'Changes how much of the probability distribution the model is allowed to sample from at each token.',
};

function diffModelSettings(baseline: SystemSnapshot, current: SystemSnapshot): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const keys = Object.keys(MODEL_SETTING_RISK) as Array<keyof ModelSettings>;
  for (const key of keys) {
    const b = baseline.modelSettings[key];
    const a = current.modelSettings[key];
    if (b === a) continue;
    const path = `modelSettings.${key}`;
    findings.push({
      id: path,
      category: 'model-setting',
      direction: 'modified',
      risk: MODEL_SETTING_RISK[key],
      fields: [{ path, before: String(b), after: String(a) }],
      headline: `Model setting "${key}" changed from ${b} to ${a}.`,
      likelyEffect: MODEL_SETTING_EFFECT[key],
      intentional: isIntentional(current, path),
    });
  }
  return findings;
}

/**
 * Purely informational. The one metric with a real significance test
 * behind it is evaluation, tested in section 10 above; these are
 * whatever else the snapshot chose to record, reported as a raw delta
 * with no claim about whether the delta is real.
 */
function diffMetrics(baseline: SystemSnapshot, current: SystemSnapshot): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const before = byKeyMap(baseline.metrics, (m) => m.key);
  const after = byKeyMap(current.metrics, (m) => m.key);
  for (const key of allKeys(before, after)) {
    const b = before.get(key);
    const a = after.get(key);
    const path = `metrics.${key}`;
    if (!b || !a) {
      findings.push({
        id: path,
        category: 'metric',
        direction: !b ? 'added' : 'removed',
        risk: 'info',
        fields: [
          {
            path,
            before: b ? String(b.value) : '(not present)',
            after: a ? String(a.value) : '(not present)',
          },
        ],
        headline: `Metric "${key}" ${!b ? 'is newly tracked' : 'is no longer tracked'}.`,
        likelyEffect:
          'Informational only. This is a raw value with no significance test behind it; see the evaluation results panel for the one number this tool tests rigorously.',
        intentional: isIntentional(current, path),
      });
      continue;
    }
    if (b.value !== a.value) {
      const delta = a.value - b.value;
      const unit = a.unit ?? b.unit ?? '';
      findings.push({
        id: path,
        category: 'metric',
        direction: 'modified',
        risk: 'info',
        fields: [{ path, before: String(b.value), after: String(a.value) }],
        headline: `Metric "${key}" moved from ${b.value}${unit} to ${a.value}${unit} (${delta >= 0 ? '+' : ''}${delta}${unit}).`,
        likelyEffect:
          'Informational only, not a significance tested comparison. If this is the number you actually need to trust statistically, it belongs in evaluation results instead, which does get tested.',
        intentional: isIntentional(current, path),
      });
    }
  }
  return findings;
}

function byKeyMap<T>(items: T[] | undefined, getKey: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items ?? []) map.set(getKey(item), item);
  return map;
}

function allKeys<T>(a: Map<string, T>, b: Map<string, T>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])];
}

/**
 * Sort order the UI and the export both use. Tier 0 is permission
 * widenings and ONLY permission widenings, so criterion 2, permission
 * expansion outranks everything else, holds regardless of what other
 * risk levels happen to be in play in a given comparison.
 */
function findingTier(f: DriftFinding): number {
  return f.category === 'permission' && f.direction === 'widened' ? 0 : 1;
}

export function sortFindings(findings: DriftFinding[]): DriftFinding[] {
  return [...findings].sort((x, y) => {
    const tierDiff = findingTier(x) - findingTier(y);
    if (tierDiff !== 0) return tierDiff;
    const riskDiff = RISK_RANK[x.risk] - RISK_RANK[y.risk];
    if (riskDiff !== 0) return riskDiff;
    return x.id.localeCompare(y.id);
  });
}

export function diffSnapshots(baseline: SystemSnapshot, current: SystemSnapshot): DriftFinding[] {
  const findings = [
    ...diffPermissions(baseline, current),
    ...diffTools(baseline, current),
    ...diffPrompts(baseline, current),
    ...diffKnowledgeSources(baseline, current),
    ...diffModelSettings(baseline, current),
    ...diffMetrics(baseline, current),
  ];
  return sortFindings(findings);
}

/* ====================================================================
   16. MISSING EVALUATION COVERAGE

   A genuinely useful output the PRD asks for by name: which changed
   surfaces have no eval touching them. Honest by construction, since
   evaluationCoverage defaults to empty: unless a snapshot explicitly
   declares what its evaluation exercises, every structural change
   reports as uncovered, which is the conservative, correct default
   rather than assuming coverage that was never demonstrated.
   ==================================================================== */

export interface MissingCoverageItem {
  path: string;
  category: ChangeCategory;
  description: string;
}

function pathIsCovered(path: string, coverage: string[]): boolean {
  return coverage.some((c) => path === c || path.startsWith(`${c}.`));
}

/** Strips a leaf field suffix back to the item level, so a prompt's
 * .text and .version changes collapse to one coverage question about
 * "prompts.system-prompt" rather than two. */
function primaryPathOf(finding: DriftFinding): string {
  const first = finding.fields[0]?.path ?? finding.id;
  return first.replace(/\.(level|enabled|text|version|description)$/, '');
}

export function missingEvaluationCoverage(
  findings: DriftFinding[],
  current: SystemSnapshot,
): MissingCoverageItem[] {
  const coverage = current.evaluationCoverage ?? [];
  const structural = findings.filter((f) => f.category !== 'metric');
  const seen = new Set<string>();
  const out: MissingCoverageItem[] = [];
  for (const f of structural) {
    const path = primaryPathOf(f);
    if (seen.has(path)) continue;
    seen.add(path);
    if (!pathIsCovered(path, coverage)) {
      out.push({ path, category: f.category, description: f.headline });
    }
  }
  return out;
}

/* ====================================================================
   17. ROLLBACK CHECKLIST

   Ordered by containment logic, not just by risk: cut off anything
   that grants new access first (a widened permission, then a newly
   capable tool), correct the model's own configuration next, then
   restore context (knowledge sources, prompts), and list capability
   REDUCTIONS (a narrowing, a removed tool) last, since reverting those
   would mean granting access back, not containing anything. Metrics
   are excluded entirely: they are observed numbers, not configuration,
   and there is nothing in a metric to revert.
   ==================================================================== */

export interface RollbackStep {
  order: number;
  path: string;
  instruction: string;
}

const ROLLBACK_ELIGIBLE: ChangeCategory[] = [
  'permission',
  'tool',
  'model-setting',
  'knowledge-source',
  'prompt',
];

function rollbackTier(f: DriftFinding): number {
  if (f.category === 'permission' && f.direction === 'widened') return 0;
  if (f.category === 'tool' && f.direction !== 'removed') return 1;
  if (f.category === 'model-setting') return 2;
  if (f.category === 'knowledge-source') return 3;
  if (f.category === 'prompt') return 4;
  return 5; // narrowed permissions, removed tools: capability reductions.
}

export function buildRollbackChecklist(findings: DriftFinding[]): RollbackStep[] {
  const eligible = findings.filter((f) => ROLLBACK_ELIGIBLE.includes(f.category));
  const ordered = [...eligible].sort((x, y) => {
    const tierDiff = rollbackTier(x) - rollbackTier(y);
    if (tierDiff !== 0) return tierDiff;
    const riskDiff = RISK_RANK[x.risk] - RISK_RANK[y.risk];
    if (riskDiff !== 0) return riskDiff;
    return x.id.localeCompare(y.id);
  });
  return ordered.map((f, i) => {
    const primary = f.fields[0];
    const urgency = f.intentional
      ? 'Marked intentional: confirm with whoever approved it before reverting.'
      : 'Unexplained: prioritize confirming and reverting this one.';
    return {
      order: i + 1,
      path: primary?.path ?? f.id,
      instruction: `Revert ${primary?.path ?? f.id} from "${primary?.after ?? '?'}" back to "${primary?.before ?? '?'}". ${urgency}`,
    };
  });
}

/* ====================================================================
   18. THE COMPARISON, TOP LEVEL

   Wires the structured diff (sections 13 through 17) to the
   significance engine (sections 2 through 10) by reading each
   snapshot's own evaluation field, so the two proportion machinery
   above runs completely unmodified. This is the primary tool module
   contract surface: DriftComparison is the state, analyzeComparison is
   the one function the page calls to get everything it renders.
   ==================================================================== */

export interface DriftComparison {
  baseline: SystemSnapshot;
  current: SystemSnapshot;
  /** Significance settings for the evaluation field. Same meaning as
   * the matching fields on DriftState in section 2. */
  alpha: number;
  metricsMonitored: number;
  targetPower: number;
  minMeaningfulEffect: number;
  evalSetChanged: EvalSetChanged;
}

export interface ComparisonAnalysis {
  findings: DriftFinding[];
  /** Permission widenings only, already the front of findings, split
   * out again so the UI can render them as a distinct callout. */
  headlineFindings: DriftFinding[];
  missingCoverage: MissingCoverageItem[];
  rollback: RollbackStep[];
  /** The full section 2 through 10 analysis, unmodified, run against
   * baseline.evaluation and current.evaluation. */
  significance: DriftAnalysis;
}

function toSignificanceState(comparison: DriftComparison): DriftState {
  return {
    metricName: `${comparison.current.label || 'current'} vs ${comparison.baseline.label || 'baseline'}`,
    baseline: comparison.baseline.evaluation,
    current: comparison.current.evaluation,
    alpha: comparison.alpha,
    metricsMonitored: comparison.metricsMonitored,
    targetPower: comparison.targetPower,
    minMeaningfulEffect: comparison.minMeaningfulEffect,
    evalSetChanged: comparison.evalSetChanged,
  };
}

export function analyzeComparison(comparison: DriftComparison): ComparisonAnalysis {
  const findings = diffSnapshots(comparison.baseline, comparison.current);
  return {
    findings,
    headlineFindings: findings.filter((f) => f.category === 'permission' && f.direction === 'widened'),
    missingCoverage: missingEvaluationCoverage(findings, comparison.current),
    rollback: buildRollbackChecklist(findings),
    significance: analyzeDrift(toSignificanceState(comparison)),
  };
}

function pushSignificanceIssues(
  issues: ValidationIssue[],
  comparison: Pick<
    DriftComparison,
    'alpha' | 'metricsMonitored' | 'targetPower' | 'minMeaningfulEffect' | 'evalSetChanged'
  >,
): void {
  if (!Number.isFinite(comparison.alpha) || comparison.alpha <= 0 || comparison.alpha >= 1) {
    issues.push({ field: 'alpha', message: 'Significance level must be strictly between 0 and 1.', severity: 'error' });
  }
  if (
    !Number.isFinite(comparison.metricsMonitored) ||
    comparison.metricsMonitored < 1 ||
    !Number.isInteger(comparison.metricsMonitored)
  ) {
    issues.push({
      field: 'metricsMonitored',
      message: 'Number of metrics monitored must be a whole number of at least 1.',
      severity: 'error',
    });
  }
  if (!Number.isFinite(comparison.targetPower) || comparison.targetPower <= 0 || comparison.targetPower >= 1) {
    issues.push({ field: 'targetPower', message: 'Target power must be strictly between 0 and 1.', severity: 'error' });
  }
  if (!Number.isFinite(comparison.minMeaningfulEffect) || comparison.minMeaningfulEffect <= 0) {
    issues.push({
      field: 'minMeaningfulEffect',
      message: 'The smallest change that matters must be greater than zero.',
      severity: 'error',
    });
  }
  if (comparison.evalSetChanged === 'yes') {
    issues.push({
      field: 'evalSetChanged',
      message: 'The evaluation set changed, so the significance panel cannot produce a valid verdict.',
      severity: 'warning',
    });
  }
}

export function validateComparison(comparison: DriftComparison): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const issue of validateSnapshot(comparison.baseline)) {
    issues.push({ ...issue, field: `baseline.${issue.field}` });
  }
  for (const issue of validateSnapshot(comparison.current)) {
    issues.push({ ...issue, field: `current.${issue.field}` });
  }
  pushSignificanceIssues(issues, comparison);
  return issues;
}

export function emptyComparison(): DriftComparison {
  return {
    baseline: emptySnapshot('Baseline'),
    current: emptySnapshot('Current'),
    alpha: 0.05,
    metricsMonitored: 1,
    targetPower: 0.8,
    minMeaningfulEffect: 0.05,
    evalSetChanged: 'no',
  };
}

export function resetComparison(): DriftComparison {
  return emptyComparison();
}

/* ====================================================================
   19. COMPARISON SAMPLES

   Criterion 4 again: "make the two sample snapshots real and
   loadable." Two ship, each a complete, schema valid snapshot pair
   rather than a fragment, and each tuned to teach a different half of
   the tool: one where a permission widened quietly and the eval
   number genuinely moved, one where every change is explained,
   a permission narrowed, and the eval movement is noise.
   ==================================================================== */

export interface ComparisonSample {
  id: string;
  name: string;
  teaches: string;
  comparison: DriftComparison;
}

export const COMPARISON_SAMPLES: ComparisonSample[] = [
  {
    id: 'unexplained-permission-widening',
    name: 'A release with a quiet permission widening',
    teaches:
      'The headline case this tool exists for. Network access widened from none to unrestricted and a new payments permission appeared, neither one in the changelog, alongside a prompt change that WAS explained. The eval score also genuinely dropped. Both facts matter and neither is obvious from a changelog alone.',
    comparison: {
      baseline: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        label: 'v1.4 baseline, last known good',
        capturedAt: '2026-06-01',
        prompts: [
          {
            id: 'system-prompt',
            version: '1.4.0',
            text: 'You are a support assistant. Answer using only the provided knowledge base. Escalate anything about billing disputes to a human.',
          },
        ],
        tools: [
          { name: 'search-knowledge-base', description: 'Full text search over the support knowledge base.', enabled: true },
          { name: 'create-ticket', description: 'Open a support ticket for a human to handle.', enabled: true },
        ],
        permissions: [
          { name: 'filesystem', level: 'read-only', detail: 'Read access to the knowledge base directory only.' },
          { name: 'network', level: 'none', detail: 'No outbound network access.' },
          { name: 'ticketing-system', level: 'scoped', detail: 'Create and read tickets, cannot close or delete them.' },
        ],
        knowledgeSources: [
          { id: 'kb-support-articles', description: 'Public facing support articles, 400 documents.' },
          { id: 'kb-internal-runbook', description: 'Internal escalation runbook, staff only.' },
        ],
        modelSettings: { modelName: 'claude-sonnet-5', temperature: 0.2, maxOutputTokens: 800, topP: 1 },
        evaluation: { n: 500, successes: 460 },
        metrics: [
          { key: 'p50-latency-ms', value: 820, unit: 'ms' },
          { key: 'cost-per-call-usd', value: 0.004, unit: 'usd' },
        ],
        changelog: [],
        evaluationCoverage: [],
      },
      current: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        label: "v1.5, this week's release",
        capturedAt: '2026-07-20',
        prompts: [
          {
            id: 'system-prompt',
            version: '1.5.0',
            text: 'You are a support assistant. Answer using the knowledge base and your own judgment when it is incomplete. Escalate anything about billing disputes to a human.',
          },
        ],
        tools: [
          { name: 'search-knowledge-base', description: 'Full text search over the support knowledge base.', enabled: true },
          { name: 'create-ticket', description: 'Open a support ticket for a human to handle.', enabled: true },
          { name: 'issue-refund', description: 'Issue a refund up to 50 dollars without approval.', enabled: true },
        ],
        permissions: [
          { name: 'filesystem', level: 'read-only', detail: 'Read access to the knowledge base directory only.' },
          { name: 'network', level: 'unrestricted', detail: 'No outbound restriction list configured.' },
          { name: 'ticketing-system', level: 'scoped', detail: 'Create and read tickets, cannot close or delete them.' },
          { name: 'payments', level: 'scoped', detail: 'Issue refunds up to 50 dollars per ticket.' },
        ],
        knowledgeSources: [
          { id: 'kb-support-articles', description: 'Public facing support articles, 420 documents.' },
          { id: 'kb-internal-runbook', description: 'Internal escalation runbook, staff only.' },
        ],
        modelSettings: { modelName: 'claude-sonnet-5', temperature: 0.4, maxOutputTokens: 800, topP: 1 },
        evaluation: { n: 500, successes: 430 },
        metrics: [
          { key: 'p50-latency-ms', value: 910, unit: 'ms' },
          { key: 'cost-per-call-usd', value: 0.005, unit: 'usd' },
        ],
        changelog: [
          { path: 'prompts.system-prompt', note: 'Loosened grounding language to reduce over escalation. Approved by product.' },
          { path: 'modelSettings.temperature', note: 'Raised temperature for more natural phrasing, per support team feedback.' },
        ],
        evaluationCoverage: ['prompts.system-prompt'],
      },
      alpha: 0.05,
      metricsMonitored: 1,
      targetPower: 0.8,
      minMeaningfulEffect: 0.05,
      evalSetChanged: 'no',
    },
  },
  {
    id: 'routine-explained-release',
    name: 'A routine release, fully explained',
    teaches:
      'What a clean release looks like. Every change has a changelog entry, a permission narrowed rather than widened, and the raw eval movement, which looks like a real one point drop, turns out to be noise once the interval is checked instead of the bare number.',
    comparison: {
      baseline: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        label: 'v2.0 baseline',
        capturedAt: '2026-05-01',
        prompts: [
          {
            id: 'summarizer-prompt',
            version: '2.0.0',
            text: 'Summarize the document in five bullet points for an executive reader.',
          },
        ],
        tools: [
          { name: 'fetch-document', description: 'Retrieve a document by id from the document store.', enabled: true },
        ],
        permissions: [
          { name: 'filesystem', level: 'read-write', detail: 'Read and write access to the scratch directory.' },
          { name: 'network', level: 'none', detail: 'No outbound network access.' },
        ],
        knowledgeSources: [{ id: 'kb-style-guide', description: 'Company writing style guide.' }],
        modelSettings: { modelName: 'claude-sonnet-5', temperature: 0.3, maxOutputTokens: 500, topP: 1 },
        evaluation: { n: 3000, successes: 1500 },
        metrics: [{ key: 'p50-latency-ms', value: 640, unit: 'ms' }],
        changelog: [],
        evaluationCoverage: [],
      },
      current: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        label: 'v2.1, security hardening pass',
        capturedAt: '2026-07-15',
        prompts: [
          {
            id: 'summarizer-prompt',
            version: '2.1.0',
            text: 'Summarize the document in five bullet points for an executive reader. Do not include numbers you cannot verify against the source text.',
          },
        ],
        tools: [
          { name: 'fetch-document', description: 'Retrieve a document by id from the document store.', enabled: true },
        ],
        permissions: [
          {
            name: 'filesystem',
            level: 'read-only',
            detail: 'Read access to the scratch directory. Write access removed in the security pass.',
          },
          { name: 'network', level: 'none', detail: 'No outbound network access.' },
        ],
        knowledgeSources: [{ id: 'kb-style-guide', description: 'Company writing style guide.' }],
        modelSettings: { modelName: 'claude-sonnet-5', temperature: 0.3, maxOutputTokens: 500, topP: 1 },
        evaluation: { n: 3000, successes: 1470 },
        metrics: [{ key: 'p50-latency-ms', value: 615, unit: 'ms' }],
        changelog: [
          {
            path: 'permissions.filesystem',
            note: 'Removed write access in the quarterly security hardening pass. Filesystem writes were unused in production.',
          },
          {
            path: 'prompts.summarizer-prompt',
            note: 'Added a verification clause after two Customer reports of fabricated numbers.',
          },
        ],
        evaluationCoverage: ['prompts.summarizer-prompt', 'permissions.filesystem'],
      },
      alpha: 0.05,
      metricsMonitored: 1,
      targetPower: 0.8,
      minMeaningfulEffect: 0.05,
      evalSetChanged: 'no',
    },
  },
];

export function getComparisonSample(id: string): ComparisonSample | undefined {
  return COMPARISON_SAMPLES.find((s) => s.id === id);
}

export function sampleComparison(id: string = COMPARISON_SAMPLES[0].id): DriftComparison {
  const sample = getComparisonSample(id) ?? COMPARISON_SAMPLES[0];
  // Structured clone via JSON round trip: cheap, and guarantees the
  // caller can mutate the returned comparison (for example, toggling
  // an intentional mark) without corrupting the shared sample constant.
  return JSON.parse(JSON.stringify(sample.comparison)) as DriftComparison;
}

/* ====================================================================
   20. COMPARISON EXPORT

   Criterion 4, the exportable half. JSON carries both full snapshots
   verbatim, so the output of this export is itself valid input to the
   two snapshot text boxes on the page: paste it back in and every
   number reproduces. Markdown carries the same plain language report
   structure as section 12's serialize, extended with the findings,
   the missing coverage list, and the rollback checklist ahead of the
   significance section.
   ==================================================================== */

export type ComparisonExportFormat = 'json' | 'markdown';

function directionWord(f: DriftFinding): string {
  return f.direction === 'widened'
    ? 'WIDENED'
    : f.direction === 'narrowed'
      ? 'narrowed'
      : f.direction === 'added'
        ? 'added'
        : f.direction === 'removed'
          ? 'removed'
          : 'modified';
}

function renderFindingLine(f: DriftFinding): string {
  const paths = f.fields.map((field) => field.path).join(', ');
  return `1. [${f.risk}] ${directionWord(f)} (${f.category}): ${f.headline} Fields: ${paths}. ${
    f.intentional ? 'Marked intentional.' : 'UNEXPLAINED.'
  } ${f.likelyEffect}`;
}

export function serializeComparison(comparison: DriftComparison, format: ComparisonExportFormat): string {
  const analysis = analyzeComparison(comparison);

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Drift Monitor',
        note: 'Local structured diff and statistical analysis. No model or external service produced these findings.',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        baseline: comparison.baseline,
        current: comparison.current,
        significanceSettings: {
          alpha: comparison.alpha,
          metricsMonitored: comparison.metricsMonitored,
          targetPower: comparison.targetPower,
          minMeaningfulEffect: comparison.minMeaningfulEffect,
          evalSetChanged: comparison.evalSetChanged,
        },
        findings: analysis.findings,
        missingCoverage: analysis.missingCoverage,
        rollback: analysis.rollback,
        significance: analysis.significance,
      },
      null,
      2,
    );
  }

  const lines = [
    '# Drift Monitor report',
    '',
    `Baseline: ${comparison.baseline.label || '(unlabeled)'} (${comparison.baseline.capturedAt || 'no date given'})`,
    `Current: ${comparison.current.label || '(unlabeled)'} (${comparison.current.capturedAt || 'no date given'})`,
    '',
    'Local structured diff and statistical analysis. No model or external service produced these findings.',
    '',
    '## Findings, permission widenings first',
    '',
    analysis.findings.length
      ? analysis.findings.map(renderFindingLine).join('\n')
      : 'No structural or metric changes detected between the two snapshots.',
    '',
    '## Missing evaluation coverage',
    '',
    analysis.missingCoverage.length
      ? analysis.missingCoverage.map((m) => `1. ${m.description} (${m.path}) has no declared evaluation coverage.`).join('\n')
      : 'Every changed surface is declared as covered by the current snapshot evaluationCoverage list.',
    '',
    '## Rollback checklist, in order',
    '',
    analysis.rollback.length
      ? analysis.rollback.map((r) => `${r.order}. ${r.instruction}`).join('\n')
      : 'No configuration change requires a rollback step.',
    '',
    '## Evaluation results, significance panel',
    '',
    `Verdict: ${VERDICT_LABELS[analysis.significance.verdict]}`,
    analysis.significance.verdictReason,
    '',
    `Baseline: ${comparison.baseline.evaluation.successes} of ${comparison.baseline.evaluation.n} (${formatPoints(analysis.significance.baselineRate)})`,
    `Current: ${comparison.current.evaluation.successes} of ${comparison.current.evaluation.n} (${formatPoints(analysis.significance.currentRate)})`,
    `Confidence interval on the difference (${(analysis.significance.adjustedConfidence * 100).toFixed(2)} percent): ${formatSignedPoints(analysis.significance.differenceInterval.lower)} to ${formatSignedPoints(analysis.significance.differenceInterval.upper)}`,
    `Two proportion z test: z = ${analysis.significance.zTest.z.toFixed(4)}, p = ${analysis.significance.zTest.pValue.toFixed(4)}`,
    `Fisher exact test: ${analysis.significance.fisher.computed ? `p = ${analysis.significance.fisher.pValue.toFixed(4)}` : analysis.significance.fisher.note}`,
    `Which applies: ${analysis.significance.primary.reason}`,
    `Minimum detectable effect at ${(comparison.targetPower * 100).toFixed(0)} percent power: ${formatPoints(analysis.significance.minimumDetectableEffect)}`,
    '',
    '## Assumptions behind the significance panel',
    '',
    ...ASSUMPTIONS_TEXT.map((a) => `1. ${a}`),
    '',
  ];
  return lines.join('\n');
}

export function comparisonFilename(_comparison: DriftComparison, _format: ComparisonExportFormat): string {
  return 'drift-monitor-comparison-report';
}
