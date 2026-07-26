/**
 * Evaluation Workbench, logic gate.
 *
 * Run: bun tests/tool-eval-workbench.mjs
 *
 * The PRD's whole design brief is a statistics claim: an eval only
 * works if it can actually detect the regression it is meant to catch.
 * So this gate spends most of its weight proving the Wilson interval
 * and the minimum detectable effect are real, not hand waved, and that
 * the critical case gate cannot be defeated by a high aggregate score.
 */

import {
  wilsonInterval,
  minimumDetectableEffect,
  recommendGrader,
  FAILURE_CATEGORIES,
  GRADER_TYPES,
  generateCasePlan,
  CASE_BUCKETS,
  computeAggregate,
  describePlan,
  emptyState,
  sampleState,
  reset,
  validate,
  serialize,
  importState,
  SAMPLES,
  normalizeResult,
  setResult,
} from '../src/lib/tools/eval-workbench.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

function close(a, b, tolerance, label, detail) {
  expect(label, Math.abs(a - b) <= tolerance, `${detail}: got ${a}, expected within ${tolerance} of ${b}`);
}

console.log('eval-workbench logic gate');

/* ------------------------------------------------------------------ *
 * 1. Wilson interval against known and hand derived reference values.
 * ------------------------------------------------------------------ */

// Reference 1. n=100, successes=80, 95 percent. Published example: the
// Wilson interval is approximately 0.7111 to 0.8668.
const r1 = wilsonInterval(80, 100, 95);
close(r1.lower, 0.7111, 0.002, 'wilson n100x80 lower', 'n=100 x=80 95%');
close(r1.upper, 0.8668, 0.002, 'wilson n100x80 upper', 'n=100 x=80 95%');
console.log(`  n=100 x=80 95%: [${r1.lower.toFixed(4)}, ${r1.upper.toFixed(4)}], expected approx [0.7111, 0.8668]`);

// Reference 2. n=20, successes=10 (p=0.5), 95 percent. Hand derived
// from the closed form: center is exactly 0.5 by symmetry whenever
// phat=0.5, and the margin works out to about 0.2007, giving
// approximately 0.2993 to 0.7007.
const r2 = wilsonInterval(10, 20, 95);
expect('wilson n20x10 center', Math.abs(r2.center - 0.5) < 1e-9, `center should be exactly 0.5 at phat=0.5, got ${r2.center}`);
close(r2.lower, 0.2993, 0.002, 'wilson n20x10 lower', 'n=20 x=10 95%');
close(r2.upper, 0.7007, 0.002, 'wilson n20x10 upper', 'n=20 x=10 95%');
console.log(`  n=20 x=10 95%: [${r2.lower.toFixed(4)}, ${r2.upper.toFixed(4)}], expected approx [0.2993, 0.7007]`);

// Reference 3. n=50, successes=45 (p=0.9), 95 percent. Hand derived:
// approximately 0.7864 to 0.9565.
const r3 = wilsonInterval(45, 50, 95);
close(r3.lower, 0.7864, 0.003, 'wilson n50x45 lower', 'n=50 x=45 95%');
close(r3.upper, 0.9565, 0.003, 'wilson n50x45 upper', 'n=50 x=45 95%');
console.log(`  n=50 x=45 95%: [${r3.lower.toFixed(4)}, ${r3.upper.toFixed(4)}], expected approx [0.7864, 0.9565]`);

/* ------------------------------------------------------------------ *
 * 2. Edge cases that break a normal approximation.
 * ------------------------------------------------------------------ */

// Zero successes. A Wald interval collapses to a single point at 0
// with zero width, which is nonsense: it claims certainty about a
// quantity nobody has evidence for.
const zero = wilsonInterval(0, 20, 95);
expect('wilson zero successes bounded', zero.lower >= 0 && zero.upper <= 1, `bounds out of range: ${zero.lower}, ${zero.upper}`);
expect('wilson zero successes nondegenerate', zero.upper - zero.lower > 0.05, `interval too narrow at x=0: width ${zero.upper - zero.lower}`);
expect('wilson zero successes lower is zero-ish', zero.lower >= 0 && zero.lower < 0.05, `expected a lower bound near 0, got ${zero.lower}`);
console.log(`  n=20 x=0: [${zero.lower.toFixed(4)}, ${zero.upper.toFixed(4)}], nondegenerate`);

// All successes. A Wald interval collapses to a single point at 1.
const all = wilsonInterval(20, 20, 95);
expect('wilson all successes bounded', all.lower >= 0 && all.upper <= 1, `bounds out of range: ${all.lower}, ${all.upper}`);
expect('wilson all successes nondegenerate', all.upper - all.lower > 0.05, `interval too narrow at x=n: width ${all.upper - all.lower}`);
expect('wilson all successes upper is one-ish', all.upper <= 1 && all.upper > 0.95, `expected an upper bound near 1, got ${all.upper}`);
console.log(`  n=20 x=20: [${all.lower.toFixed(4)}, ${all.upper.toFixed(4)}], nondegenerate`);

// n=1. The most extreme case: almost no evidence, so the interval
// should be wide, and still bounded.
const one0 = wilsonInterval(0, 1, 95);
const one1 = wilsonInterval(1, 1, 95);
expect('wilson n=1 x=0 bounded', one0.lower >= 0 && one0.upper <= 1, `bounds out of range: ${one0.lower}, ${one0.upper}`);
expect('wilson n=1 x=1 bounded', one1.lower >= 0 && one1.upper <= 1, `bounds out of range: ${one1.lower}, ${one1.upper}`);
expect('wilson n=1 x=0 wide', one0.upper - one0.lower > 0.5, `expected a wide interval at n=1, got width ${one0.upper - one0.lower}`);
expect('wilson n=1 x=1 wide', one1.upper - one1.lower > 0.5, `expected a wide interval at n=1, got width ${one1.upper - one1.lower}`);
console.log(`  n=1 x=0: [${one0.lower.toFixed(4)}, ${one0.upper.toFixed(4)}], n=1 x=1: [${one1.lower.toFixed(4)}, ${one1.upper.toFixed(4)}]`);

/* ------------------------------------------------------------------ *
 * 3. The interval always lies within 0 to 1, across a sweep.
 * ------------------------------------------------------------------ */

let sweepChecked = 0;
for (const n of [1, 2, 3, 5, 10, 25, 50, 100, 250]) {
  for (const confidenceLevel of [90, 95, 99]) {
    for (let x = 0; x <= n; x++) {
      const result = wilsonInterval(x, n, confidenceLevel);
      expect(
        'wilson bounds sweep',
        result.lower >= 0 && result.upper <= 1 && result.lower <= result.upper,
        `n=${n} x=${x} conf=${confidenceLevel}: [${result.lower}, ${result.upper}]`,
      );
      sweepChecked += 1;
    }
  }
}
console.log(`  wilson bounds swept and verified across ${sweepChecked} (n, x, confidence) combinations`);

/* ------------------------------------------------------------------ *
 * 4. Minimum detectable effect shrinks monotonically as n grows.
 * ------------------------------------------------------------------ */

const nSeries = [10, 20, 50, 100, 200, 500, 1000];
const mdeSeries = nSeries.map((n) => minimumDetectableEffect(n, 0.9, 95, 80).delta);
let monotonic = true;
for (let i = 1; i < mdeSeries.length; i++) {
  if (mdeSeries[i] >= mdeSeries[i - 1]) monotonic = false;
}
expect('mde monotonic', monotonic, `series did not shrink monotonically: ${mdeSeries.map((d) => d.toFixed(4)).join(', ')}`);
console.log(
  `  mde by n at baseline 90%, 95% confidence, 80% power: ` +
    nSeries.map((n, i) => `n=${n} -> ${(mdeSeries[i] * 100).toFixed(1)}%`).join(', '),
);

// The team's specific honesty claim: a 20 case eval cannot detect a 5
// percentage point regression at a typical high baseline pass rate.
const smallEval = minimumDetectableEffect(20, 0.9, 95, 80);
expect(
  'mde honesty at n=20',
  smallEval.delta > 0.05,
  `expected the minimum detectable effect at n=20 to exceed 5 percentage points, got ${(smallEval.delta * 100).toFixed(1)}%`,
);
console.log(`  n=20, baseline 90%: minimum detectable effect is ${(smallEval.delta * 100).toFixed(1)} percentage points, confirming a 20 case eval cannot see a 5 point regression`);

/* ------------------------------------------------------------------ *
 * 5. Grader recommendation is deterministic per failure category.
 * ------------------------------------------------------------------ */

expect('categories', FAILURE_CATEGORIES.length === 8, `expected 8 failure categories, got ${FAILURE_CATEGORIES.length}`);
for (const category of FAILURE_CATEGORIES) {
  const first = recommendGrader(category);
  const second = recommendGrader(category);
  expect('grader deterministic', first.grader === second.grader, `${category} returned different graders on repeat calls`);
  expect('grader is valid type', GRADER_TYPES.includes(first.grader), `${category} recommended an unknown grader type "${first.grader}"`);
  expect('grader has rationale', Boolean(first.rationale && first.rationale.length > 20), `${category} grader recommendation has no substantive rationale`);
  expect('grader has tradeoff', Boolean(first.tradeoff && first.tradeoff.length > 20), `${category} grader recommendation has no substantive tradeoff`);
}
const expectedMapping = {
  'wrong-facts': 'model',
  'format-drift': 'code',
  'unsafe-output': 'human',
  refusal: 'model',
  verbosity: 'code',
  inconsistency: 'code',
  regression: 'model',
  'prompt-injection': 'code',
};
for (const [category, expectedGrader] of Object.entries(expectedMapping)) {
  expect(
    'grader mapping',
    recommendGrader(category).grader === expectedGrader,
    `${category}: expected ${expectedGrader}, got ${recommendGrader(category).grader}`,
  );
}
console.log(`  grader recommendations deterministic and typed across all ${FAILURE_CATEGORIES.length} categories`);

/* ------------------------------------------------------------------ *
 * 6. Case plan generation. Sums to n exactly, buckets nonnegative.
 * ------------------------------------------------------------------ */

let planChecks = 0;
for (const category of FAILURE_CATEGORIES) {
  for (const n of [0, 1, 2, 3, 5, 20, 37, 100]) {
    const plan = generateCasePlan(category, n);
    expect('case plan sums to n', plan.length === n, `${category} n=${n}: got ${plan.length} cases`);
    for (const c of plan) {
      expect('case has bucket', CASE_BUCKETS.includes(c.bucket), `${category} n=${n}: case has unknown bucket "${c.bucket}"`);
      expect('case has expected property', Boolean(c.expectedProperty), `${category} n=${n}: a case has no expected property`);
    }
    planChecks += 1;
  }
}
console.log(`  case plan generation verified across ${planChecks} (category, n) combinations, every plan sums to n exactly`);

/* ------------------------------------------------------------------ *
 * 7. Critical case gate. A high aggregate score cannot hide a failed
 * critical case. This is the PRD acceptance criterion, made concrete.
 * ------------------------------------------------------------------ */

const base = emptyState();
base.cases = [
  { id: 'c1', bucket: 'core', title: 'Core 1', expectedProperty: 'x', critical: false, weight: 1 },
  { id: 'c2', bucket: 'core', title: 'Core 2', expectedProperty: 'x', critical: false, weight: 1 },
  { id: 'c3', bucket: 'core', title: 'Core 3', expectedProperty: 'x', critical: false, weight: 1 },
  { id: 'c4', bucket: 'core', title: 'Core 4', expectedProperty: 'x', critical: false, weight: 1 },
  { id: 'c5', bucket: 'adversarial', title: 'Adversarial 1', expectedProperty: 'x', critical: true, weight: 1 },
];
base.results = {
  c1: { passFail: 'pass' },
  c2: { passFail: 'pass' },
  c3: { passFail: 'pass' },
  c4: { passFail: 'pass' },
  c5: { passFail: 'fail' },
};
base.passThreshold = 0.85;
const aggregateWithCriticalFailure = computeAggregate(base);
expect(
  'weighted score is high',
  aggregateWithCriticalFailure.weightedScore >= 0.79,
  `expected a high weighted score with 4 of 5 passing, got ${aggregateWithCriticalFailure.weightedScore}`,
);
expect(
  'critical failure detected',
  aggregateWithCriticalFailure.hasCriticalFailure === true,
  'the failed critical case was not detected',
);
expect(
  'verdict is fail despite high score',
  aggregateWithCriticalFailure.verdict === 'fail',
  `a critical case failed but the verdict was "${aggregateWithCriticalFailure.verdict}", the aggregate score hid the failure`,
);
console.log(
  `  critical case gate: weighted score ${(aggregateWithCriticalFailure.weightedScore * 100).toFixed(0)}% still produced verdict "${aggregateWithCriticalFailure.verdict}" because a critical case failed`,
);

// The converse. All cases pass, including the critical one, and the
// set is fully scored: the verdict must be pass.
const allPass = { ...base, results: { c1: { passFail: 'pass' }, c2: { passFail: 'pass' }, c3: { passFail: 'pass' }, c4: { passFail: 'pass' }, c5: { passFail: 'pass' } } };
const aggregateAllPass = computeAggregate(allPass);
expect('verdict pass when nothing critical fails', aggregateAllPass.verdict === 'pass', `expected pass, got "${aggregateAllPass.verdict}"`);

// Incomplete scoring must not be reported as a pass.
const partial = { ...base, results: { c1: { passFail: 'pass' } } };
const aggregatePartial = computeAggregate(partial);
expect('verdict incomplete when not fully scored', aggregatePartial.verdict === 'incomplete', `expected incomplete, got "${aggregatePartial.verdict}"`);

/* ------------------------------------------------------------------ *
 * 8. Aggregation disagreement, and scaled rubric normalization.
 * ------------------------------------------------------------------ */

expect('normalize pass-fail pass', normalizeResult('pass-fail', { passFail: 'pass' }) === 1, 'pass should normalize to 1');
expect('normalize pass-fail fail', normalizeResult('pass-fail', { passFail: 'fail' }) === 0, 'fail should normalize to 0');
expect('normalize scale', normalizeResult('scale-5', { scale: 4 }) === 0.8, 'a scale of 4 of 5 should normalize to 0.8');
expect('normalize unscored', normalizeResult('pass-fail', undefined) === undefined, 'an absent result should normalize to undefined');

const results1 = setResult({}, 'a', { passFail: 'pass' });
expect('setResult adds', results1.a?.passFail === 'pass', 'setResult did not record a score');
const results2 = setResult(results1, 'a', undefined);
expect('setResult clears', results2.a === undefined, 'setResult did not clear a score back to unscored');

/* ------------------------------------------------------------------ *
 * 9. Samples.
 * ------------------------------------------------------------------ */

expect('samples count', SAMPLES.length >= 2, `expected at least 2 samples, got ${SAMPLES.length}`);
for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} is missing a field`);
  expect('sample has cases', s.state.cases.length > 0, `sample ${s.id} has no cases`);
  const issues = validate(s.state);
  expect('sample validates clean', issues.filter((i) => i.severity === 'error').length === 0, `sample ${s.id} fails validation: ${JSON.stringify(issues)}`);
}
console.log(`  samples: ${SAMPLES.map((s) => s.id).join(', ')}`);

/* ------------------------------------------------------------------ *
 * 10. Reset and empty state.
 * ------------------------------------------------------------------ */

expect('empty state has no cases', emptyState().cases.length === 0, 'empty state should start with no cases');
expect('reset equals empty', JSON.stringify(reset()) === JSON.stringify(emptyState()), 'reset should return the same shape as emptyState');
const emptyIssues = validate(emptyState());
expect('empty state fails validation', emptyIssues.some((i) => i.severity === 'error'), 'an empty state produced no error');

/* ------------------------------------------------------------------ *
 * 11. Export and import round trip.
 * ------------------------------------------------------------------ */

const exportSource = sampleState('support-format-drift');
const json = serialize(exportSource, 'json');
const parsed = JSON.parse(json);
expect('export json has state', parsed.state.category === 'format-drift', 'JSON export lost the category');
expect('export json discloses no model', typeof parsed.note === 'string' && /No model/i.test(parsed.note), 'JSON export does not disclose that no model was run');

const imported = importState(json);
expect('import ok', imported.ok === true, `import failed: ${imported.ok ? '' : imported.error}`);
if (imported.ok) {
  expect('import preserves category', imported.state.category === exportSource.category, 'import lost the category');
  expect('import preserves case count', imported.state.cases.length === exportSource.cases.length, 'import lost cases');
  expect('import preserves n', imported.state.plannedN === exportSource.plannedN, 'import lost plannedN');
}

const badImport = importState('not json at all');
expect('import rejects garbage', badImport.ok === false, 'importing garbage should fail rather than throw or silently succeed');

const md = serialize(exportSource, 'markdown');
expect('export markdown header', md.includes('# Evaluation Workbench plan'), 'markdown export missing header');
expect('export markdown discloses no model', /No model was run or simulated/i.test(md), 'markdown export does not disclose that no model was run');
console.log(`  export/import: json ${json.length} bytes, markdown ${md.length} bytes, round trip verified`);

/* ------------------------------------------------------------------ *
 * 12. Plan honesty statements reference real numbers.
 * ------------------------------------------------------------------ */

const plan = describePlan(exportSource);
expect('plan states pass criterion', plan.passCriterion.includes('critical'), 'pass criterion does not mention critical cases');
expect('plan states what it proves', /confidence/.test(plan.provesStatement), 'proves statement does not mention confidence');
expect('plan states what it does not prove', /regression/.test(plan.doesNotProveStatement), 'does not prove statement does not mention regression');
console.log(`  plan for "${exportSource.category}": ${plan.cases.length} cases, grader ${plan.grader.grader}`);

/* ---- Report ------------------------------------------------------ */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`EVAL WORKBENCH LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('EVAL WORKBENCH LOGIC: CLEAN');
