/**
 * Evaluation Workbench, scoring engine.
 *
 * PRD: tools-nixfred-prds/tools/06-EVAL-WORKBENCH.md
 * User outcome, quoted from the PRD: "Design a small, repeatable
 * evaluation before choosing a prompt, model, or agent configuration."
 *
 * This is a working scoring workbench. Cases are the primary object.
 * Each case has an input, a list of expected properties, and a
 * critical flag. Two or more candidates supply outputs for those
 * cases, pasted or imported by the user. Each property is scored
 * either by hand, pass or fail or on a scale of 1 to 5, or by a
 * deterministic check that runs locally: exact match, contains, a
 * regular expression, JSON object validity with required keys, or a
 * length bound.
 *
 * HARD BOUNDARY FROM 00-PRODUCT-VISION.md: nothing here runs or
 * simulates a model. A deterministic check is a plain string or JSON
 * comparison against text the user already has. A manual score is
 * typed in by the user from a run they already made. No score is ever
 * invented.
 *
 * THE HEART OF THIS TOOL, per the PRD's acceptance criteria: an
 * aggregate score must never hide a failed critical case. See
 * computeCandidateAggregate, where hasCriticalFailure is checked
 * before the pass rate is ever consulted.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Identifiers
 * ------------------------------------------------------------------ */

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function outputKey(candidateId: string, caseId: string): string {
  return `${candidateId}::${caseId}`;
}

export function scoreKey(candidateId: string, caseId: string, propertyId: string): string {
  return `${candidateId}::${caseId}::${propertyId}`;
}

/* ------------------------------------------------------------------ *
 * Deterministic checks
 *
 * Five kinds. Each is a plain comparison against the text the user
 * already pasted in, so it can run in the browser without a model.
 * ------------------------------------------------------------------ */

export const CHECK_TYPES = ['manual', 'exact-match', 'contains', 'regex', 'json-schema', 'length-bounds'] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const CHECK_TYPE_LABELS: Record<CheckType, string> = {
  manual: 'Manual',
  'exact-match': 'Exact match',
  contains: 'Contains',
  regex: 'Regular expression',
  'json-schema': 'JSON object with required keys',
  'length-bounds': 'Length bounds',
};

/**
 * One flat options bag shared by every check type. Only the fields a
 * given checkType actually reads are meaningful, which keeps the
 * property form and its serialized shape uniform regardless of which
 * check is selected.
 */
export interface CheckConfig {
  /** exact-match: the value to match. contains: the substring. regex: the pattern. */
  value: string;
  /** regex flags, for example gi. */
  flags: string;
  /** exact-match, contains: whether case matters. */
  caseSensitive: boolean;
  /** contains, regex: flips the check into a must not check. */
  negate: boolean;
  /** length-bounds: minimum character count. Null means no minimum. */
  minLength: number | null;
  /** length-bounds: maximum character count. Null means no maximum. */
  maxLength: number | null;
  /** json-schema: keys that must be present at the top level. */
  requiredKeys: string[];
}

export function defaultCheckConfig(): CheckConfig {
  return {
    value: '',
    flags: '',
    caseSensitive: false,
    negate: false,
    minLength: null,
    maxLength: null,
    requiredKeys: [],
  };
}

export type CheckStatus = 'pass' | 'fail' | 'error' | 'unscored';

export interface CheckResult {
  status: CheckStatus;
  detail: string;
}

/**
 * Run a deterministic check against a candidate's output text. Called
 * only for a non manual checkType. Never throws: an invalid regular
 * expression or unparsable JSON is reported as a result, not an
 * exception, because a malformed check should read as data on the
 * screen rather than crash the page.
 */
export function runCheck(property: ExpectedProperty, outputText: string): CheckResult {
  if (property.checkType === 'manual') {
    return { status: 'unscored', detail: 'Manual property. Score it by hand.' };
  }
  if (!outputText.trim()) {
    return { status: 'unscored', detail: 'No output pasted for this candidate and case yet.' };
  }

  const c = property.check;

  switch (property.checkType) {
    case 'exact-match': {
      const a = c.caseSensitive ? outputText.trim() : outputText.trim().toLowerCase();
      const b = c.caseSensitive ? c.value.trim() : c.value.trim().toLowerCase();
      const matched = a === b;
      const pass = c.negate ? !matched : matched;
      return pass
        ? { status: 'pass', detail: c.negate ? 'Output correctly does not equal the stated value.' : 'Output matches the expected value exactly.' }
        : { status: 'fail', detail: c.negate ? 'Output equals a value it should not.' : 'Output does not match the expected value exactly.' };
    }
    case 'contains': {
      const a = c.caseSensitive ? outputText : outputText.toLowerCase();
      const b = c.caseSensitive ? c.value : c.value.toLowerCase();
      const matched = b.length > 0 && a.includes(b);
      const pass = c.negate ? !matched : matched;
      return pass
        ? { status: 'pass', detail: c.negate ? 'Output correctly does not contain the disallowed text.' : 'Output contains the required text.' }
        : { status: 'fail', detail: c.negate ? 'Output contains text it should not.' : 'Output does not contain the required text.' };
    }
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(c.value, c.flags || '');
      } catch {
        return { status: 'error', detail: 'That regular expression is not valid.' };
      }
      const matched = re.test(outputText);
      const pass = c.negate ? !matched : matched;
      return pass
        ? { status: 'pass', detail: c.negate ? 'Output correctly does not match the pattern.' : 'Output matches the pattern.' }
        : { status: 'fail', detail: c.negate ? 'Output matches a pattern it should not.' : 'Output does not match the pattern.' };
    }
    case 'json-schema': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(outputText);
      } catch {
        return { status: 'fail', detail: 'Output is not valid JSON.' };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'fail', detail: 'Output is not a JSON object.' };
      }
      const record = parsed as Record<string, unknown>;
      const missing = c.requiredKeys.map((k) => k.trim()).filter((k) => k && !(k in record));
      return missing.length === 0
        ? { status: 'pass', detail: 'Output is a JSON object containing every required key.' }
        : { status: 'fail', detail: `Output is missing required key or keys: ${missing.join(', ')}.` };
    }
    case 'length-bounds': {
      const len = outputText.length;
      const min = c.minLength ?? 0;
      const max = c.maxLength ?? Infinity;
      return len >= min && len <= max
        ? { status: 'pass', detail: `Output length ${len} is within the stated bounds.` }
        : { status: 'fail', detail: `Output length ${len} is outside the stated bounds.` };
    }
    default:
      return { status: 'error', detail: 'Unknown check type.' };
  }
}

/* ------------------------------------------------------------------ *
 * Rubric
 *
 * PRD acceptance criterion: "Support pass/fail and scaled rubrics."
 * Both are genuine here. A manual property is scored in whichever
 * rubric the eval set uses. A deterministic property is always binary
 * by nature, a match or not, so it normalizes to 1 or 0 regardless of
 * the rubric in force.
 * ------------------------------------------------------------------ */

export const SCORE_MODES = ['pass-fail', 'scale-5'] as const;
export type ScoreMode = (typeof SCORE_MODES)[number];

export const SCORE_MODE_LABELS: Record<ScoreMode, string> = {
  'pass-fail': 'Pass or fail',
  'scale-5': 'Scale of 1 to 5',
};

export interface PropertyResult {
  passFail?: 'pass' | 'fail';
  scale?: number;
}

/**
 * A property scores at or above 80 percent of its maximum to count as
 * passing. Stated once here rather than hidden inside a threshold no
 * one can see, and separate from the candidate level pass threshold,
 * which is user editable further down.
 */
export const CASE_PASS_NORMALIZED = 0.8;

export function normalizeManualResult(mode: ScoreMode, result?: PropertyResult): number | undefined {
  if (!result) return undefined;
  if (mode === 'pass-fail') {
    if (result.passFail === 'pass') return 1;
    if (result.passFail === 'fail') return 0;
    return undefined;
  }
  if (typeof result.scale !== 'number' || Number.isNaN(result.scale)) return undefined;
  return Math.min(5, Math.max(1, result.scale)) / 5;
}

/**
 * The normalized 0 to 1 score for one property, on one candidate's
 * output for one case. Undefined means not yet scored, which is
 * different from a score of 0 and must never be treated as a failure
 * by accident.
 */
export function propertyScore(
  property: ExpectedProperty,
  outputText: string,
  scoreMode: ScoreMode,
  manualResult?: PropertyResult,
): number | undefined {
  if (property.checkType !== 'manual') {
    const result = runCheck(property, outputText);
    if (result.status === 'pass') return 1;
    if (result.status === 'fail') return 0;
    return undefined;
  }
  return normalizeManualResult(scoreMode, manualResult);
}

/* ------------------------------------------------------------------ *
 * Cases, properties, candidates
 * ------------------------------------------------------------------ */

export interface ExpectedProperty {
  id: string;
  description: string;
  /** Which declared concern this exercises. Empty string means untagged. */
  concern: string;
  weight: number;
  checkType: CheckType;
  check: CheckConfig;
}

export function newProperty(): ExpectedProperty {
  return {
    id: nextId('prop'),
    description: '',
    concern: '',
    weight: 1,
    checkType: 'manual',
    check: defaultCheckConfig(),
  };
}

export interface EvalCase {
  id: string;
  title: string;
  input: string;
  critical: boolean;
  expectedProperties: ExpectedProperty[];
}

export function newCase(): EvalCase {
  return { id: nextId('case'), title: 'New case', input: '', critical: false, expectedProperties: [] };
}

export interface Candidate {
  id: string;
  label: string;
}

export function newCandidate(label?: string): Candidate {
  return { id: nextId('cand'), label: label ?? 'New candidate' };
}

/* ------------------------------------------------------------------ *
 * Statistics. Wilson score interval and minimum detectable effect.
 *
 * Kept from the design pass and unchanged. This is real math, not a
 * simulation, and it is the honest secondary panel: given the number
 * of cases in the set, what size regression could this eval actually
 * detect. It is not the product. The scoring above is the product.
 * ------------------------------------------------------------------ */

export type ConfidenceLevel = 90 | 95 | 99;
export type PowerLevel = 80 | 90 | 95;

export const CONFIDENCE_LEVELS: ConfidenceLevel[] = [90, 95, 99];
export const POWER_LEVELS: PowerLevel[] = [80, 90, 95];

/**
 * Standard normal quantiles. Z_BY_CONFIDENCE(level) is the two sided
 * critical value for a confidence level, the 1 minus alpha over 2
 * quantile. Z_BY_POWER(power) is the one sided quantile used for
 * statistical power. Fixed mathematical constants, not estimates.
 */
export const Z_BY_CONFIDENCE: Record<ConfidenceLevel, number> = {
  90: 1.6448536269514722,
  95: 1.959963984540054,
  99: 2.5758293035489004,
};

export const Z_BY_POWER: Record<PowerLevel, number> = {
  80: 0.8416212335729143,
  90: 1.2815515655446004,
  95: 1.6448536269514722,
};

export const WILSON_METHOD =
  'Wilson score interval, closed form. This is not a normal approximation, which is why it stays inside 0 and 1 and does not collapse to a single point when every case passes or every case fails.';

export interface WilsonResult {
  lower: number;
  upper: number;
  center: number;
  phat: number;
  n: number;
  successes: number;
  confidenceLevel: ConfidenceLevel;
  method: string;
}

/**
 * The Wilson score interval for a binomial proportion.
 *
 * center = (phat + z^2 / 2n) / (1 + z^2 / n)
 * margin = z * sqrt(phat(1-phat)/n + z^2/4n^2) / (1 + z^2 / n)
 *
 * Verified in tests/tool-eval-workbench.mjs against published and hand
 * derived reference values, including the edge cases a normal
 * approximation gets wrong: zero successes, all successes, and n=1.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  confidenceLevel: ConfidenceLevel = 95,
): WilsonResult {
  const safeN = Math.max(0, Math.round(n));
  const safeX = Math.min(safeN, Math.max(0, Math.round(successes)));

  if (safeN === 0) {
    return {
      lower: 0,
      upper: 1,
      center: 0.5,
      phat: 0,
      n: 0,
      successes: 0,
      confidenceLevel,
      method: WILSON_METHOD,
    };
  }

  const z = Z_BY_CONFIDENCE[confidenceLevel];
  const z2 = z * z;
  const phat = safeX / safeN;
  const denom = 1 + z2 / safeN;
  const center = (phat + z2 / (2 * safeN)) / denom;
  const margin =
    (z * Math.sqrt((phat * (1 - phat)) / safeN + z2 / (4 * safeN * safeN))) / denom;

  return {
    lower: Math.min(1, Math.max(0, center - margin)),
    upper: Math.min(1, Math.max(0, center + margin)),
    center,
    phat,
    n: safeN,
    successes: safeX,
    confidenceLevel,
    method: WILSON_METHOD,
  };
}

export const MDE_METHOD =
  'Two proportion z-test with pooled variance, assuming equal sample size before and after and a two sided test. This is the standard closed form used to size an A or B test, not a simulation.';

export interface MdeResult {
  delta: number;
  n: number;
  baselineRate: number;
  confidenceLevel: ConfidenceLevel;
  power: PowerLevel;
  method: string;
}

/**
 * Minimum detectable effect. Given n cases and a baseline pass rate,
 * the smallest true regression this eval could tell apart from noise
 * at the stated confidence and power.
 *
 * delta = (z_alpha_over_2 + z_beta) * sqrt(2 * p(1-p) / n)
 *
 * The baseline rate is clamped away from 0 and 1 before it enters the
 * variance term. At those extremes the continuous approximation this
 * formula relies on breaks down, since a single case flipping is not a
 * matter of statistical power there. The clamp is a stated choice, not
 * a hidden one.
 */
export function minimumDetectableEffect(
  n: number,
  baselineRate: number,
  confidenceLevel: ConfidenceLevel = 95,
  power: PowerLevel = 80,
): MdeResult {
  const safeN = Math.max(1, Math.round(n));
  const p = Math.min(0.99, Math.max(0.01, baselineRate));
  const zAlpha2 = Z_BY_CONFIDENCE[confidenceLevel];
  const zBeta = Z_BY_POWER[power];
  const pooledVariance = p * (1 - p);
  const delta = (zAlpha2 + zBeta) * Math.sqrt((2 * pooledVariance) / safeN);

  return {
    delta: Math.min(1, delta),
    n: safeN,
    baselineRate,
    confidenceLevel,
    power,
    method: MDE_METHOD,
  };
}

/* ------------------------------------------------------------------ *
 * The evaluation set
 * ------------------------------------------------------------------ */

/** Bumped whenever the exported shape changes in a way old exports cannot satisfy. */
export const FORMAT_VERSION = 1;

export interface EvalPlanState {
  formatVersion: number;
  name: string;
  description: string;
  /** Concerns this evaluation set is meant to cover, declared up front. */
  concerns: string[];
  cases: EvalCase[];
  candidates: Candidate[];
  /** Pasted or imported candidate output, keyed by outputKey. */
  outputs: Record<string, string>;
  /** Hand entered scores for manual properties, keyed by scoreKey. */
  manualScores: Record<string, PropertyResult>;
  scoreMode: ScoreMode;
  /** Fraction of fully scored cases a candidate must pass, on top of the critical case rule. */
  passThreshold: number;
  confidenceLevel: ConfidenceLevel;
  power: PowerLevel;
}

/* ------------------------------------------------------------------ *
 * Case level outcome
 * ------------------------------------------------------------------ */

export interface CaseOutcome {
  caseId: string;
  candidateId: string;
  scoredProperties: number;
  totalProperties: number;
  /** Weighted mean over scored properties only. 0 when nothing is scored. */
  weightedScore: number;
  /** True only when every property is scored and every one passes. */
  allPropertiesPass: boolean;
  fullyScored: boolean;
  /**
   * The case level pass or fail. A critical case requires every
   * property to pass, no partial credit. A non critical case passes
   * on its weighted score clearing CASE_PASS_NORMALIZED. Either way,
   * an incomplete case cannot pass.
   */
  passed: boolean;
}

export function computeCaseOutcome(
  evalCase: EvalCase,
  candidateId: string,
  state: EvalPlanState,
): CaseOutcome {
  const outputText = state.outputs[outputKey(candidateId, evalCase.id)] ?? '';

  const scored = evalCase.expectedProperties
    .map((property) => ({
      property,
      score: propertyScore(
        property,
        outputText,
        state.scoreMode,
        state.manualScores[scoreKey(candidateId, evalCase.id, property.id)],
      ),
    }))
    .filter((r): r is { property: ExpectedProperty; score: number } => r.score !== undefined);

  const totalProperties = evalCase.expectedProperties.length;
  const scoredProperties = scored.length;
  const fullyScored = totalProperties > 0 && scoredProperties === totalProperties;

  const totalWeight = scored.reduce((sum, r) => sum + r.property.weight, 0);
  const weightedScore = totalWeight
    ? scored.reduce((sum, r) => sum + r.property.weight * r.score, 0) / totalWeight
    : 0;

  const allPropertiesPass = fullyScored && scored.every((r) => r.score >= CASE_PASS_NORMALIZED);

  let passed: boolean;
  if (!fullyScored || totalProperties === 0) {
    passed = false;
  } else if (evalCase.critical) {
    passed = allPropertiesPass;
  } else {
    passed = weightedScore >= CASE_PASS_NORMALIZED;
  }

  return {
    caseId: evalCase.id,
    candidateId,
    scoredProperties,
    totalProperties,
    weightedScore,
    allPropertiesPass,
    fullyScored,
    passed,
  };
}

/* ------------------------------------------------------------------ *
 * Candidate level aggregate. The heart of the tool.
 * ------------------------------------------------------------------ */

export type Verdict = 'no-cases' | 'not-scored' | 'incomplete' | 'pass' | 'fail';

export interface CandidateAggregate {
  candidateId: string;
  candidateLabel: string;
  totalCases: number;
  fullyScoredCases: number;
  passingCases: number;
  rawPassRate: number;
  weightedMean: number;
  criticalFailures: EvalCase[];
  hasCriticalFailure: boolean;
  verdict: Verdict;
  wilson: WilsonResult | null;
}

/**
 * PRD acceptance criterion, verbatim: "Prevent aggregate scores from
 * hiding failed critical cases."
 *
 * hasCriticalFailure is computed and checked BEFORE rawPassRate is
 * ever consulted for the verdict. There is no arithmetic path in this
 * function where enough easy passes can outvote one failed critical
 * case. A 94 percent pass rate with a single failed critical case
 * still returns verdict "fail".
 */
export function computeCandidateAggregate(state: EvalPlanState, candidateId: string): CandidateAggregate {
  const candidate = state.candidates.find((c) => c.id === candidateId);
  const outcomes = state.cases.map((c) => computeCaseOutcome(c, candidateId, state));
  const totalCases = state.cases.length;

  const scoredOutcomes = outcomes.filter((o) => o.fullyScored);
  const fullyScoredCases = scoredOutcomes.length;
  const passingCases = scoredOutcomes.filter((o) => o.passed).length;
  const rawPassRate = fullyScoredCases ? passingCases / fullyScoredCases : 0;
  const weightedMean = fullyScoredCases
    ? scoredOutcomes.reduce((sum, o) => sum + o.weightedScore, 0) / fullyScoredCases
    : 0;

  const criticalFailures = state.cases.filter((c, i) => {
    const outcome = outcomes[i];
    return c.critical && outcome.fullyScored && !outcome.passed;
  });
  const hasCriticalFailure = criticalFailures.length > 0;

  let verdict: Verdict;
  if (totalCases === 0) verdict = 'no-cases';
  else if (fullyScoredCases === 0) verdict = 'not-scored';
  else if (hasCriticalFailure) verdict = 'fail';
  else if (fullyScoredCases < totalCases) verdict = 'incomplete';
  else verdict = rawPassRate >= state.passThreshold ? 'pass' : 'fail';

  const wilson = fullyScoredCases > 0 ? wilsonInterval(passingCases, fullyScoredCases, state.confidenceLevel) : null;

  return {
    candidateId,
    candidateLabel: candidate?.label ?? candidateId,
    totalCases,
    fullyScoredCases,
    passingCases,
    rawPassRate,
    weightedMean,
    criticalFailures,
    hasCriticalFailure,
    verdict,
    wilson,
  };
}

export function computeAllAggregates(state: EvalPlanState): CandidateAggregate[] {
  return state.candidates.map((c) => computeCandidateAggregate(state, c.id));
}

/**
 * The minimum detectable effect for this eval set as built, using the
 * real case count and a real observed baseline rather than a
 * hypothetical one. Answers the question honestly, at n cases in this
 * set, what size regression from this baseline would this eval catch.
 */
export function evalSetMde(state: EvalPlanState, baselineRate: number): MdeResult {
  return minimumDetectableEffect(state.cases.length, baselineRate, state.confidenceLevel, state.power);
}

/* ------------------------------------------------------------------ *
 * Coverage gaps
 *
 * PRD outputs: "coverage gaps." Which declared concerns no case
 * actually exercises, which cases exercise nothing at all, and
 * whether there are even enough candidates for a comparison to mean
 * anything.
 * ------------------------------------------------------------------ */

export function computeCoverageGaps(state: EvalPlanState): string[] {
  const gaps: string[] = [];

  const usedConcerns = new Set(
    state.cases.flatMap((c) => c.expectedProperties.map((p) => p.concern.trim()).filter(Boolean)),
  );
  for (const concern of state.concerns) {
    if (concern.trim() && !usedConcerns.has(concern.trim())) {
      gaps.push(`No expected property in any case exercises "${concern.trim()}".`);
    }
  }

  const emptyCases = state.cases.filter((c) => c.expectedProperties.length === 0);
  if (emptyCases.length > 0) {
    gaps.push(
      `${emptyCases.length} case${emptyCases.length === 1 ? '' : 's'} ` +
        `${emptyCases.length === 1 ? 'has' : 'have'} no expected properties, so nothing is actually checked there.`,
    );
  }

  if (state.candidates.length < 2) {
    gaps.push('Fewer than two candidates. A comparison needs at least two to mean anything.');
  }

  return gaps;
}

/* ------------------------------------------------------------------ *
 * Disagreement indicators
 *
 * PRD outputs: "disagreement indicators." Where candidates diverge
 * most on the same case, and where the same declared concern produced
 * both a pass and a fail for one candidate across different cases.
 * ------------------------------------------------------------------ */

export interface CaseDivergence {
  caseId: string;
  caseTitle: string;
  spread: number;
  scores: Array<{ candidateId: string; candidateLabel: string; score: number }>;
}

export function computeCaseDivergence(state: EvalPlanState): CaseDivergence[] {
  const result: CaseDivergence[] = [];

  for (const evalCase of state.cases) {
    const scores = state.candidates
      .map((candidate) => {
        const outcome = computeCaseOutcome(evalCase, candidate.id, state);
        return outcome.fullyScored
          ? { candidateId: candidate.id, candidateLabel: candidate.label, score: outcome.weightedScore }
          : null;
      })
      .filter((s): s is { candidateId: string; candidateLabel: string; score: number } => s !== null);

    if (scores.length < 2) continue;
    const spread = Math.max(...scores.map((s) => s.score)) - Math.min(...scores.map((s) => s.score));
    result.push({ caseId: evalCase.id, caseTitle: evalCase.title, spread, scores });
  }

  return result.sort((a, b) => b.spread - a.spread);
}

export interface RubricInconsistency {
  concern: string;
  candidateId: string;
  candidateLabel: string;
  passCount: number;
  failCount: number;
}

/**
 * For one candidate, group every scored property by its declared
 * concern across all cases. If the same concern produced both a pass
 * and a fail for that one candidate, the rubric disagreed with itself
 * on cases meant to test the same thing.
 */
export function computeRubricInconsistencies(state: EvalPlanState): RubricInconsistency[] {
  const out: RubricInconsistency[] = [];

  for (const candidate of state.candidates) {
    const byConcern = new Map<string, { pass: number; fail: number }>();

    for (const evalCase of state.cases) {
      const outputText = state.outputs[outputKey(candidate.id, evalCase.id)] ?? '';
      for (const property of evalCase.expectedProperties) {
        const concern = property.concern.trim();
        if (!concern) continue;
        const score = propertyScore(
          property,
          outputText,
          state.scoreMode,
          state.manualScores[scoreKey(candidate.id, evalCase.id, property.id)],
        );
        if (score === undefined) continue;
        const entry = byConcern.get(concern) ?? { pass: 0, fail: 0 };
        if (score >= CASE_PASS_NORMALIZED) entry.pass += 1;
        else entry.fail += 1;
        byConcern.set(concern, entry);
      }
    }

    for (const [concern, counts] of byConcern) {
      if (counts.pass > 0 && counts.fail > 0) {
        out.push({
          concern,
          candidateId: candidate.id,
          candidateLabel: candidate.label,
          passCount: counts.pass,
          failCount: counts.fail,
        });
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Mutation helpers
 *
 * Each takes the whole state and returns a new whole state, so a page
 * can hold one state variable and reassign it, the same pattern used
 * throughout this codebase.
 * ------------------------------------------------------------------ */

export function withCaseAdded(state: EvalPlanState): EvalPlanState {
  return { ...state, cases: [...state.cases, newCase()] };
}

export function withCaseUpdated(state: EvalPlanState, caseId: string, patch: Partial<EvalCase>): EvalPlanState {
  return { ...state, cases: state.cases.map((c) => (c.id === caseId ? { ...c, ...patch } : c)) };
}

export function withCaseRemoved(state: EvalPlanState, caseId: string): EvalPlanState {
  const cases = state.cases.filter((c) => c.id !== caseId);
  const outputs = { ...state.outputs };
  const manualScores = { ...state.manualScores };
  for (const key of Object.keys(outputs)) {
    if (key.endsWith(`::${caseId}`)) delete outputs[key];
  }
  for (const key of Object.keys(manualScores)) {
    if (key.includes(`::${caseId}::`)) delete manualScores[key];
  }
  return { ...state, cases, outputs, manualScores };
}

export function withPropertyAdded(state: EvalPlanState, caseId: string): EvalPlanState {
  return {
    ...state,
    cases: state.cases.map((c) =>
      c.id === caseId ? { ...c, expectedProperties: [...c.expectedProperties, newProperty()] } : c,
    ),
  };
}

export function withPropertyUpdated(
  state: EvalPlanState,
  caseId: string,
  propertyId: string,
  patch: Partial<ExpectedProperty>,
): EvalPlanState {
  return {
    ...state,
    cases: state.cases.map((c) =>
      c.id === caseId
        ? {
            ...c,
            expectedProperties: c.expectedProperties.map((p) =>
              p.id === propertyId ? { ...p, ...patch, check: { ...p.check, ...(patch.check ?? {}) } } : p,
            ),
          }
        : c,
    ),
  };
}

export function withPropertyRemoved(state: EvalPlanState, caseId: string, propertyId: string): EvalPlanState {
  const manualScores = { ...state.manualScores };
  for (const key of Object.keys(manualScores)) {
    if (key.endsWith(`::${propertyId}`)) delete manualScores[key];
  }
  return {
    ...state,
    cases: state.cases.map((c) =>
      c.id === caseId
        ? { ...c, expectedProperties: c.expectedProperties.filter((p) => p.id !== propertyId) }
        : c,
    ),
    manualScores,
  };
}

export function withCandidateAdded(state: EvalPlanState): EvalPlanState {
  return { ...state, candidates: [...state.candidates, newCandidate(`Candidate ${state.candidates.length + 1}`)] };
}

export function withCandidateUpdated(state: EvalPlanState, candidateId: string, patch: Partial<Candidate>): EvalPlanState {
  return {
    ...state,
    candidates: state.candidates.map((c) => (c.id === candidateId ? { ...c, ...patch } : c)),
  };
}

export function withCandidateRemoved(state: EvalPlanState, candidateId: string): EvalPlanState {
  const outputs = { ...state.outputs };
  const manualScores = { ...state.manualScores };
  for (const key of Object.keys(outputs)) {
    if (key.startsWith(`${candidateId}::`)) delete outputs[key];
  }
  for (const key of Object.keys(manualScores)) {
    if (key.startsWith(`${candidateId}::`)) delete manualScores[key];
  }
  return {
    ...state,
    candidates: state.candidates.filter((c) => c.id !== candidateId),
    outputs,
    manualScores,
  };
}

export function withOutputSet(state: EvalPlanState, candidateId: string, caseId: string, text: string): EvalPlanState {
  return { ...state, outputs: { ...state.outputs, [outputKey(candidateId, caseId)]: text } };
}

export function withManualScoreSet(
  state: EvalPlanState,
  candidateId: string,
  caseId: string,
  propertyId: string,
  result: PropertyResult | undefined,
): EvalPlanState {
  const key = scoreKey(candidateId, caseId, propertyId);
  const manualScores = { ...state.manualScores };
  if (!result || (result.passFail === undefined && result.scale === undefined)) {
    delete manualScores[key];
  } else {
    manualScores[key] = result;
  }
  return { ...state, manualScores };
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * Four evaluation sets, each sized so its lesson is visible without
 * any extra data entry once loaded. Every candidate output below is
 * text written for the example, the same disclosure appears in each
 * set's own description field so it reads in the interface itself,
 * not only here.
 *
 * 1. Critical case override. Candidate A leaks a temporary password
 *    in plain text on the one critical case, and otherwise does well
 *    everywhere else, so its raw pass rate looks strong right up
 *    until the critical case rule overrides it. Candidate B redacts
 *    correctly and passes everything.
 * 2. Scaled rubric changes the winner. The same four judgments are
 *    recorded on both a pass or fail call and a one to five score, so
 *    switching the rubric in force changes which candidate is ahead
 *    on identical underlying judgments.
 * 3. Disagreement behind aggregate parity. Two candidates land on the
 *    exact same raw pass rate, five of six, while failing on two
 *    different cases each. The aggregate reads as a tie. The case
 *    level divergence is where the real difference shows.
 * 4. Coverage gap. A concern is declared up front and never exercised
 *    by any case, and a Customer's phone number slips through in one
 *    candidate's reply with nothing to catch it.
 * ------------------------------------------------------------------ */

function buildSample(): EvalPlanState {
  const candidateA = newCandidate('Current production prompt');
  const candidateB = newCandidate('Revised prompt');

  const caseRefund = newCase();
  caseRefund.title = 'Refund request with a clear policy match';
  caseRefund.input = 'The Customer asks for a refund on an order delivered ten days ago. Policy allows refunds within fourteen days.';
  caseRefund.critical = false;
  const refundProp = newProperty();
  refundProp.description = 'Reply cites the refund policy.';
  refundProp.concern = 'Policy grounding';
  refundProp.checkType = 'contains';
  refundProp.check = { ...defaultCheckConfig(), value: 'policy' };
  caseRefund.expectedProperties = [refundProp];

  const caseStatus = newCase();
  caseStatus.title = 'Order status lookup';
  caseStatus.input = 'The Customer asks for the status of order 48213.';
  caseStatus.critical = false;
  const statusProp = newProperty();
  statusProp.description = 'Reply is a JSON object with orderId and status fields.';
  statusProp.concern = 'Format validity';
  statusProp.checkType = 'json-schema';
  statusProp.check = { ...defaultCheckConfig(), requiredKeys: ['orderId', 'status'] };
  caseStatus.expectedProperties = [statusProp];

  const caseTone = newCase();
  caseTone.title = 'Frustrated Customer, late delivery';
  caseTone.input = 'The Customer is angry that a package is four days late and threatens to cancel their account.';
  caseTone.critical = false;
  const toneProp = newProperty();
  toneProp.description = 'Reply acknowledges the frustration before offering a fix.';
  toneProp.concern = 'Tone';
  toneProp.weight = 2;
  toneProp.checkType = 'manual';
  caseTone.expectedProperties = [toneProp];

  const casePassword = newCase();
  casePassword.title = 'Password reset, must not leak the temporary password';
  casePassword.input = 'The Customer asks for a password reset. The system generated temporary password TEMP-88213 for the account.';
  casePassword.critical = true;
  const passwordProp = newProperty();
  passwordProp.description = 'Reply does not repeat the raw temporary password back in plain text.';
  passwordProp.concern = 'Credential safety';
  passwordProp.checkType = 'regex';
  passwordProp.check = { ...defaultCheckConfig(), value: 'TEMP-[0-9]{4,}', negate: true };
  casePassword.expectedProperties = [passwordProp];

  const caseDiscount = newCase();
  caseDiscount.title = 'Discount request outside policy';
  caseDiscount.input = 'The Customer asks for a fifty percent discount with no stated reason. Policy has no such discount.';
  caseDiscount.critical = false;
  const discountProp = newProperty();
  discountProp.description = 'Reply declines the request rather than inventing a discount that does not exist.';
  discountProp.concern = 'Policy grounding';
  discountProp.checkType = 'manual';
  caseDiscount.expectedProperties = [discountProp];

  const caseGreeting = newCase();
  caseGreeting.title = 'Length bound on the opening line';
  caseGreeting.input = 'Any ticket. The opening line of the reply should be a short, direct greeting.';
  caseGreeting.critical = false;
  const greetingProp = newProperty();
  greetingProp.description = 'The reply is between 10 and 300 characters.';
  greetingProp.concern = 'Verbosity';
  greetingProp.checkType = 'length-bounds';
  greetingProp.check = { ...defaultCheckConfig(), minLength: 10, maxLength: 300 };
  caseGreeting.expectedProperties = [greetingProp];

  const cases = [caseRefund, caseStatus, caseTone, casePassword, caseDiscount, caseGreeting];

  const outputs: Record<string, string> = {
    [outputKey(candidateA.id, caseRefund.id)]:
      'Refunds are available within our fourteen day policy. Since your order was delivered ten days ago, I have started the refund.',
    [outputKey(candidateB.id, caseRefund.id)]:
      'Our policy allows a refund within fourteen days of delivery. Your order qualifies, so the refund is on its way.',
    [outputKey(candidateA.id, caseStatus.id)]: '{"orderId": "48213", "status": "In transit"}',
    [outputKey(candidateB.id, caseStatus.id)]: '{"orderId": "48213", "status": "In transit", "eta": "2 days"}',
    [outputKey(candidateA.id, caseTone.id)]:
      'I am sorry your package is late, that is frustrating. I have escalated the shipment and expedited a replacement.',
    [outputKey(candidateB.id, caseTone.id)]:
      'I am sorry about the delay, I understand the frustration. Here is the tracking link for the replacement shipment.',
    [outputKey(candidateA.id, casePassword.id)]:
      'Your temporary password is TEMP-88213. Please use it to sign in and set a new password.',
    [outputKey(candidateB.id, casePassword.id)]:
      'A temporary password has been sent to your account. Please use it to sign in and set a new password.',
    [outputKey(candidateA.id, caseDiscount.id)]:
      'I am not able to apply a discount of that size under our policy, but I can check for an active promotion on the order.',
    [outputKey(candidateB.id, caseDiscount.id)]:
      'We do not have a discount that matches this request, but I can check for an active promotion on your account.',
    [outputKey(candidateA.id, caseGreeting.id)]: 'Hello, thanks for reaching out.',
    [outputKey(candidateB.id, caseGreeting.id)]: 'Hi there, thanks for your patience.',
  };

  // scoreMode for this set is scale-5, so every manual score below is
  // recorded on that scale, matching the rubric in force. A pass/fail
  // score recorded here would silently read as unscored.
  const manualScores: Record<string, PropertyResult> = {
    [scoreKey(candidateA.id, caseTone.id, toneProp.id)]: { scale: 4 },
    [scoreKey(candidateB.id, caseTone.id, toneProp.id)]: { scale: 4 },
    [scoreKey(candidateA.id, caseDiscount.id, discountProp.id)]: { scale: 5 },
    [scoreKey(candidateB.id, caseDiscount.id, discountProp.id)]: { scale: 5 },
  };

  return {
    formatVersion: FORMAT_VERSION,
    name: 'Customer support assistant, prompt revision',
    description:
      'Comparing the current production prompt against a revised prompt before rolling the revision out, with one case that checks whether either version leaks a Customer credential. Every candidate output in this sample is text written for the example, not real output from a model.',
    concerns: ['Policy grounding', 'Format validity', 'Tone', 'Credential safety', 'Verbosity'],
    cases,
    candidates: [candidateA, candidateB],
    outputs,
    manualScores,
    scoreMode: 'scale-5',
    passThreshold: 0.8,
    confidenceLevel: 95,
    power: 80,
  };
}

/**
 * Sample: scaled rubric changes the winner.
 *
 * PRD acceptance criterion: "Support pass/fail and scaled rubrics."
 * Two prompts draft Customer facing incident status updates from raw
 * engineering notes. Every score below carries both a pass or fail
 * call and a one to five scale, the same underlying judgment recorded
 * both ways, so it can be read under either rubric without re-entering
 * anything. Under pass or fail, three lenient calls make Incident wording A look
 * like the clear winner, three passes to Prompt B's one. Score those
 * same three calls on a one to five scale and none of them reach a
 * four, so Incident wording A falls to zero passing cases while B's one
 * confident, accurate answer edges ahead. The rubric choice is not a
 * toggle nobody exercises. It changes which candidate wins.
 */
function buildScaledRubricSample(): EvalPlanState {
  const candidateA = newCandidate('Incident wording A');
  const candidateB = newCandidate('Incident wording B');

  const caseCheckout = newCase();
  caseCheckout.title = 'Checkout errors, root cause not yet confirmed';
  caseCheckout.input =
    'Incident notes. Checkout returned elevated errors between 14:02 and 14:26 UTC. A deploy was rolled back at 14:20. Root cause not yet confirmed, the deploy is suspected.';
  const checkoutProp = newProperty();
  checkoutProp.description = 'Update states only the confirmed facts and hedges on the suspected cause.';
  checkoutProp.concern = 'Numeric accuracy';
  caseCheckout.expectedProperties = [checkoutProp];

  const caseSearch = newCase();
  caseSearch.title = 'Search results served stale data, cause confirmed';
  caseSearch.input =
    'Incident notes. Search results showed stale data for about 40 minutes starting 09:15 UTC, caused by a caching configuration issue confirmed by the on call engineer. Fix deployed at 09:58 UTC.';
  const searchProp = newProperty();
  searchProp.description = 'Update states the confirmed cause and the actual duration without inventing extra minutes.';
  searchProp.concern = 'Numeric accuracy';
  caseSearch.expectedProperties = [searchProp];

  const caseCss = newCase();
  caseCss.title = 'Login page styling failed after a CDN change';
  caseCss.input =
    'Incident notes. The login page failed to load its styling for about 12 minutes after a CDN configuration change. The change was reverted. Exact restoration time was not logged.';
  const cssProp = newProperty();
  cssProp.description = 'Update does not invent a precise restoration timestamp that was never logged.';
  cssProp.concern = 'Numeric accuracy';
  caseCss.expectedProperties = [cssProp];

  const caseExport = newCase();
  caseExport.title = 'Export job produced duplicate records';
  caseExport.input =
    'Incident notes. A retry bug caused some data exports between 03:00 and 03:45 UTC to include duplicate records. Affected Customers will be notified individually, corrected exports reissued by end of day.';
  const exportProp = newProperty();
  exportProp.description = 'Update states the affected window accurately and does not promise a fix time beyond what is stated.';
  exportProp.concern = 'Numeric accuracy';
  caseExport.expectedProperties = [exportProp];

  const cases = [caseCheckout, caseSearch, caseCss, caseExport];

  const outputs: Record<string, string> = {
    [outputKey(candidateA.id, caseCheckout.id)]:
      'Between 14:02 and 14:26 UTC some Customers saw errors on checkout. We believe a recent deploy was the cause and it has been rolled back. We are continuing to confirm the exact cause.',
    [outputKey(candidateB.id, caseCheckout.id)]:
      'Between 14:02 and 14:26 UTC checkout was down due to a bad deploy. The issue is fully resolved and confirmed.',
    [outputKey(candidateA.id, caseSearch.id)]:
      'From about 09:15 to 09:55 UTC, search results could show stale data because of a caching configuration issue. The fix is live.',
    [outputKey(candidateB.id, caseSearch.id)]:
      'For over an hour this morning, search results were stale due to a caching bug. We have fixed the issue.',
    [outputKey(candidateA.id, caseCss.id)]:
      'For about 12 minutes after a CDN change, some Customers saw the login page without styling. The change was reverted and the page is back to normal.',
    [outputKey(candidateB.id, caseCss.id)]:
      'For 12 minutes and 40 seconds, the login page failed to load styling after a CDN change. Service was fully restored at 14:07 UTC.',
    [outputKey(candidateA.id, caseExport.id)]:
      'Between 03:00 and 03:45 UTC some exports contained duplicate records. We expect corrected exports within the next 30 minutes.',
    [outputKey(candidateB.id, caseExport.id)]:
      'Between 03:00 and 03:45 UTC, a retry bug caused some data exports to include duplicate records. We are notifying affected Customers individually and will reissue corrected exports by the end of today.',
  };

  // Every score below carries both fields, passFail and scale, so the
  // identical judgment can be read under either rubric. scoreMode
  // below picks which one is in force when this sample first loads.
  const manualScores: Record<string, PropertyResult> = {
    [scoreKey(candidateA.id, caseCheckout.id, checkoutProp.id)]: { passFail: 'pass', scale: 3 },
    [scoreKey(candidateB.id, caseCheckout.id, checkoutProp.id)]: { passFail: 'fail', scale: 2 },
    [scoreKey(candidateA.id, caseSearch.id, searchProp.id)]: { passFail: 'pass', scale: 3 },
    [scoreKey(candidateB.id, caseSearch.id, searchProp.id)]: { passFail: 'fail', scale: 2 },
    [scoreKey(candidateA.id, caseCss.id, cssProp.id)]: { passFail: 'pass', scale: 3 },
    [scoreKey(candidateB.id, caseCss.id, cssProp.id)]: { passFail: 'fail', scale: 2 },
    [scoreKey(candidateA.id, caseExport.id, exportProp.id)]: { passFail: 'fail', scale: 1 },
    [scoreKey(candidateB.id, caseExport.id, exportProp.id)]: { passFail: 'pass', scale: 5 },
  };

  return {
    formatVersion: FORMAT_VERSION,
    name: 'Incident status updates, rubric comparison',
    description:
      'Comparing two prompts that draft Customer facing incident status updates from raw engineering notes, scored once but readable under either rubric. Every candidate output in this sample is text written for the example, not real output from a model.',
    concerns: ['Numeric accuracy'],
    cases,
    candidates: [candidateA, candidateB],
    outputs,
    manualScores,
    scoreMode: 'pass-fail',
    passThreshold: 0.6,
    confidenceLevel: 95,
    power: 80,
  };
}

/**
 * Sample: aggregate parity hides a real behavioral difference.
 *
 * PRD outputs: "disagreement indicators." Two prompts extract order
 * confirmations into JSON. On four ordinary orders both stay
 * disciplined and output clean JSON. On two harder orders, one prompt
 * wraps its answer in prose or a markdown fence and the other does
 * not, but which prompt slips changes from one case to the next. The
 * two candidates land on the exact same raw pass rate, five of six,
 * so the aggregate alone reads as a tie. The case level divergence
 * panel is where the real difference, that they fail on different
 * orders, becomes visible.
 */
function buildDisagreementSample(): EvalPlanState {
  const candidateA = newCandidate('Extractor A');
  const candidateB = newCandidate('Extractor B');

  const case1 = newCase();
  case1.title = 'Order confirmation, standard case';
  case1.input = 'Order confirmation. Order 88213, total 42.50 USD, ships to Atlanta.';
  const prop1 = newProperty();
  prop1.description = 'Output is a JSON object with orderId, total, and currency.';
  prop1.concern = 'Format validity';
  prop1.checkType = 'json-schema';
  prop1.check = { ...defaultCheckConfig(), requiredKeys: ['orderId', 'total', 'currency'] };
  case1.expectedProperties = [prop1];

  const case2 = newCase();
  case2.title = 'Order confirmation, standard shipping';
  case2.input = 'Order confirmation. Order 60142, total 15.00 USD, standard shipping.';
  const prop2 = newProperty();
  prop2.description = 'Output is a JSON object with orderId, total, and currency.';
  prop2.concern = 'Format validity';
  prop2.checkType = 'json-schema';
  prop2.check = { ...defaultCheckConfig(), requiredKeys: ['orderId', 'total', 'currency'] };
  case2.expectedProperties = [prop2];

  const case3 = newCase();
  case3.title = 'Order confirmation, gift wrap requested';
  case3.input = 'Order confirmation. Order 91847, total 120.00 USD, gift wrap requested.';
  const prop3 = newProperty();
  prop3.description = 'Output is a JSON object with orderId, total, and currency.';
  prop3.concern = 'Format validity';
  prop3.checkType = 'json-schema';
  prop3.check = { ...defaultCheckConfig(), requiredKeys: ['orderId', 'total', 'currency'] };
  case3.expectedProperties = [prop3];

  const case4 = newCase();
  case4.title = 'Order confirmation, digital delivery';
  case4.input = 'Order confirmation. Order 33456, total 8.75 USD, digital delivery.';
  const prop4 = newProperty();
  prop4.description = 'Output is a JSON object with orderId, total, and currency.';
  prop4.concern = 'Format validity';
  prop4.checkType = 'json-schema';
  prop4.check = { ...defaultCheckConfig(), requiredKeys: ['orderId', 'total', 'currency'] };
  case4.expectedProperties = [prop4];

  const case5 = newCase();
  case5.title = 'Order confirmation, foreign currency';
  case5.input = 'Order confirmation. Order 55021, total 19.99 EUR, expedited shipping requested.';
  const prop5 = newProperty();
  prop5.description = 'Output is a JSON object with orderId, total, and currency.';
  prop5.concern = 'Format validity';
  prop5.checkType = 'json-schema';
  prop5.check = { ...defaultCheckConfig(), requiredKeys: ['orderId', 'total', 'currency'] };
  case5.expectedProperties = [prop5];

  const case6 = newCase();
  case6.title = 'Order confirmation, subtotal plus fee';
  case6.input =
    'Order confirmation. Order 71190 lists a subtotal of 30.00 USD plus a 5.00 USD shipping fee, total 35.00 USD.';
  const prop6 = newProperty();
  prop6.description = 'Output is a JSON object with orderId, total, and currency.';
  prop6.concern = 'Format validity';
  prop6.checkType = 'json-schema';
  prop6.check = { ...defaultCheckConfig(), requiredKeys: ['orderId', 'total', 'currency'] };
  case6.expectedProperties = [prop6];

  const cases = [case1, case2, case3, case4, case5, case6];

  const outputs: Record<string, string> = {
    [outputKey(candidateA.id, case1.id)]: '{"orderId": "88213", "total": 42.50, "currency": "USD"}',
    [outputKey(candidateB.id, case1.id)]: '{"orderId": "88213", "total": 42.50, "currency": "USD"}',
    [outputKey(candidateA.id, case2.id)]: '{"orderId": "60142", "total": 15.00, "currency": "USD"}',
    [outputKey(candidateB.id, case2.id)]: '{"orderId": "60142", "total": 15.00, "currency": "USD"}',
    [outputKey(candidateA.id, case3.id)]: '{"orderId": "91847", "total": 120.00, "currency": "USD"}',
    [outputKey(candidateB.id, case3.id)]: '{"orderId": "91847", "total": 120.00, "currency": "USD"}',
    [outputKey(candidateA.id, case4.id)]: '{"orderId": "33456", "total": 8.75, "currency": "USD"}',
    [outputKey(candidateB.id, case4.id)]: '{"orderId": "33456", "total": 8.75, "currency": "USD"}',
    [outputKey(candidateA.id, case5.id)]: '{"orderId": "55021", "total": 19.99, "currency": "EUR"}',
    [outputKey(candidateB.id, case5.id)]:
      'Here is the extracted order data.\n\n```json\n{"orderId": "55021", "total": 19.99, "currency": "EUR"}\n```',
    [outputKey(candidateA.id, case6.id)]: 'The order 71190 totals 35.00 USD once shipping is included.',
    [outputKey(candidateB.id, case6.id)]: '{"orderId": "71190", "total": 35.00, "currency": "USD"}',
  };

  return {
    formatVersion: FORMAT_VERSION,
    name: 'Order data extraction, format disagreement',
    description:
      'Comparing two prompts that extract order confirmations into JSON. Every candidate output in this sample is text written for the example, not real output from a model.',
    concerns: ['Format validity'],
    cases,
    candidates: [candidateA, candidateB],
    outputs,
    manualScores: {},
    scoreMode: 'pass-fail',
    passThreshold: 0.8,
    confidenceLevel: 95,
    power: 80,
  };
}

/**
 * Sample: a declared concern nobody ever tests.
 *
 * PRD outputs: "coverage gaps." Four concerns are declared up front,
 * and every case that got written scores cleanly against one of the
 * other three. Nobody ever wrote a case or a property for the fourth,
 * PII redaction, even though the first case's notes contain a
 * Customer's direct phone number. One candidate repeats that number
 * back in its reply. Nothing in the results panel catches it, because
 * nothing checks for it. Only the coverage report shows the gap.
 */
function buildCoverageGapSample(): EvalPlanState {
  const candidateA = newCandidate('Summarizer A');
  const candidateB = newCandidate('Summarizer B');

  const caseSync = newCase();
  caseSync.title = 'Weekly sync notes with a direct phone number';
  caseSync.input =
    'Meeting notes. Launch date pushed to March 10. Sarah owns the migration doc. Tom will follow up with legal by Friday, his direct line is 555-0148 in case they need to reach him directly.';
  const syncProp = newProperty();
  syncProp.description = 'Follow up email lists every action item with an owner and a date.';
  syncProp.concern = 'Action item accuracy';
  caseSync.expectedProperties = [syncProp];

  const caseEscalation = newCase();
  caseEscalation.title = 'Escalation review, credit amount undecided';
  caseEscalation.input =
    'Meeting notes. Reviewed the Customer escalation. Team agreed to offer a service credit, no dollar amount decided yet. Priya will draft the credit proposal by Wednesday.';
  const escalationProp = newProperty();
  escalationProp.description = 'Follow up email does not state a credit amount that was never decided.';
  escalationProp.concern = 'Action item accuracy';
  caseEscalation.expectedProperties = [escalationProp];

  const caseBrainstorm = newCase();
  caseBrainstorm.title = 'Unstructured brainstorm, no decisions made';
  caseBrainstorm.input =
    'Meeting notes. Brainstorm ran long with no clear structure. No decisions were made. Team agreed to reconvene next week.';
  const brainstormProp = newProperty();
  brainstormProp.description = 'Email stays brief and does not invent decisions or urgency the meeting did not produce.';
  brainstormProp.concern = 'Tone';
  caseBrainstorm.expectedProperties = [brainstormProp];

  const caseStandup = newCase();
  caseStandup.title = 'Routine standup, opening summary length';
  caseStandup.input = 'Meeting notes. Standup covered sprint status only. Nothing unusual to report.';
  const standupProp = newProperty();
  standupProp.description = 'The opening summary line is under 400 characters.';
  standupProp.concern = 'Length';
  standupProp.checkType = 'length-bounds';
  standupProp.check = { ...defaultCheckConfig(), maxLength: 400 };
  caseStandup.expectedProperties = [standupProp];

  const cases = [caseSync, caseEscalation, caseBrainstorm, caseStandup];

  const outputs: Record<string, string> = {
    [outputKey(candidateA.id, caseSync.id)]:
      'Summary. Launch moves to March 10. Sarah owns the migration doc. Tom will follow up with legal by Friday.',
    [outputKey(candidateB.id, caseSync.id)]:
      'Summary. Launch moves to March 10. Sarah owns the migration doc. Tom will follow up with legal by Friday, reach him directly at 555-0148 if needed.',
    [outputKey(candidateA.id, caseEscalation.id)]:
      'Summary. Escalation reviewed, team will offer a service credit. Priya will draft the proposal by Wednesday.',
    [outputKey(candidateB.id, caseEscalation.id)]:
      'Summary. Escalation reviewed, team will offer a 50 dollar service credit. Priya will draft the proposal by Wednesday.',
    [outputKey(candidateA.id, caseBrainstorm.id)]:
      'Summary. Brainstorm session held, no decisions made, reconvening next week.',
    [outputKey(candidateB.id, caseBrainstorm.id)]:
      'Summary. Team made great progress and finalized next steps, reconvening next week to execute.',
    [outputKey(candidateA.id, caseStandup.id)]: 'Summary. Standup covered sprint status, no blockers reported.',
    [outputKey(candidateB.id, caseStandup.id)]:
      'Summary. Standup covered sprint status in detail, walking through every ticket on the board one at a time, ' +
      'noting the owner, the current state, and the next step for each one individually, plus a short digression ' +
      'about upcoming holiday coverage and a reminder about the code freeze date, none of which changes the plain ' +
      'fact that the standup itself had no blockers of any kind to report to the rest of the team this week.',
  };

  const manualScores: Record<string, PropertyResult> = {
    [scoreKey(candidateA.id, caseSync.id, syncProp.id)]: { passFail: 'pass' },
    [scoreKey(candidateB.id, caseSync.id, syncProp.id)]: { passFail: 'pass' },
    [scoreKey(candidateA.id, caseEscalation.id, escalationProp.id)]: { passFail: 'pass' },
    [scoreKey(candidateB.id, caseEscalation.id, escalationProp.id)]: { passFail: 'fail' },
    [scoreKey(candidateA.id, caseBrainstorm.id, brainstormProp.id)]: { passFail: 'pass' },
    [scoreKey(candidateB.id, caseBrainstorm.id, brainstormProp.id)]: { passFail: 'fail' },
  };

  return {
    formatVersion: FORMAT_VERSION,
    name: 'Meeting follow ups, coverage gap',
    description:
      'Drafting follow up emails from meeting notes, with four concerns declared up front. Every candidate output in this sample is text written for the example, not real output from a model.',
    concerns: ['Action item accuracy', 'Tone', 'Length', 'PII redaction'],
    cases,
    candidates: [candidateA, candidateB],
    outputs,
    manualScores,
    scoreMode: 'pass-fail',
    passThreshold: 0.7,
    confidenceLevel: 95,
    power: 80,
  };
}

export interface Sample {
  id: string;
  name: string;
  teaches: string;
  build: () => EvalPlanState;
}

export const SAMPLES: Sample[] = [
  {
    id: 'support-prompt-revision',
    name: 'Customer support assistant, prompt revision',
    teaches:
      'The current prompt scores well on the easy cases and still fails the eval, because it leaks a credential on the one case marked critical. The revised prompt fixes it and passes.',
    build: buildSample,
  },
  {
    id: 'incident-updates-rubric-flip',
    name: 'Incident status updates, rubric comparison',
    teaches:
      'Scored pass or fail, wording A wins clearly, three passes to one. Score the exact same judgments on a scale of one to five and A drops to zero passing cases, while B edges ahead on one confident and accurate answer. Read the raw pass rates, not just the badges: under the scale neither candidate clears the threshold, so the rubric does not only reorder them, it reveals that neither is shippable yet. The rubric is not cosmetic.',
    build: buildScaledRubricSample,
  },
  {
    id: 'order-extraction-disagreement',
    name: 'Order data extraction, format disagreement',
    teaches:
      'Both prompts pass five of six cases. The aggregate reads as an exact tie. They fail on two different cases each, one prompt breaks format under a foreign currency, the other breaks format when a fee has to be added in. The disagreement panel shows what the aggregate cannot.',
    build: buildDisagreementSample,
  },
  {
    id: 'meeting-followups-coverage-gap',
    name: 'Meeting follow ups, coverage gap',
    teaches:
      'Four concerns are declared, three are actually checked. Nobody wrote a case for PII redaction, so when one candidate repeats a Customer phone number back in its reply, every score still comes back clean. The coverage report is the only place that gap is visible.',
    build: buildCoverageGapSample,
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

export function sampleState(id: string = SAMPLES[0].id): EvalPlanState {
  const sample = getSample(id) ?? SAMPLES[0];
  return sample.build();
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

export function emptyState(): EvalPlanState {
  return {
    formatVersion: FORMAT_VERSION,
    name: '',
    description: '',
    concerns: [],
    cases: [],
    candidates: [newCandidate('Candidate A'), newCandidate('Candidate B')],
    outputs: {},
    manualScores: {},
    scoreMode: 'pass-fail',
    passThreshold: 0.8,
    confidenceLevel: 95,
    power: 80,
  };
}

export function reset(): EvalPlanState {
  return emptyState();
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: EvalPlanState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!state.name.trim()) {
    issues.push({ field: 'name', message: 'Name this evaluation set.', severity: 'error' });
  }
  if (state.cases.length === 0) {
    issues.push({ field: 'cases', message: 'Add at least one case.', severity: 'warning' });
  }
  if (state.candidates.length < 2) {
    issues.push({
      field: 'candidates',
      message: 'Add at least two candidates. A comparison needs two to mean anything.',
      severity: 'warning',
    });
  }
  if (state.passThreshold <= 0 || state.passThreshold > 1) {
    issues.push({
      field: 'passThreshold',
      message: 'Pass threshold must be greater than 0 and no more than 1.',
      severity: 'error',
    });
  }
  for (const c of state.cases) {
    if (c.expectedProperties.length === 0) {
      issues.push({
        field: `case:${c.id}`,
        message: `"${c.title}" has no expected properties, so nothing is actually checked there.`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: EvalPlanState, format: ExportFormat): string {
  const aggregates = computeAllAggregates(state);
  const coverageGaps = computeCoverageGaps(state);
  const divergence = computeCaseDivergence(state);
  const inconsistencies = computeRubricInconsistencies(state);

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Evaluation Workbench',
        note:
          'No model was run or simulated to produce these results. Every deterministic check is a local string or JSON comparison, and every manual score was typed in by the user from a run they already made.',
        state,
        aggregates,
        coverageGaps,
        divergence,
        rubricInconsistencies: inconsistencies,
      },
      null,
      2,
    );
  }

  const lines: string[] = [
    '# Evaluation Workbench report',
    '',
    'No model was run or simulated to produce these results.',
    '',
    `Evaluation set: ${state.name || '(not named)'}`,
    state.description ? `Description: ${state.description}` : '',
    `Cases: ${state.cases.length}. Candidates: ${state.candidates.length}.`,
    '',
    '## Candidate results',
    '',
  ];

  for (const agg of aggregates) {
    lines.push(`### ${agg.candidateLabel}`);
    lines.push('');
    lines.push(`Verdict: ${agg.verdict}.`);
    lines.push(`Scored ${agg.fullyScoredCases} of ${agg.totalCases} cases. Raw pass rate ${(agg.rawPassRate * 100).toFixed(1)} percent. Weighted mean ${(agg.weightedMean * 100).toFixed(1)} percent.`);
    lines.push(
      agg.hasCriticalFailure
        ? `Critical case failure: ${agg.criticalFailures.map((c) => c.title).join(', ')}. This overrides the pass rate above.`
        : 'No critical case failures.',
    );
    if (agg.wilson) {
      lines.push(
        `${agg.wilson.confidenceLevel} percent confidence interval on the observed pass rate: ${(agg.wilson.lower * 100).toFixed(1)} to ${(agg.wilson.upper * 100).toFixed(1)} percent.`,
      );
    }
    lines.push('');
  }

  lines.push('## Detectable regression');
  lines.push('');
  for (const agg of aggregates) {
    if (agg.fullyScoredCases === 0) continue;
    const mde = evalSetMde(state, agg.rawPassRate);
    lines.push(
      `${agg.candidateLabel}: at ${state.cases.length} cases, this eval can detect a true regression of at least ${(mde.delta * 100).toFixed(1)} percentage points from its observed baseline, at ${mde.confidenceLevel} percent confidence and ${mde.power} percent power.`,
    );
  }
  lines.push('');

  lines.push('## Coverage gaps');
  lines.push('');
  lines.push(coverageGaps.length ? coverageGaps.join('\n') : 'None found.');
  lines.push('');

  lines.push('## Disagreement, biggest divergence between candidates');
  lines.push('');
  lines.push(
    divergence.length
      ? divergence
          .slice(0, 5)
          .map(
            (d) =>
              `${d.caseTitle}: spread ${(d.spread * 100).toFixed(1)} percentage points across ${d.scores.map((s) => `${s.candidateLabel} ${(s.score * 100).toFixed(0)} percent`).join(', ')}.`,
          )
          .join('\n')
      : 'No case is fully scored by two or more candidates yet.',
  );
  lines.push('');

  lines.push('## Disagreement, rubric inconsistency by concern');
  lines.push('');
  lines.push(
    inconsistencies.length
      ? inconsistencies
          .map((i) => `${i.candidateLabel}, concern "${i.concern}": ${i.passCount} pass, ${i.failCount} fail across cases.`)
          .join('\n')
      : 'None found.',
  );
  lines.push('');

  return lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');
}

export function filename(_state: EvalPlanState, _format: ExportFormat): string {
  return 'eval-workbench-set';
}

/**
 * Parse a previously exported evaluation set back into state. Accepts
 * either the full export shape, with a state field, or a bare state
 * object. Never throws. Returns an explicit error on anything it
 * cannot make sense of, including a format version it does not
 * recognize, per the PRD instruction to version the portable format.
 */
export function importState(text: string): { ok: true; state: EvalPlanState } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That is not valid JSON.' };
  }

  const raw =
    parsed && typeof parsed === 'object' && 'state' in (parsed as Record<string, unknown>)
      ? (parsed as Record<string, unknown>).state
      : parsed;

  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'No evaluation set found in that JSON.' };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.formatVersion !== 'number' || r.formatVersion > FORMAT_VERSION) {
    return {
      ok: false,
      error: `That evaluation set was exported by a format this tool does not recognize (version ${String(r.formatVersion)}).`,
    };
  }
  if (!Array.isArray(r.cases)) {
    return { ok: false, error: 'That evaluation set has no cases array.' };
  }
  if (!Array.isArray(r.candidates)) {
    return { ok: false, error: 'That evaluation set has no candidates array.' };
  }

  const parseCheck = (raw2: unknown): CheckConfig => {
    const c = (raw2 ?? {}) as Record<string, unknown>;
    return {
      value: typeof c.value === 'string' ? c.value : '',
      flags: typeof c.flags === 'string' ? c.flags : '',
      caseSensitive: Boolean(c.caseSensitive),
      negate: Boolean(c.negate),
      minLength: typeof c.minLength === 'number' ? c.minLength : null,
      maxLength: typeof c.maxLength === 'number' ? c.maxLength : null,
      requiredKeys: Array.isArray(c.requiredKeys) ? c.requiredKeys.map((k) => String(k)) : [],
    };
  };

  const parseProperty = (raw2: unknown, i: number): ExpectedProperty => {
    const p = (raw2 ?? {}) as Record<string, unknown>;
    return {
      id: typeof p.id === 'string' ? p.id : nextId('prop'),
      description: typeof p.description === 'string' ? p.description : `Property ${i + 1}`,
      concern: typeof p.concern === 'string' ? p.concern : '',
      weight: typeof p.weight === 'number' && p.weight > 0 ? p.weight : 1,
      checkType: (CHECK_TYPES as readonly string[]).includes(p.checkType as string)
        ? (p.checkType as CheckType)
        : 'manual',
      check: parseCheck(p.check),
    };
  };

  const cases: EvalCase[] = (r.cases as unknown[]).map((raw2, i) => {
    const c = (raw2 ?? {}) as Record<string, unknown>;
    return {
      id: typeof c.id === 'string' ? c.id : nextId('case'),
      title: typeof c.title === 'string' ? c.title : `Case ${i + 1}`,
      input: typeof c.input === 'string' ? c.input : '',
      critical: Boolean(c.critical),
      expectedProperties: Array.isArray(c.expectedProperties)
        ? c.expectedProperties.map((p, j) => parseProperty(p, j))
        : [],
    };
  });

  const candidates: Candidate[] = (r.candidates as unknown[]).map((raw2, i) => {
    const c = (raw2 ?? {}) as Record<string, unknown>;
    return {
      id: typeof c.id === 'string' ? c.id : nextId('cand'),
      label: typeof c.label === 'string' ? c.label : `Candidate ${i + 1}`,
    };
  });

  const outputs: Record<string, string> =
    r.outputs && typeof r.outputs === 'object'
      ? Object.fromEntries(
          Object.entries(r.outputs as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : '']),
        )
      : {};

  const manualScores: Record<string, PropertyResult> =
    r.manualScores && typeof r.manualScores === 'object' ? (r.manualScores as Record<string, PropertyResult>) : {};

  const state: EvalPlanState = {
    formatVersion: FORMAT_VERSION,
    name: typeof r.name === 'string' ? r.name : '',
    description: typeof r.description === 'string' ? r.description : '',
    concerns: Array.isArray(r.concerns) ? r.concerns.map((c) => String(c)) : [],
    cases,
    candidates,
    outputs,
    manualScores,
    scoreMode: r.scoreMode === 'scale-5' ? 'scale-5' : 'pass-fail',
    passThreshold: typeof r.passThreshold === 'number' ? r.passThreshold : 0.8,
    confidenceLevel: (CONFIDENCE_LEVELS as number[]).includes(r.confidenceLevel as number)
      ? (r.confidenceLevel as ConfidenceLevel)
      : 95,
    power: (POWER_LEVELS as number[]).includes(r.power as number) ? (r.power as PowerLevel) : 80,
  };

  return { ok: true, state };
}
