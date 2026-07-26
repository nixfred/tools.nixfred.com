/**
 * Latency Budgeter, analysis engine.
 *
 * PRD: tools-nixfred-prds/tools/10-LATENCY-BUDGETER.md
 * User outcome: find out which stage of an AI pipeline spends the most
 * user patience, before shipping it.
 *
 * HARD BOUNDARY FROM THE PRD: "Results are planning estimates. The tool
 * does not perform live network tests in its first release." Nothing
 * in this file measures a real network or a real model. Every number
 * is a deterministic function of the stages the user describes, and
 * the UI says so next to every result.
 *
 * THE STATISTIC THIS TOOL EXISTS TO TEACH: p99 latencies do not add.
 * Summing the p99 of every stage in a pipeline massively overestimates
 * the true p99, because it silently assumes every stage hits its own
 * worst case on the same request, which is rare. This file composes
 * latency honestly instead:
 *
 *   1. Each stage's p50 and p99 are fit to a lognormal curve, the
 *      standard shape for a latency distribution: always positive,
 *      right skewed, and fully pinned down by two points.
 *   2. Independent stages IN SERIES combine by summing their means and
 *      their variances. Summing means is always exact, no assumption
 *      needed. Summing variances is exact under one assumption: the
 *      stages are independent. That assumption is stated everywhere a
 *      composed result appears, because it is the assumption most
 *      likely to be false in production, where a saturated shared
 *      resource (a GPU queue, a rate limit, a connection pool) makes
 *      every stage slow down together instead of independently.
 *   3. A lognormal is refit to the combined mean and variance (the
 *      Fenton-Wilkinson moment match) to read a composed p50 and p99
 *      back out. This refit step is the one approximation in the
 *      whole model. It is exact when combining a single stage and
 *      approximate when combining two or more, which is exactly the
 *      case that matters.
 *   4. Stages IN PARALLEL do not sum and do not simply take the max of
 *      each other's stated percentiles either. A parallel group
 *      finishes when its slowest member finishes, so its own p50 and
 *      p99 come from the distribution of the MAXIMUM of the members,
 *      computed from their fitted curves by solving for where the
 *      product of their CDFs crosses the target percentile. This is
 *      plain root finding (bisection), not sampling, so it is exact
 *      given the lognormal assumption and byte-for-byte reproducible.
 *
 * No Monte Carlo runs in this file. The whole model reduces to closed
 * form curve fitting and bisection, both of which are pure arithmetic:
 * the same input always produces the same output without needing a
 * seeded random source to make that true.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Stage shape
 * ------------------------------------------------------------------ */

/** The seven stage kinds the PRD names. A pipeline is built from these. */
export const STAGE_KINDS = [
  'network',
  'queue-wait',
  'retrieval',
  'rerank',
  'model-call',
  'tool-call',
  'post-processing',
] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const STAGE_KIND_LABELS: Record<StageKind, string> = {
  network: 'Network',
  'queue-wait': 'Queue wait',
  retrieval: 'Retrieval',
  rerank: 'Rerank',
  'model-call': 'Model call',
  'tool-call': 'Tool call',
  'post-processing': 'Post processing',
};

/** Seed values for a freshly added stage, chosen to be plausible, not correct. */
const KIND_DEFAULTS: Record<StageKind, { p50: number; p99: number }> = {
  network: { p50: 30, p99: 90 },
  'queue-wait': { p50: 20, p99: 250 },
  retrieval: { p50: 100, p99: 260 },
  rerank: { p50: 70, p99: 180 },
  'model-call': { p50: 900, p99: 2200 },
  'tool-call': { p50: 150, p99: 400 },
  'post-processing': { p50: 40, p99: 100 },
};

/** Whether a stage runs after the previous one finishes, or alongside it. */
export type StageRelation = 'series' | 'parallel';

/** A retry may run at most this many times. Kept small so the exact
 * enumeration below stays cheap and so the UI cannot describe a stage
 * that retries forever. */
export const MAX_RETRY_ATTEMPTS = 5;

/** Utilization is capped below 1, where the queueing multiplier below
 * would diverge to infinity. 0.97 already caps the multiplier at
 * about 33x, an extreme value worth a warning rather than a bigger
 * cap. */
export const MAX_UTILIZATION = 0.97;

export interface Stage {
  id: string;
  /** User facing name. Defaults to the kind label but is editable,
   * because a pipeline often has two stages of the same kind. */
  label: string;
  kind: StageKind;
  /** Milliseconds. Median latency of a single attempt. */
  p50: number;
  /** Milliseconds. 99th percentile latency of a single attempt. */
  p99: number;
  /** Ignored on the first stage of a pipeline, which has no previous
   * stage to be in series with or parallel to. */
  relation: StageRelation;
  /** Streaming stages report a separate time to first token. The PRD:
   * "a streaming UI changes perceived latency completely." p50/p99
   * above remain time to LAST token, i.e. full completion. */
  streaming: boolean;
  /** Milliseconds. Only meaningful when streaming is true. */
  firstTokenP50: number;
  firstTokenP99: number;
  /** Total attempts allowed, including the first. 1 means no retry. */
  retryAttempts: number;
  /** Probability, 0 to just under 1, that a single attempt fails and
   * must be retried (subject to retryAttempts). */
  retryFailureRate: number;
  /** Fraction, 0 to MAX_UTILIZATION, of how loaded the shared resource
   * behind this stage is: a GPU pool, a connection pool, the queue
   * server itself. 0 means no contention. This scales the stage's
   * stated latency BEFORE retries are applied, because retries change
   * how many attempts a request takes while contention changes how
   * long any one attempt takes in the first place. */
  utilization: number;
}

let stageCounter = 0;

/** Factory for a new stage row in the builder UI. Not used by the
 * shipped sample, which hardcodes stable ids instead. */
export function createStage(kind: StageKind, relation: StageRelation = 'series'): Stage {
  stageCounter += 1;
  const defaults = KIND_DEFAULTS[kind];
  return {
    id: `stage-${stageCounter}`,
    label: STAGE_KIND_LABELS[kind],
    kind,
    p50: defaults.p50,
    p99: defaults.p99,
    relation,
    streaming: false,
    firstTokenP50: 0,
    firstTokenP99: 0,
    retryAttempts: 1,
    retryFailureRate: 0,
    utilization: 0,
  };
}

export interface Pipeline {
  stages: Stage[];
}

export interface LatencyState {
  baseline: Pipeline;
  proposed: Pipeline;
  /** Milliseconds. What the user promised whoever is waiting. */
  budgetMs: number;
}

/* ------------------------------------------------------------------ *
 * Lognormal curve fitting
 *
 * A stage (or a resolved group) is characterized entirely by its p50
 * and p99, exactly the two numbers this tool asks for. Fitting a
 * lognormal to two percentiles has a closed form: the median of a
 * lognormal is exp(mu) regardless of spread, so mu = ln(p50) always,
 * and sigma falls out of where p99 lands relative to the median.
 * ------------------------------------------------------------------ */

/** Standard normal 99th percentile. A well known constant; no inverse
 * CDF solver needed since 0.5 and 0.99 are the only quantiles this
 * tool ever asks for, and the median needs no constant at all (z=0). */
const Z99 = 2.3263478740408408;

/** Floor on milliseconds so a stray zero cannot send ln() to -Infinity. */
const MIN_MS = 0.01;

/** Rounds to the nearest millisecond for every formula sentence and
 * every export in this file, so a number a user reads in one place
 * always matches the number behind the sentence explaining it. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export interface LogNormalFit {
  mu: number;
  sigma: number;
}

export function fitLognormal(p50: number, p99: number): LogNormalFit {
  const safeP50 = Math.max(p50, MIN_MS);
  // p99 is nudged a hair above p50 when they arrive equal so sigma is
  // a small positive number rather than exactly zero. A stage that is
  // genuinely deterministic still behaves correctly this way: every
  // formula downstream degrades gracefully as sigma shrinks toward 0,
  // none of them divide by it in a way that blows up.
  const safeP99 = Math.max(p99, safeP50 * (1 + 1e-6));
  const mu = Math.log(safeP50);
  const sigma = Math.log(safeP99 / safeP50) / Z99;
  return { mu, sigma };
}

export function percentilesFromFit(fit: LogNormalFit): { p50: number; p99: number } {
  return { p50: Math.exp(fit.mu), p99: Math.exp(fit.mu + Z99 * fit.sigma) };
}

export interface Moments {
  mean: number;
  variance: number;
}

export function momentsFromFit(fit: LogNormalFit): Moments {
  const { mu, sigma } = fit;
  const mean = Math.exp(mu + (sigma * sigma) / 2);
  const variance = (Math.exp(sigma * sigma) - 1) * Math.exp(2 * mu + sigma * sigma);
  return { mean, variance };
}

/**
 * Fenton-Wilkinson moment match: refit a lognormal to a combined mean
 * and variance. Exact when the moments came from a single lognormal
 * (this is a bijection in that case, verified by round trip in the
 * test file). Approximate when the moments are a SUM of several
 * lognormals' moments, because a sum of lognormals is not itself
 * exactly lognormal. It is the standard, widely used approximation
 * for this problem and it is what makes composed percentiles readable
 * instead of leaving the caller holding a mean and a variance.
 */
export function fitFromMoments(moments: Moments): LogNormalFit {
  const mean = Math.max(moments.mean, MIN_MS);
  const variance = Math.max(moments.variance, 0);
  const sigma2 = Math.log(1 + variance / (mean * mean));
  const sigma = Math.sqrt(sigma2);
  const mu = Math.log(mean) - sigma2 / 2;
  return { mu, sigma };
}

/**
 * Series composition of independent stages: sum the means (exact,
 * always) and sum the variances (exact under independence), then
 * refit a lognormal to read percentiles back off the combined curve.
 */
function composeSeries(fits: LogNormalFit[]): LogNormalFit {
  const total = fits.reduce(
    (acc, fit) => {
      const m = momentsFromFit(fit);
      return { mean: acc.mean + m.mean, variance: acc.variance + m.variance };
    },
    { mean: 0, variance: 0 },
  );
  return fitFromMoments(total);
}

/* ------------------------------------------------------------------ *
 * Parallel composition: the distribution of a maximum
 *
 * For independent members, P(max <= t) is the PRODUCT of each
 * member's own P(X_i <= t). There is no closed form percentile of
 * that product in general, so this solves for it by bisection: pick a
 * point, evaluate the product of CDFs, and narrow the bracket until
 * it lands on the target quantile. Bisection is deterministic and
 * needs no random source, unlike sampling the same question would.
 * ------------------------------------------------------------------ */

/**
 * Abramowitz and Stegun 7.1.26. Maximum error 1.5e-7, comfortably
 * below anything a millisecond latency figure needs.
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
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function cdfAt(fit: LogNormalFit, t: number): number {
  if (t <= 0) return 0;
  return normalCdf((Math.log(t) - fit.mu) / fit.sigma);
}

/**
 * The q-th quantile of max(X_1..X_n) for independent lognormal X_i.
 * Only q = 0.5 and q = 0.99 are ever requested by this file, which is
 * why a single member short circuits straight to the closed form
 * instead of bisecting against itself.
 */
export function quantileOfMax(fits: LogNormalFit[], q: number): number {
  if (fits.length === 0) return 0;
  if (fits.length === 1) {
    const z = q === 0.5 ? 0 : Z99;
    return Math.exp(fits[0].mu + z * fits[0].sigma);
  }

  const cdfMax = (t: number) => fits.reduce((acc, fit) => acc * cdfAt(fit, t), 1);

  let hi = Math.exp(Math.max(...fits.map((f) => f.mu + 6 * f.sigma)));
  let guard = 0;
  while (cdfMax(hi) < q && guard < 60) {
    hi *= 2;
    guard += 1;
  }

  let lo = 0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (cdfMax(mid) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ------------------------------------------------------------------ *
 * Concurrency
 *
 * The PRD's input list names "concurrency assumptions" as its own
 * item, distinct from retries. A retry changes how many attempts a
 * request takes; concurrency changes how long any ONE attempt takes,
 * because every stage here runs against a shared resource, a GPU
 * pool, a connection pool, the queue server itself, that slows down
 * as more requests contend for it at once. Concurrency is also where
 * the independence assumption stated throughout this file is most
 * likely to fail in production: contention is exactly the mechanism
 * that makes repeated calls to the same resource stop behaving
 * independently of each other.
 * ------------------------------------------------------------------ */

/**
 * The M/M/1 wait time multiplier, a standard queueing theory result:
 * as utilization (rho) approaches 1, wait time grows toward infinity,
 * not linearly. This is deliberately the simplest model that shows
 * that shape. It is a first order approximation of a real system, not
 * a simulation of one, and the UI says so next to every number it
 * produces.
 */
export function concurrencyMultiplier(utilization: number): number {
  const rho = Math.min(Math.max(utilization, 0), MAX_UTILIZATION);
  return 1 / (1 - rho);
}

function applyConcurrency(p50: number, p99: number, utilization: number): { p50: number; p99: number } {
  if (utilization <= 0) return { p50, p99 };
  const factor = concurrencyMultiplier(utilization);
  return { p50: p50 * factor, p99: p99 * factor };
}

/* ------------------------------------------------------------------ *
 * Retries
 *
 * The PRD's inputs list names retries explicitly and requires that
 * "retry and tail-latency effects are visible." A stage's stated p50
 * and p99 describe a SINGLE attempt. If it retries on failure, the
 * observed latency is the sum of however many attempts it took, and
 * that inflates the tail far more than the median, which is exactly
 * the shape a retry problem takes in production.
 * ------------------------------------------------------------------ */

/**
 * Exact mean and variance of the number of attempts taken, for a
 * stage that retries up to maxAttempts times with each attempt
 * independently failing with probability p. This is a truncated
 * geometric distribution: attempt k happens with probability
 * p^(k-1), and the process stops for good at maxAttempts whether or
 * not that last attempt succeeded, since there is nothing left to
 * retry into. maxAttempts is capped low (MAX_RETRY_ATTEMPTS) so this
 * direct enumeration is cheap and exact, no approximation needed.
 */
function attemptCountMoments(maxAttempts: number, failureRate: number): Moments {
  const p = Math.min(Math.max(failureRate, 0), 0.999999);
  let expectedN = 0;
  let expectedN2 = 0;
  for (let k = 1; k <= maxAttempts; k++) {
    const prob = k < maxAttempts ? Math.pow(p, k - 1) * (1 - p) : Math.pow(p, k - 1);
    expectedN += k * prob;
    expectedN2 += k * k * prob;
  }
  return { mean: expectedN, variance: Math.max(expectedN2 - expectedN * expectedN, 0) };
}

export interface StageLatencyBreakdown {
  /** After concurrency scaling only, before retries. */
  concurrencyAdjustedP50: number;
  concurrencyAdjustedP99: number;
  /** After concurrency AND retries. What every downstream calculation
   * (grouping, composition, the dominant stage search) actually uses. */
  effectiveP50: number;
  effectiveP99: number;
  /** Inspectable prose: PRD acceptance criterion "Formulas are
   * inspectable." Shows the exact arithmetic from stage.p50/p99 to
   * effectiveP50/P99, using the real numbers for this stage. */
  formula: string;
}

/**
 * Concurrency scales the stage's own stated latency first, then
 * retries compound on top of THAT scaled latency, because a retried
 * attempt is still subject to the same contention as the first one.
 *
 * The retry step uses the standard random sum result for "N i.i.d.
 * attempt latencies, N itself random": Var[sum] = E[N] Var[X] +
 * Var[N] E[X]^2. It holds because whether an attempt fails is
 * modeled as independent of how long that attempt took, which is the
 * retry equivalent of this file's stated independence assumption.
 */
function computeStageLatency(stage: Stage): StageLatencyBreakdown {
  const concurrencyAdjusted = applyConcurrency(stage.p50, stage.p99, stage.utilization);

  const concurrencySentence =
    stage.utilization <= 0
      ? 'No contention modeled (0 percent utilization), so this stage runs at its stated latency before retries.'
      : (() => {
          const factor = concurrencyMultiplier(stage.utilization);
          return (
            `At ${(stage.utilization * 100).toFixed(0)} percent utilization of the shared resource behind ` +
            `this stage, the queueing multiplier 1 divided by (1 minus ${stage.utilization.toFixed(2)}) equals ` +
            `${factor.toFixed(2)}x. ${fmt(stage.p50)} ms times ${factor.toFixed(2)} equals ${fmt(concurrencyAdjusted.p50)} ms ` +
            `at p50, and ${fmt(stage.p99)} ms times the same multiplier equals ${fmt(concurrencyAdjusted.p99)} ms at p99.`
          );
        })();

  let effective = concurrencyAdjusted;
  let retrySentence: string;
  if (stage.retryAttempts <= 1 || stage.retryFailureRate <= 0) {
    retrySentence = 'No retries configured (1 attempt allowed), so the effective latency equals the figure above.';
  } else {
    const base = fitLognormal(concurrencyAdjusted.p50, concurrencyAdjusted.p99);
    const attempt = momentsFromFit(base);
    const n = attemptCountMoments(stage.retryAttempts, stage.retryFailureRate);
    const combined: Moments = {
      mean: n.mean * attempt.mean,
      variance: n.mean * attempt.variance + n.variance * attempt.mean * attempt.mean,
    };
    effective = percentilesFromFit(fitFromMoments(combined));
    retrySentence =
      `Up to ${stage.retryAttempts} attempts with a ${(stage.retryFailureRate * 100).toFixed(1)} percent chance ` +
      `each attempt fails gives an expected ${n.mean.toFixed(3)} attempts. ${n.mean.toFixed(3)} attempts times a ` +
      `${fmt(attempt.mean)} ms mean per attempt equals ${fmt(combined.mean)} ms mean, refit to p50 ${fmt(effective.p50)} ms ` +
      `and p99 ${fmt(effective.p99)} ms. The tail moves more than the median because an unlucky retry adds a ` +
      `whole extra latency draw on top of an already unlucky first attempt.`;
  }

  return {
    concurrencyAdjustedP50: concurrencyAdjusted.p50,
    concurrencyAdjustedP99: concurrencyAdjusted.p99,
    effectiveP50: effective.p50,
    effectiveP99: effective.p99,
    formula: `${concurrencySentence} ${retrySentence}`,
  };
}

/* ------------------------------------------------------------------ *
 * Grouping: series stages start a new group, a parallel stage joins
 * the group of the stage immediately before it. A run of consecutive
 * parallel flagged stages therefore all land in one group and all
 * start together, which is what "parallel with the previous stage"
 * has to mean for more than two stages to ever run concurrently.
 * ------------------------------------------------------------------ */

function buildGroups(stages: Stage[]): number[][] {
  const groups: number[][] = [];
  stages.forEach((stage, i) => {
    if (i === 0 || stage.relation === 'series') {
      groups.push([i]);
    } else {
      groups[groups.length - 1].push(i);
    }
  });
  return groups;
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export interface StageComputed {
  index: number;
  stage: Stage;
  /** After concurrency scaling only, before retries. */
  concurrencyAdjustedP50: number;
  concurrencyAdjustedP99: number;
  /** After concurrency AND retries. What grouping, composition, and
   * the dominant stage search all actually use. */
  effectiveP50: number;
  effectiveP99: number;
  concurrencyTaxP50: number;
  concurrencyTaxP99: number;
  retryTaxP50: number;
  retryTaxP99: number;
  groupIndex: number;
  /** True for the one member of its group whose own effective p50 is
   * the largest, i.e. the member that sets the group's pace. */
  onCriticalPath: boolean;
  /** PRD acceptance criterion: "Formulas are inspectable." Shows the
   * real arithmetic from this stage's stated p50/p99 to its effective
   * p50/p99. */
  formula: string;
}

export interface GroupComputed {
  index: number;
  memberIndices: number[];
  p50: number;
  p99: number;
  criticalIndex: number;
  formula: string;
}

export interface HalvedResult {
  stageIndex: number;
  totalP50: number;
  totalP99: number;
  /** How much totalP50 actually dropped. */
  reductionP50: number;
  reductionPercent: number;
  /** Half of the dominant stage's own effective p50. What a reader
   * would guess the reduction should be before accounting for Amdahl
   * saturation. */
  naivePredictedReduction: number;
  /** True when the actual reduction fell meaningfully short of the
   * naive prediction, which happens when the dominant stage shares a
   * parallel group with another member that becomes the new
   * bottleneck once the first one is no longer the slowest. */
  saturated: boolean;
  formula: string;
}

export interface BudgetVerdict {
  ms: number;
  fitsTotalP50: boolean;
  fitsTotalP99: boolean;
  fitsTtftP50: boolean;
  fitsTtftP99: boolean;
}

export interface PipelineResult {
  stages: StageComputed[];
  groups: GroupComputed[];
  /** Time to LAST token, i.e. full completion. Composed honestly, not
   * a sum of stage p99s. */
  totalP50: number;
  totalP99: number;
  /** Time to FIRST token. Equal to totalP50/P99 when nothing streams. */
  ttftP50: number;
  ttftP99: number;
  hasStreaming: boolean;
  /** The naive, common mistake this tool exists to correct: every
   * stage's own effective p99, added together regardless of topology
   * or independence. Always shown next to totalP99 for contrast. */
  naiveSumP99: number;
  /** PRD acceptance criterion: "Formulas are inspectable." Shows why
   * totalP99 is not naiveSumP99, with the real numbers for this run. */
  compositionFormula: string;
  dominantIndex: number;
  halved: HalvedResult;
  budget: BudgetVerdict;
}

const ZERO_HALVED: HalvedResult = {
  stageIndex: -1,
  totalP50: 0,
  totalP99: 0,
  reductionP50: 0,
  reductionPercent: 0,
  naivePredictedReduction: 0,
  saturated: false,
  formula: 'No stages to halve.',
};

/**
 * PRD acceptance criterion: "Formulas are inspectable," and this is
 * the one that matters most, since it is the whole reason this tool
 * exists: showing, with real numbers, why the composed p99 is not the
 * naive sum of every stage's own p99.
 */
function buildTotalFormula(
  groupFits: LogNormalFit[],
  totalFit: LogNormalFit,
  naiveSumP99: number,
  totalP50: number,
  totalP99: number,
): string {
  if (groupFits.length === 0) return 'No stages to compose.';
  const groupMoments = groupFits.map(momentsFromFit);
  const meanSum = groupMoments.reduce((sum, m) => sum + m.mean, 0);
  const varianceSum = groupMoments.reduce((sum, m) => sum + m.variance, 0);
  const overshoot = naiveSumP99 - totalP99;
  return (
    `Naive (wrong) approach: add every stage's own p99 together: ${fmt(naiveSumP99)} ms. ` +
    `Honest approach: convert each of the ${groupFits.length} stage groups to a mean and a variance, sum the ` +
    `means to ${fmt(meanSum)} ms (exact, means always add regardless of shape) and sum the variances to a ` +
    `combined standard deviation of ${fmt(Math.sqrt(varianceSum))} ms (exact only because the groups are ` +
    `assumed independent), then refit a lognormal: sigma equals the square root of log of 1 plus variance ` +
    `over mean squared, which is ${totalFit.sigma.toFixed(3)}, and mu equals log of the mean minus sigma ` +
    `squared over 2, which is ${totalFit.mu.toFixed(3)}. So p50 equals e to the mu, ${fmt(totalP50)} ms, and ` +
    `p99 equals e to the mu plus 2.326 times sigma, ${fmt(totalP99)} ms. The naive sum overshoots by ` +
    `${fmt(overshoot)} ms because it assumes every one of the ${groupFits.length} groups hits its own 99th ` +
    `percentile on the same request, which independent groups rarely do together.`
  );
}

/** Everything except the halved-stage projection, which needs a
 * completed core result to compare against before it can run. */
function computeCore(pipeline: Pipeline, budgetMs: number): Omit<PipelineResult, 'halved'> {
  const { stages } = pipeline;

  if (stages.length === 0) {
    return {
      stages: [],
      groups: [],
      totalP50: 0,
      totalP99: 0,
      ttftP50: 0,
      ttftP99: 0,
      hasStreaming: false,
      naiveSumP99: 0,
      compositionFormula: 'No stages to compose.',
      dominantIndex: -1,
      budget: { ms: budgetMs, fitsTotalP50: true, fitsTotalP99: true, fitsTtftP50: true, fitsTtftP99: true },
    };
  }

  const breakdown = stages.map(computeStageLatency);
  const groupsIdx = buildGroups(stages);
  const stageToGroup: number[] = [];
  groupsIdx.forEach((members, gi) => members.forEach((si) => {
    stageToGroup[si] = gi;
  }));

  const groups: GroupComputed[] = groupsIdx.map((members, gi) => {
    let criticalIndex = members[0];
    for (const si of members) {
      if (breakdown[si].effectiveP50 > breakdown[criticalIndex].effectiveP50) criticalIndex = si;
    }
    if (members.length === 1) {
      const si = members[0];
      return {
        index: gi,
        memberIndices: members,
        p50: breakdown[si].effectiveP50,
        p99: breakdown[si].effectiveP99,
        criticalIndex,
        formula: 'Only one stage in this group, so its own effective p50 and p99 carry through unchanged.',
      };
    }
    const fits = members.map((si) => fitLognormal(breakdown[si].effectiveP50, breakdown[si].effectiveP99));
    const p50 = quantileOfMax(fits, 0.5);
    const p99 = quantileOfMax(fits, 0.99);
    const slowestP50 = Math.max(...members.map((si) => breakdown[si].effectiveP50));
    const memberList = members
      .map((si) => `${stages[si].label} (p50 ${fmt(breakdown[si].effectiveP50)} ms, p99 ${fmt(breakdown[si].effectiveP99)} ms)`)
      .join(', ');
    const formula =
      `Members: ${memberList}. Solved for t where the product of every member's own chance of finishing by t ` +
      `equals 0.50, giving a group p50 of ${fmt(p50)} ms, and separately where that product equals 0.99, giving ` +
      `a group p99 of ${fmt(p99)} ms. This is why the group costs close to its slowest member (${fmt(slowestP50)} ` +
      `ms at p50), not the sum of all ${members.length} members.`;
    return { index: gi, memberIndices: members, p50, p99, criticalIndex, formula };
  });

  const stagesComputed: StageComputed[] = stages.map((stage, i) => ({
    index: i,
    stage,
    concurrencyAdjustedP50: breakdown[i].concurrencyAdjustedP50,
    concurrencyAdjustedP99: breakdown[i].concurrencyAdjustedP99,
    effectiveP50: breakdown[i].effectiveP50,
    effectiveP99: breakdown[i].effectiveP99,
    concurrencyTaxP50: breakdown[i].concurrencyAdjustedP50 - stage.p50,
    concurrencyTaxP99: breakdown[i].concurrencyAdjustedP99 - stage.p99,
    retryTaxP50: breakdown[i].effectiveP50 - breakdown[i].concurrencyAdjustedP50,
    retryTaxP99: breakdown[i].effectiveP99 - breakdown[i].concurrencyAdjustedP99,
    groupIndex: stageToGroup[i],
    onCriticalPath: groups[stageToGroup[i]].criticalIndex === i,
    formula: breakdown[i].formula,
  }));

  const groupFits = groups.map((g) => fitLognormal(g.p50, g.p99));
  const totalFit = composeSeries(groupFits);
  const total = percentilesFromFit(totalFit);

  // Streaming: everything up to and including the streaming stage's
  // group counts toward time to first token, using that stage's first
  // token figures in place of its full completion figures. Anything
  // that happens in the SAME parallel group alongside it (a background
  // moderation check, say) is assumed not to gate the first visible
  // token, and anything AFTER its group (post processing on the full
  // reply) plainly cannot affect when the first token already arrived.
  const streamingIndex = stages.findIndex((s) => s.streaming);
  const hasStreaming = streamingIndex !== -1;
  let ttft = total;
  if (hasStreaming) {
    const streamGroup = stageToGroup[streamingIndex];
    const ttftFits: LogNormalFit[] = [];
    for (const group of groups) {
      if (group.index > streamGroup) break;
      if (group.index === streamGroup) {
        const s = stages[streamingIndex];
        ttftFits.push(fitLognormal(s.firstTokenP50 || s.p50, s.firstTokenP99 || s.p99));
      } else {
        ttftFits.push(fitLognormal(group.p50, group.p99));
      }
    }
    ttft = percentilesFromFit(composeSeries(ttftFits));
  }

  const naiveSumP99 = stagesComputed.reduce((sum, s) => sum + s.effectiveP99, 0);
  const compositionFormula = buildTotalFormula(groupFits, totalFit, naiveSumP99, total.p50, total.p99);

  let dominantIndex = 0;
  for (let i = 1; i < stagesComputed.length; i++) {
    if (stagesComputed[i].effectiveP50 > stagesComputed[dominantIndex].effectiveP50) dominantIndex = i;
  }

  return {
    stages: stagesComputed,
    groups,
    totalP50: total.p50,
    totalP99: total.p99,
    ttftP50: ttft.p50,
    ttftP99: ttft.p99,
    hasStreaming,
    naiveSumP99,
    compositionFormula,
    dominantIndex,
    budget: {
      ms: budgetMs,
      fitsTotalP50: total.p50 <= budgetMs,
      fitsTotalP99: total.p99 <= budgetMs,
      fitsTtftP50: ttft.p50 <= budgetMs,
      fitsTtftP99: ttft.p99 <= budgetMs,
    },
  };
}

/**
 * Full analysis, including the halved-dominant-stage projection.
 *
 * The projection is not a formula, it is a second full run of the
 * same engine against a pipeline where the dominant stage's own p50
 * and p99 (and first token figures, if it streams) are cut in half.
 * Recomputing honestly like this is what makes Amdahl saturation show
 * up for free: if the dominant stage shares a parallel group with
 * another member, halving it can reveal that the OTHER member is now
 * what the group waits on, so the total drops by less than half of
 * what was cut. A closed form shortcut would have to special case
 * that; running the engine twice does not.
 */
export function analyzePipeline(pipeline: Pipeline, budgetMs: number): PipelineResult {
  const core = computeCore(pipeline, budgetMs);

  if (core.dominantIndex < 0) {
    return { ...core, halved: ZERO_HALVED };
  }

  const dominant = core.stages[core.dominantIndex];
  const halvedStages = pipeline.stages.map((stage, i) => {
    if (i !== core.dominantIndex) return stage;
    const halvedStage: Stage = { ...stage, p50: stage.p50 / 2, p99: stage.p99 / 2 };
    if (stage.streaming) {
      halvedStage.firstTokenP50 = stage.firstTokenP50 / 2;
      halvedStage.firstTokenP99 = stage.firstTokenP99 / 2;
    }
    return halvedStage;
  });

  const halvedCore = computeCore({ stages: halvedStages }, budgetMs);
  const naivePredictedReduction = dominant.effectiveP50 / 2;
  const reductionP50 = core.totalP50 - halvedCore.totalP50;
  const reductionPercent = core.totalP50 > 0 ? (reductionP50 / core.totalP50) * 100 : 0;
  // A small epsilon absorbs floating point noise from the refit step,
  // not genuine saturation.
  const saturated = reductionP50 < naivePredictedReduction - 0.01;

  const formula = saturated
    ? `Halving ${dominant.stage.label} from ${fmt(dominant.effectiveP50)} ms to ${fmt(dominant.effectiveP50 / 2)} ms ` +
      `would naively predict a ${fmt(naivePredictedReduction)} ms drop, but it shares a parallel group with a ` +
      `member that does not shrink, so the group's cost is now set by that member instead. Total p50 falls from ` +
      `${fmt(core.totalP50)} ms to only ${fmt(halvedCore.totalP50)} ms, a reduction of ${fmt(reductionP50)} ms ` +
      `(${reductionPercent.toFixed(1)} percent), short of the naive ${fmt(naivePredictedReduction)} ms.`
    : `Halving ${dominant.stage.label} from ${fmt(dominant.effectiveP50)} ms to ${fmt(dominant.effectiveP50 / 2)} ms ` +
      `moves total p50 from ${fmt(core.totalP50)} ms to ${fmt(halvedCore.totalP50)} ms, a reduction of ` +
      `${fmt(reductionP50)} ms (${reductionPercent.toFixed(1)} percent), matching the naive prediction because ` +
      `this stage does not share a parallel group with a slower neighbor.`;

  return {
    ...core,
    halved: {
      stageIndex: core.dominantIndex,
      totalP50: halvedCore.totalP50,
      totalP99: halvedCore.totalP99,
      reductionP50,
      reductionPercent,
      naivePredictedReduction,
      saturated,
      formula,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Baseline versus proposed comparison
 *
 * PRD acceptance criterion: "User can compare baseline and proposed
 * designs." Two full pipelines are already computed independently by
 * analyzePipeline; this function is the delta and the narrative on
 * top, matched by POSITION (the realistic redesign case: the same
 * stages, tweaked, or one moved from series to parallel), not by id,
 * since a proposed pipeline commonly keeps the same shape as its
 * baseline.
 * ------------------------------------------------------------------ */

export interface StageDelta {
  index: number;
  label: string;
  present: 'both' | 'added' | 'removed';
  baselineEffectiveP50: number | null;
  proposedEffectiveP50: number | null;
  /** proposed minus baseline. Negative means the proposed stage is faster. */
  deltaP50: number;
  relationChanged: boolean;
}

export interface ComparisonResult {
  baseline: PipelineResult;
  proposed: PipelineResult;
  /** proposed minus baseline. Negative means the proposed pipeline is faster. */
  deltaTotalP50: number;
  deltaTotalP99: number;
  deltaTotalP50Percent: number;
  deltaTotalP99Percent: number;
  stageDeltas: StageDelta[];
  /** Index (matched position) of the stage whose own change was
   * largest in magnitude. -1 when nothing changed. */
  leadStageIndex: number;
  /** PRD acceptance criterion: "Formulas are inspectable," applied to
   * the comparison itself. */
  formula: string;
}

export function comparePipelines(baseline: Pipeline, proposed: Pipeline, budgetMs: number): ComparisonResult {
  const baselineResult = analyzePipeline(baseline, budgetMs);
  const proposedResult = analyzePipeline(proposed, budgetMs);

  const deltaTotalP50 = proposedResult.totalP50 - baselineResult.totalP50;
  const deltaTotalP99 = proposedResult.totalP99 - baselineResult.totalP99;
  const deltaTotalP50Percent = baselineResult.totalP50 > 0 ? (deltaTotalP50 / baselineResult.totalP50) * 100 : 0;
  const deltaTotalP99Percent = baselineResult.totalP99 > 0 ? (deltaTotalP99 / baselineResult.totalP99) * 100 : 0;

  const matched = Math.min(baseline.stages.length, proposed.stages.length);
  const stageDeltas: StageDelta[] = [];
  for (let i = 0; i < matched; i++) {
    const b = baselineResult.stages[i];
    const p = proposedResult.stages[i];
    stageDeltas.push({
      index: i,
      label: proposed.stages[i].label || baseline.stages[i].label,
      present: 'both',
      baselineEffectiveP50: b.effectiveP50,
      proposedEffectiveP50: p.effectiveP50,
      deltaP50: p.effectiveP50 - b.effectiveP50,
      relationChanged: baseline.stages[i].relation !== proposed.stages[i].relation,
    });
  }
  for (let i = matched; i < baseline.stages.length; i++) {
    stageDeltas.push({
      index: i,
      label: baseline.stages[i].label,
      present: 'removed',
      baselineEffectiveP50: baselineResult.stages[i].effectiveP50,
      proposedEffectiveP50: null,
      deltaP50: -baselineResult.stages[i].effectiveP50,
      relationChanged: false,
    });
  }
  for (let i = matched; i < proposed.stages.length; i++) {
    stageDeltas.push({
      index: i,
      label: proposed.stages[i].label,
      present: 'added',
      baselineEffectiveP50: null,
      proposedEffectiveP50: proposedResult.stages[i].effectiveP50,
      deltaP50: proposedResult.stages[i].effectiveP50,
      relationChanged: false,
    });
  }

  let leadStageIndex = -1;
  let leadMagnitude = 0;
  for (const d of stageDeltas) {
    if (Math.abs(d.deltaP50) > leadMagnitude) {
      leadMagnitude = Math.abs(d.deltaP50);
      leadStageIndex = d.index;
    }
  }

  const direction = deltaTotalP50 <= 0 ? 'faster' : 'slower';
  const lead = stageDeltas.find((d) => d.index === leadStageIndex);
  let leadSentence: string;
  if (!lead) {
    leadSentence = 'No stages changed between the two pipelines.';
  } else if (lead.present === 'added') {
    leadSentence = `${lead.label} was added in the proposed pipeline, contributing ${fmt(lead.proposedEffectiveP50!)} ms.`;
  } else if (lead.present === 'removed') {
    leadSentence = `${lead.label} was removed in the proposed pipeline, saving its ${fmt(Math.abs(lead.deltaP50))} ms.`;
  } else {
    const relationNote = lead.relationChanged
      ? `, including a change from ${baseline.stages[lead.index].relation} to ${proposed.stages[lead.index].relation}`
      : '';
    leadSentence =
      `${lead.label} changed the most, from ${fmt(lead.baselineEffectiveP50!)} ms to ${fmt(lead.proposedEffectiveP50!)} ms ` +
      `(${lead.deltaP50 <= 0 ? 'a cut of' : 'an increase of'} ${fmt(Math.abs(lead.deltaP50))} ms)${relationNote}.`;
  }

  const formula =
    `Proposed total p50 (${fmt(proposedResult.totalP50)} ms) minus baseline total p50 (${fmt(baselineResult.totalP50)} ms) ` +
    `equals ${fmt(deltaTotalP50)} ms, ${fmt(Math.abs(deltaTotalP50Percent))} percent ${direction}. At p99, proposed ` +
    `(${fmt(proposedResult.totalP99)} ms) minus baseline (${fmt(baselineResult.totalP99)} ms) equals ${fmt(deltaTotalP99)} ms. ` +
    `${leadSentence} Composition is not strictly additive across stages once parallel grouping changes, so this ` +
    `names the largest single stage change, not a proof that it alone caused the total delta.`;

  return {
    baseline: baselineResult,
    proposed: proposedResult,
    deltaTotalP50,
    deltaTotalP99,
    deltaTotalP50Percent,
    deltaTotalP99Percent,
    stageDeltas,
    leadStageIndex,
    formula,
  };
}

/* ------------------------------------------------------------------ *
 * Method disclosure, shown on screen next to every composed result
 * ------------------------------------------------------------------ */

export const COMPOSITION_METHOD =
  'Each stage is fit to a lognormal curve from its own p50 and p99. ' +
  'Stages in series combine by summing means (always exact) and ' +
  'summing variances (exact if the stages are independent), then a ' +
  'lognormal is refit to that combined mean and variance to read off ' +
  'a composed p50 and p99. Parallel stages do not sum: a parallel ' +
  'group finishes when its slowest member finishes, so its p50 and ' +
  'p99 come from the distribution of the maximum of its members, ' +
  'solved directly rather than sampled. No Monte Carlo runs anywhere ' +
  'in this tool, so the same input always produces the same output.';

export const INDEPENDENCE_CAVEAT =
  'Every formula above assumes each stage is independent of the ' +
  'others. That assumption is the one most likely to be false in a ' +
  'real system: a GPU queue backing up under load, a shared rate ' +
  'limit, or a connection pool exhausted by every stage at once all ' +
  'make delays correlate instead of behaving independently. When a ' +
  'shared resource saturates, the true p99 is worse than this tool ' +
  'reports, and the gap is largest exactly when it is least ' +
  'affordable to be wrong about it.';

/* ------------------------------------------------------------------ *
 * Sample
 *
 * One complete baseline and proposed pair, per 00-PRODUCT-VISION.md
 * principle 7: a tool must work with sample data. Chosen to exercise
 * every mechanism this file models at once: series and parallel
 * stages, retries, streaming, a dominant stage that changes nothing
 * about the parallel branch beside it, and a budget the baseline
 * misses on the full response while still meeting it on the first
 * token, which is the streaming lesson made concrete.
 * ------------------------------------------------------------------ */

export const SAMPLE_TEACHES =
  'A retrieval augmented chat pipeline. The model call dominates the ' +
  'budget in both versions. The baseline misses the stated budget at ' +
  'p99 for the full reply, but comfortably meets it for the first ' +
  'streamed token, which is why the streaming figures are reported ' +
  'separately from the completion figures. The proposed design also ' +
  'cuts the gateway queue\'s utilization, showing concurrency load, ' +
  'not just raw stage speed, driving part of the improvement.';

export const SAMPLE_BUDGET_MS = 2000;

export const SAMPLE_BASELINE_STAGES: Stage[] = [
  {
    id: 'baseline-network-in',
    label: 'Client to gateway',
    kind: 'network',
    p50: 40,
    p99: 110,
    relation: 'series',
    streaming: false,
    firstTokenP50: 0,
    firstTokenP99: 0,
    retryAttempts: 1,
    retryFailureRate: 0,
    utilization: 0,
  },
  {
    id: 'baseline-queue',
    label: 'Gateway queue',
    kind: 'queue-wait',
    p50: 25,
    p99: 350,
    relation: 'series',
    streaming: false,
    firstTokenP50: 0,
    firstTokenP99: 0,
    retryAttempts: 1,
    retryFailureRate: 0,
    // Contended, so the queueing multiplier inflates the stated
    // latency: this is the "concurrency assumptions" input the PRD
    // names separately from retries.
    utilization: 0.6,
  },
  {
    id: 'baseline-retrieval',
    label: 'Vector search',
    kind: 'retrieval',
    p50: 140,
    p99: 320,
    relation: 'series',
    streaming: false,
    firstTokenP50: 0,
    firstTokenP99: 0,
    retryAttempts: 2,
    retryFailureRate: 0.05,
    utilization: 0,
  },
  {
    id: 'baseline-rerank',
    label: 'Cross encoder rerank',
    kind: 'rerank',
    p50: 90,
    p99: 210,
    relation: 'series',
    streaming: false,
    firstTokenP50: 0,
    firstTokenP99: 0,
    retryAttempts: 1,
    retryFailureRate: 0,
    utilization: 0,
  },
  {
    id: 'baseline-model',
    label: 'LLM generation',
    kind: 'model-call',
    p50: 1900,
    p99: 4300,
    relation: 'series',
    streaming: true,
    firstTokenP50: 380,
    firstTokenP99: 950,
    retryAttempts: 2,
    retryFailureRate: 0.04,
    utilization: 0,
  },
  {
    id: 'baseline-moderation',
    label: 'Moderation check',
    kind: 'tool-call',
    p50: 220,
    p99: 600,
    relation: 'parallel',
    streaming: false,
    firstTokenP50: 0,
    firstTokenP99: 0,
    retryAttempts: 1,
    retryFailureRate: 0,
    utilization: 0,
  },
  {
    id: 'baseline-postprocess',
    label: 'Format and redact',
    kind: 'post-processing',
    p50: 45,
    p99: 110,
    relation: 'series',
    streaming: false,
    firstTokenP50: 0,
    firstTokenP99: 0,
    retryAttempts: 1,
    retryFailureRate: 0,
    utilization: 0,
  },
  {
    id: 'baseline-network-out',
    label: 'Gateway to client',
    kind: 'network',
    p50: 35,
    p99: 100,
    relation: 'series',
    streaming: false,
    firstTokenP50: 0,
    firstTokenP99: 0,
    retryAttempts: 1,
    retryFailureRate: 0,
    utilization: 0,
  },
];

export const SAMPLE_PROPOSED_STAGES: Stage[] = [
  { ...SAMPLE_BASELINE_STAGES[0], id: 'proposed-network-in' },
  {
    ...SAMPLE_BASELINE_STAGES[1],
    id: 'proposed-queue',
    p50: 15,
    p99: 90,
    // Autoscaling brought the shared queue's own load down too, on
    // top of the stage getting faster on paper.
    utilization: 0.2,
  },
  {
    ...SAMPLE_BASELINE_STAGES[2],
    id: 'proposed-retrieval',
    p50: 70,
    p99: 150,
    retryAttempts: 1,
    retryFailureRate: 0,
  },
  {
    ...SAMPLE_BASELINE_STAGES[3],
    id: 'proposed-rerank',
    p50: 60,
    p99: 130,
  },
  {
    ...SAMPLE_BASELINE_STAGES[4],
    id: 'proposed-model',
    p50: 850,
    p99: 1500,
    firstTokenP50: 200,
    firstTokenP99: 420,
    retryFailureRate: 0.02,
  },
  {
    ...SAMPLE_BASELINE_STAGES[5],
    id: 'proposed-moderation',
    p50: 160,
    p99: 320,
  },
  { ...SAMPLE_BASELINE_STAGES[6], id: 'proposed-postprocess' },
  { ...SAMPLE_BASELINE_STAGES[7], id: 'proposed-network-out' },
];

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

export function emptyState(): LatencyState {
  return { baseline: { stages: [] }, proposed: { stages: [] }, budgetMs: SAMPLE_BUDGET_MS };
}

export function sampleState(): LatencyState {
  return {
    baseline: { stages: SAMPLE_BASELINE_STAGES.map((s) => ({ ...s })) },
    proposed: { stages: SAMPLE_PROPOSED_STAGES.map((s) => ({ ...s })) },
    budgetMs: SAMPLE_BUDGET_MS,
  };
}

export function reset(): LatencyState {
  return emptyState();
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

function validatePipeline(pipeline: Pipeline, label: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  pipeline.stages.forEach((stage, i) => {
    const where = `${label}.stages[${i}]`;
    const name = stage.label || STAGE_KIND_LABELS[stage.kind];
    if (!(stage.p50 > 0)) {
      issues.push({ field: where, message: `${name}: p50 must be greater than zero.`, severity: 'error' });
    }
    if (stage.p99 < stage.p50) {
      issues.push({ field: where, message: `${name}: p99 cannot be less than p50.`, severity: 'error' });
    }
    if (!Number.isInteger(stage.retryAttempts) || stage.retryAttempts < 1 || stage.retryAttempts > MAX_RETRY_ATTEMPTS) {
      issues.push({
        field: where,
        message: `${name}: retry attempts must be a whole number from 1 to ${MAX_RETRY_ATTEMPTS}.`,
        severity: 'error',
      });
    }
    if (stage.retryFailureRate < 0 || stage.retryFailureRate >= 1) {
      issues.push({
        field: where,
        message: `${name}: retry failure rate must be at least 0 and less than 1.`,
        severity: 'error',
      });
    }
    if (stage.utilization < 0 || stage.utilization > MAX_UTILIZATION) {
      issues.push({
        field: where,
        message: `${name}: utilization must be between 0 and ${MAX_UTILIZATION}.`,
        severity: 'error',
      });
    }
    if (stage.streaming) {
      if (!(stage.firstTokenP50 > 0)) {
        issues.push({ field: where, message: `${name}: a streaming stage needs a time to first token.`, severity: 'error' });
      } else if (stage.firstTokenP50 > stage.p50) {
        issues.push({
          field: where,
          message: `${name}: the first token cannot arrive after the full response on the typical case.`,
          severity: 'error',
        });
      }
      if (stage.firstTokenP99 > 0 && stage.firstTokenP99 > stage.p99) {
        issues.push({
          field: where,
          message: `${name}: the first token's p99 exceeds the full response's p99, which is inconsistent.`,
          severity: 'warning',
        });
      }
    }
  });
  return issues;
}

export function validate(state: LatencyState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (state.baseline.stages.length === 0) {
    issues.push({
      field: 'baseline',
      message: 'The baseline pipeline has no stages. Add one or load the sample.',
      severity: 'error',
    });
  }
  if (state.baseline.stages.length > 0 && state.proposed.stages.length === 0) {
    issues.push({
      field: 'proposed',
      message: 'The proposed pipeline is empty, so there is nothing to compare against the baseline.',
      severity: 'warning',
    });
  }
  if (!(state.budgetMs > 0)) {
    issues.push({ field: 'budgetMs', message: 'The user facing budget must be greater than zero.', severity: 'error' });
  }
  issues.push(...validatePipeline(state.baseline, 'baseline'));
  issues.push(...validatePipeline(state.proposed, 'proposed'));
  return issues;
}

export type ExportFormat = 'json' | 'markdown';

function pipelineReportLines(label: string, pipeline: Pipeline, result: PipelineResult, budgetMs: number): string[] {
  const dominant = pipeline.stages[result.dominantIndex];
  return [
    `## ${label}`,
    '',
    `Total time to last token: p50 ${fmt(result.totalP50)} ms, p99 ${fmt(result.totalP99)} ms.`,
    result.hasStreaming
      ? `Time to first token: p50 ${fmt(result.ttftP50)} ms, p99 ${fmt(result.ttftP99)} ms.`
      : 'No stage in this pipeline streams, so time to first token equals time to last token.',
    `Naive sum of every stage's own p99 (the common mistake): ${fmt(result.naiveSumP99)} ms. The composed p99 above is the honest figure.`,
    `Composition formula: ${result.compositionFormula}`,
    dominant
      ? `Dominant stage: ${dominant.label}, contributing ${fmt(result.stages[result.dominantIndex].effectiveP50)} ms at p50.`
      : 'No stages.',
    `Halving formula: ${result.halved.formula}`,
    `Budget of ${budgetMs} ms: total reply fits at p50 ${result.budget.fitsTotalP50 ? 'yes' : 'no'}, at p99 ${result.budget.fitsTotalP99 ? 'yes' : 'no'}. First token fits at p50 ${result.budget.fitsTtftP50 ? 'yes' : 'no'}, at p99 ${result.budget.fitsTtftP99 ? 'yes' : 'no'}.`,
    '',
  ];
}

export function serialize(state: LatencyState, format: ExportFormat): string {
  const baseline = analyzePipeline(state.baseline, state.budgetMs);
  const proposed = analyzePipeline(state.proposed, state.budgetMs);
  const comparison =
    state.baseline.stages.length && state.proposed.stages.length
      ? comparePipelines(state.baseline, state.proposed, state.budgetMs)
      : null;

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Latency Budgeter',
        note: 'Planning estimates from a local statistical model. No live network test was performed.',
        compositionMethod: COMPOSITION_METHOD,
        independenceCaveat: INDEPENDENCE_CAVEAT,
        budgetMs: state.budgetMs,
        baseline: { stages: state.baseline.stages, result: baseline },
        proposed: { stages: state.proposed.stages, result: proposed },
        comparison,
      },
      null,
      2,
    );
  }

  return [
    '# Latency Budgeter report',
    '',
    'Planning estimates from a local statistical model. No live network test was performed.',
    '',
    COMPOSITION_METHOD,
    '',
    INDEPENDENCE_CAVEAT,
    '',
    ...pipelineReportLines('Baseline', state.baseline, baseline, state.budgetMs),
    ...pipelineReportLines('Proposed', state.proposed, proposed, state.budgetMs),
    '## Baseline versus proposed',
    '',
    comparison ? comparison.formula : 'The proposed pipeline is empty, so there is nothing to compare.',
    '',
  ].join('\n');
}

export function filename(_state: LatencyState, _format: ExportFormat): string {
  return 'latency-budgeter-report';
}
