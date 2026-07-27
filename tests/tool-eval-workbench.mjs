/**
 * Evaluation Workbench, logic gate.
 *
 * Run: bun tests/tool-eval-workbench.mjs
 *
 * This tool's headline acceptance criterion, quoted from the PRD, is
 * "Prevent aggregate scores from hiding failed critical cases." So the
 * critical case override gets the most scrutiny below: a set with a
 * high average and one failed critical case must report an overall
 * failure, with no arithmetic path around it. The Wilson interval work
 * from the design pass is kept and verified again, since the brief
 * that asked for it was correct even though its framing of the whole
 * tool was not.
 */

import {
  wilsonInterval,
  minimumDetectableEffect,
  evalSetMde,
  runCheck,
  propertyScore,
  computeCaseOutcome,
  computeCandidateAggregate,
  computeAllAggregates,
  computeCoverageGaps,
  computeCaseDivergence,
  computeRubricInconsistencies,
  newCase,
  newProperty,
  newCandidate,
  defaultCheckConfig,
  withCaseAdded,
  withCaseUpdated,
  withCaseRemoved,
  withPropertyAdded,
  withPropertyUpdated,
  withCandidateAdded,
  withOutputSet,
  withManualScoreSet,
  emptyState,
  reset,
  sampleState,
  validate,
  serialize,
  importState,
  getSample,
  SAMPLES,
  FORMAT_VERSION,
  outputKey,
  scoreKey,
  CASE_PASS_NORMALIZED,
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

/* ==================================================================
 * 1. THE HEADLINE CRITERION. Prevent aggregate scores from hiding
 * failed critical cases. Build a set where the average is high and
 * one critical case fails, assert the overall verdict is a failure.
 * ================================================================== */

function buildCriticalGateFixture() {
  let state = emptyState();
  state = withCaseUpdated(state, state.candidates[0].id, {}); // no-op, candidates already exist
  const candidateId = state.candidates[0].id;

  // Five easy, non critical cases, each with one manual property that
  // will be scored as a clean pass.
  for (let i = 0; i < 5; i++) {
    state = withCaseAdded(state);
    const evalCase = state.cases[state.cases.length - 1];
    state = withCaseUpdated(state, evalCase.id, { title: `Easy case ${i + 1}`, critical: false });
    state = withPropertyAdded(state, evalCase.id);
    const property = state.cases[state.cases.length - 1].expectedProperties[0];
    state = withManualScoreSet(state, candidateId, evalCase.id, property.id, { passFail: 'pass' });
  }

  // One critical case, one property, scored as a fail.
  state = withCaseAdded(state);
  const criticalCase = state.cases[state.cases.length - 1];
  state = withCaseUpdated(state, criticalCase.id, { title: 'Critical safety case', critical: true });
  state = withPropertyAdded(state, criticalCase.id);
  const criticalProperty = state.cases[state.cases.length - 1].expectedProperties[0];
  state = withManualScoreSet(state, candidateId, criticalCase.id, criticalProperty.id, { passFail: 'fail' });

  return { state, candidateId };
}

const { state: gateState, candidateId: gateCandidateId } = buildCriticalGateFixture();
const gateAggregate = computeCandidateAggregate(gateState, gateCandidateId);

expect(
  'headline: high raw pass rate',
  gateAggregate.rawPassRate >= 0.8,
  `expected 5 of 6 cases passing (about 83 percent), got ${(gateAggregate.rawPassRate * 100).toFixed(1)} percent`,
);
expect('headline: critical failure detected', gateAggregate.hasCriticalFailure === true, 'the failed critical case was not detected');
expect(
  'headline: verdict is fail despite high score',
  gateAggregate.verdict === 'fail',
  `raw pass rate was ${(gateAggregate.rawPassRate * 100).toFixed(1)} percent but verdict was "${gateAggregate.verdict}"; the aggregate score hid the critical failure`,
);
console.log(
  `  headline: raw pass rate ${(gateAggregate.rawPassRate * 100).toFixed(1)} percent (5 of 6) still produced verdict "${gateAggregate.verdict}" because the critical case failed`,
);

// The converse. Fix the critical case to a pass, fully scored, verdict must become pass.
const criticalCase = gateState.cases.find((c) => c.critical);
const fixedState = withManualScoreSet(
  gateState,
  gateCandidateId,
  criticalCase.id,
  criticalCase.expectedProperties[0].id,
  { passFail: 'pass' },
);
const fixedAggregate = computeCandidateAggregate(fixedState, gateCandidateId);
expect('headline: fixing the critical case allows a pass', fixedAggregate.verdict === 'pass', `expected pass once every case passes, got "${fixedAggregate.verdict}"`);

// Incomplete scoring must never read as a pass, critical case or not.
const partialState = withManualScoreSet(gateState, gateCandidateId, criticalCase.id, criticalCase.expectedProperties[0].id, undefined);
const partialAggregate = computeCandidateAggregate(partialState, gateCandidateId);
expect('incomplete is never a pass', partialAggregate.verdict === 'incomplete', `expected incomplete, got "${partialAggregate.verdict}"`);

// A critical case with partial credit, some properties pass and one
// fails, must still fail as a whole case. No averaging inside a
// critical case.
let strictState = emptyState();
strictState = withCaseAdded(strictState);
const strictCase = strictState.cases[0];
strictState = withCaseUpdated(strictState, strictCase.id, { critical: true });
strictState = withPropertyAdded(strictState, strictCase.id);
strictState = withPropertyAdded(strictState, strictCase.id);
strictState = withPropertyAdded(strictState, strictCase.id);
const strictProps = strictState.cases[0].expectedProperties;
const strictCandidateId = strictState.candidates[0].id;
strictState = withManualScoreSet(strictState, strictCandidateId, strictCase.id, strictProps[0].id, { passFail: 'pass' });
strictState = withManualScoreSet(strictState, strictCandidateId, strictCase.id, strictProps[1].id, { passFail: 'pass' });
strictState = withManualScoreSet(strictState, strictCandidateId, strictCase.id, strictProps[2].id, { passFail: 'fail' });
const strictOutcome = computeCaseOutcome(strictState.cases[0], strictCandidateId, strictState);
expect(
  'critical case: no partial credit',
  strictOutcome.passed === false,
  `two of three properties passed on a critical case, expected the case to fail outright, got passed=${strictOutcome.passed}`,
);
expect('critical case: weighted score is still high', strictOutcome.weightedScore > 0.6, `expected a high weighted score, got ${strictOutcome.weightedScore}`);
console.log(`  critical case with 2 of 3 properties passing: weighted score ${(strictOutcome.weightedScore * 100).toFixed(0)} percent, case outcome passed=${strictOutcome.passed}`);

/* ==================================================================
 * 2. Deterministic checks. Each of the five kinds, run for real.
 * ================================================================== */

function propertyWith(checkType, checkPatch) {
  const p = newProperty();
  p.checkType = checkType;
  p.check = { ...defaultCheckConfig(), ...checkPatch };
  return p;
}

// Exact match.
{
  const p = propertyWith('exact-match', { value: 'Refund approved' });
  expect('exact-match pass', runCheck(p, 'Refund approved').status === 'pass', 'identical text should pass');
  expect('exact-match fail', runCheck(p, 'Refund denied').status === 'fail', 'different text should fail');
  expect('exact-match trims and compares', runCheck(p, '  Refund approved  ').status === 'pass', 'surrounding whitespace should be trimmed before comparing');
}

// Contains, including negate for a must not check.
{
  const p = propertyWith('contains', { value: 'policy' });
  expect('contains pass', runCheck(p, 'This follows our refund policy.').status === 'pass', 'text containing the substring should pass');
  expect('contains fail', runCheck(p, 'This is a generic reply.').status === 'fail', 'text missing the substring should fail');

  const forbidden = propertyWith('contains', { value: 'TEMP-88213', negate: true });
  expect('contains negate pass', runCheck(forbidden, 'A temporary password has been sent.').status === 'pass', 'absence of the forbidden text should pass under negate');
  expect('contains negate fail', runCheck(forbidden, 'Your temporary password is TEMP-88213.').status === 'fail', 'presence of the forbidden text should fail under negate');
}

// Regex, including an invalid pattern reported as an error, not a crash.
{
  const p = propertyWith('regex', { value: '^\\{.*\\}$', flags: 's' });
  expect('regex pass', runCheck(p, '{"a": 1}').status === 'pass', 'text matching the pattern should pass');
  expect('regex fail', runCheck(p, 'not json').status === 'fail', 'text not matching the pattern should fail');

  const invalid = propertyWith('regex', { value: '(unclosed' });
  const invalidResult = runCheck(invalid, 'anything');
  expect('regex invalid pattern reported as error', invalidResult.status === 'error', `an invalid pattern should report status error, got "${invalidResult.status}"`);

  const negatedRegex = propertyWith('regex', { value: 'TEMP-[0-9]{4,}', negate: true });
  expect('regex negate pass', runCheck(negatedRegex, 'password sent separately').status === 'pass', 'no match under negate should pass');
  expect('regex negate fail', runCheck(negatedRegex, 'code is TEMP-99213').status === 'fail', 'a match under negate should fail');
}

// JSON schema, meaning a JSON object with required top level keys.
{
  const p = propertyWith('json-schema', { requiredKeys: ['orderId', 'status'] });
  expect('json-schema pass', runCheck(p, '{"orderId": "1", "status": "ok", "extra": true}').status === 'pass', 'a JSON object with every required key should pass');
  expect('json-schema fail missing key', runCheck(p, '{"orderId": "1"}').status === 'fail', 'a JSON object missing a required key should fail');
  expect('json-schema fail invalid json', runCheck(p, 'not json at all').status === 'fail', 'text that is not valid JSON should fail, not error');
  expect('json-schema fail array', runCheck(p, '[1,2,3]').status === 'fail', 'a JSON array is not a JSON object and should fail');
}

// Length bounds.
{
  const p = propertyWith('length-bounds', { minLength: 10, maxLength: 20 });
  expect('length-bounds pass', runCheck(p, '12345678901234').status === 'pass', 'text of 14 characters should be within 10 to 20');
  expect('length-bounds fail too short', runCheck(p, 'short').status === 'fail', 'text under the minimum should fail');
  expect('length-bounds fail too long', runCheck(p, 'x'.repeat(50)).status === 'fail', 'text over the maximum should fail');
}

// Manual and unscored.
{
  const manual = newProperty();
  expect('manual with no output is unscored', runCheck(manual, 'anything').status === 'unscored', 'a manual property should never resolve through runCheck');
  const detCheck = propertyWith('contains', { value: 'x' });
  expect('deterministic with empty output is unscored', runCheck(detCheck, '').status === 'unscored', 'no output pasted yet should read as unscored, not a failure');
}

console.log('  deterministic checks: exact match, contains, regex, json schema, length bounds, all verified including negate and invalid input');

/* ==================================================================
 * 3. Both rubric types genuinely score, not one stubbed behind the
 * other.
 * ================================================================== */

{
  let state = emptyState();
  state = withCaseAdded(state);
  const evalCase = state.cases[0];
  state = withPropertyAdded(state, evalCase.id);
  const property = state.cases[0].expectedProperties[0];
  const candidateId = state.candidates[0].id;

  // Pass or fail rubric.
  state.scoreMode = 'pass-fail';
  let withPass = withManualScoreSet(state, candidateId, evalCase.id, property.id, { passFail: 'pass' });
  expect('pass-fail: pass normalizes to 1', propertyScore(property, '', 'pass-fail', withPass.manualScores[scoreKey(candidateId, evalCase.id, property.id)]) === 1, 'a pass should normalize to a score of 1');
  let withFail = withManualScoreSet(state, candidateId, evalCase.id, property.id, { passFail: 'fail' });
  expect('pass-fail: fail normalizes to 0', propertyScore(property, '', 'pass-fail', withFail.manualScores[scoreKey(candidateId, evalCase.id, property.id)]) === 0, 'a fail should normalize to a score of 0');

  // Scale of 1 to 5 rubric.
  state.scoreMode = 'scale-5';
  let withScale4 = withManualScoreSet(state, candidateId, evalCase.id, property.id, { scale: 4 });
  const score4 = propertyScore(property, '', 'scale-5', withScale4.manualScores[scoreKey(candidateId, evalCase.id, property.id)]);
  expect('scale-5: a 4 of 5 normalizes to 0.8', Math.abs(score4 - 0.8) < 1e-9, `expected 0.8, got ${score4}`);
  expect('scale-5: a 4 of 5 counts as passing', score4 >= CASE_PASS_NORMALIZED, 'a scale score of 4 of 5 should clear the case pass threshold');
  let withScale2 = withManualScoreSet(state, candidateId, evalCase.id, property.id, { scale: 2 });
  const score2 = propertyScore(property, '', 'scale-5', withScale2.manualScores[scoreKey(candidateId, evalCase.id, property.id)]);
  expect('scale-5: a 2 of 5 normalizes to 0.4', Math.abs(score2 - 0.4) < 1e-9, `expected 0.4, got ${score2}`);
  expect('scale-5: a 2 of 5 counts as failing', score2 < CASE_PASS_NORMALIZED, 'a scale score of 2 of 5 should not clear the case pass threshold');

  console.log(`  rubric: pass-fail normalizes to 1/0, scale-5 normalizes a 4 to ${score4} and a 2 to ${score2}, both genuinely scored`);
}

/* ==================================================================
 * 4. Import and export round trip, including format version rejection.
 * ================================================================== */

{
  const source = sampleState();
  const json = serialize(source, 'json');
  const parsed = JSON.parse(json);
  expect('export json has state', parsed.state.name === source.name, 'JSON export lost the evaluation set name');
  expect('export json discloses no model', typeof parsed.note === 'string' && /No model/i.test(parsed.note), 'JSON export does not disclose that no model was run');
  expect('export json carries format version', parsed.state.formatVersion === FORMAT_VERSION, 'exported state is missing its format version');

  const imported = importState(json);
  expect('import ok', imported.ok === true, `import failed: ${imported.ok ? '' : imported.error}`);
  if (imported.ok) {
    expect('import preserves name', imported.state.name === source.name, 'import lost the evaluation set name');
    expect('import preserves case count', imported.state.cases.length === source.cases.length, 'import lost cases');
    expect('import preserves candidate count', imported.state.candidates.length === source.candidates.length, 'import lost candidates');
    expect('import preserves an output', imported.state.outputs[outputKey(source.candidates[0].id, source.cases[0].id)] === source.outputs[outputKey(source.candidates[0].id, source.cases[0].id)], 'import lost a pasted output');

    // The imported set should reproduce the same verdicts as the source.
    const sourceAgg = computeAllAggregates(source);
    const importedAgg = computeAllAggregates(imported.state);
    expect('import round trip preserves verdicts', sourceAgg.map((a) => a.verdict).join(',') === importedAgg.map((a) => a.verdict).join(','), 'verdicts differ after a round trip through export and import');
  }

  const badJson = importState('not json at all');
  expect('import rejects garbage', badJson.ok === false, 'importing garbage should fail rather than throw or silently succeed');

  const futureVersion = JSON.stringify({ ...JSON.parse(json), state: { ...source, formatVersion: FORMAT_VERSION + 1 } });
  const futureResult = importState(futureVersion);
  expect('import rejects a newer format version', futureResult.ok === false, 'a plan from a newer format version should be rejected, not silently accepted');

  const md = serialize(source, 'markdown');
  expect('export markdown header', md.includes('# Evaluation Workbench report'), 'markdown export missing header');
  expect('export markdown discloses no model', /No model was run or simulated/i.test(md), 'markdown export does not disclose that no model was run');

  console.log(`  export/import: json ${json.length} bytes, markdown ${md.length} bytes, round trip preserves verdicts, future format version rejected`);
}

/* ==================================================================
 * 5. Coverage gap detection.
 * ================================================================== */

{
  let state = emptyState();
  state.name = 'Coverage test';
  state.concerns = ['Accuracy', 'Tone', 'Never checked'];
  state = withCaseAdded(state);
  const caseWithProps = state.cases[0];
  state = withPropertyAdded(state, caseWithProps.id);
  state = withCaseUpdated(state, caseWithProps.id, {
    expectedProperties: [{ ...state.cases[0].expectedProperties[0], concern: 'Accuracy' }],
  });
  state = withCaseAdded(state); // a second case with no expected properties at all

  const gaps = computeCoverageGaps(state);
  expect('coverage: unused concern flagged', gaps.some((g) => g.includes('Never checked')), `expected a gap naming the unused concern, got: ${JSON.stringify(gaps)}`);
  expect('coverage: used concern not flagged', !gaps.some((g) => g.includes('"Accuracy"')), `the exercised concern should not appear as a gap: ${JSON.stringify(gaps)}`);
  expect('coverage: empty case flagged', gaps.some((g) => g.includes('no expected properties')), `expected a gap about the case with no properties, got: ${JSON.stringify(gaps)}`);

  const tooFewCandidates = { ...state, candidates: [state.candidates[0]] };
  const gapsOneCandidate = computeCoverageGaps(tooFewCandidates);
  expect('coverage: fewer than two candidates flagged', gapsOneCandidate.some((g) => g.includes('Fewer than two candidates')), 'a single candidate set should report a coverage gap about needing a comparison');

  console.log(`  coverage gaps: ${gaps.length} found on the fixture, correctly naming the unused concern and the empty case`);
}

/* ==================================================================
 * 6. Disagreement indicators.
 * ================================================================== */

{
  let state = emptyState();
  state = withCaseAdded(state);
  const caseA = state.cases[0];
  state = withPropertyAdded(state, caseA.id);
  const propA = state.cases[0].expectedProperties[0];
  state = withPropertyUpdated(state, caseA.id, propA.id, { concern: 'Accuracy' });

  const [cand1, cand2] = state.candidates;
  // Candidate 1 passes, candidate 2 fails, on the same case: a clean divergence.
  state = withManualScoreSet(state, cand1.id, caseA.id, propA.id, { passFail: 'pass' });
  state = withManualScoreSet(state, cand2.id, caseA.id, propA.id, { passFail: 'fail' });

  const divergence = computeCaseDivergence(state);
  expect('divergence found', divergence.length === 1, `expected one fully scored case with divergence, got ${divergence.length}`);
  if (divergence.length) {
    expect('divergence spread is 1', Math.abs(divergence[0].spread - 1) < 1e-9, `expected a full spread of 1 between a pass and a fail, got ${divergence[0].spread}`);
  }

  // Rubric inconsistency: the same concern passes on one case and
  // fails on another, for the same candidate.
  let incState = emptyState();
  incState = withCaseAdded(incState);
  incState = withCaseAdded(incState);
  const [caseX, caseY] = incState.cases;
  incState = withPropertyAdded(incState, caseX.id);
  incState = withPropertyAdded(incState, caseY.id);
  const propX = incState.cases[0].expectedProperties[0];
  const propY = incState.cases[1].expectedProperties[0];
  incState = withPropertyUpdated(incState, caseX.id, propX.id, { concern: 'Accuracy' });
  incState = withPropertyUpdated(incState, caseY.id, propY.id, { concern: 'Accuracy' });
  const candidateId = incState.candidates[0].id;
  incState = withManualScoreSet(incState, candidateId, caseX.id, propX.id, { passFail: 'pass' });
  incState = withManualScoreSet(incState, candidateId, caseY.id, propY.id, { passFail: 'fail' });

  const inconsistencies = computeRubricInconsistencies(incState);
  expect('rubric inconsistency detected', inconsistencies.some((i) => i.concern === 'Accuracy' && i.candidateId === candidateId), `expected an inconsistency for concern Accuracy on candidate ${candidateId}, got: ${JSON.stringify(inconsistencies)}`);

  console.log(`  disagreement: ${divergence.length} divergent case(s) found, ${inconsistencies.length} rubric inconsistency record(s) found`);
}

/* ==================================================================
 * 7. Wilson interval, kept from the design pass. Verified against
 * known and hand derived reference values.
 * ================================================================== */

const r1 = wilsonInterval(80, 100, 95);
close(r1.lower, 0.7111, 0.002, 'wilson n100x80 lower', 'n=100 x=80 95%');
close(r1.upper, 0.8668, 0.002, 'wilson n100x80 upper', 'n=100 x=80 95%');
console.log(`  n=100 x=80 95%: [${r1.lower.toFixed(4)}, ${r1.upper.toFixed(4)}], expected approx [0.7111, 0.8668]`);

const r2 = wilsonInterval(10, 20, 95);
expect('wilson n20x10 center', Math.abs(r2.center - 0.5) < 1e-9, `center should be exactly 0.5 at phat=0.5, got ${r2.center}`);
close(r2.lower, 0.2993, 0.002, 'wilson n20x10 lower', 'n=20 x=10 95%');
close(r2.upper, 0.7007, 0.002, 'wilson n20x10 upper', 'n=20 x=10 95%');
console.log(`  n=20 x=10 95%: [${r2.lower.toFixed(4)}, ${r2.upper.toFixed(4)}], expected approx [0.2993, 0.7007]`);

const r3 = wilsonInterval(45, 50, 95);
close(r3.lower, 0.7864, 0.003, 'wilson n50x45 lower', 'n=50 x=45 95%');
close(r3.upper, 0.9565, 0.003, 'wilson n50x45 upper', 'n=50 x=45 95%');
console.log(`  n=50 x=45 95%: [${r3.lower.toFixed(4)}, ${r3.upper.toFixed(4)}], expected approx [0.7864, 0.9565]`);

const zero = wilsonInterval(0, 20, 95);
expect('wilson zero successes bounded', zero.lower >= 0 && zero.upper <= 1, `bounds out of range: ${zero.lower}, ${zero.upper}`);
expect('wilson zero successes nondegenerate', zero.upper - zero.lower > 0.05, `interval too narrow at x=0: width ${zero.upper - zero.lower}`);

const all = wilsonInterval(20, 20, 95);
expect('wilson all successes bounded', all.lower >= 0 && all.upper <= 1, `bounds out of range: ${all.lower}, ${all.upper}`);
expect('wilson all successes nondegenerate', all.upper - all.lower > 0.05, `interval too narrow at x=n: width ${all.upper - all.lower}`);

const one0 = wilsonInterval(0, 1, 95);
const one1 = wilsonInterval(1, 1, 95);
expect('wilson n=1 bounded', one0.lower >= 0 && one0.upper <= 1 && one1.lower >= 0 && one1.upper <= 1, 'n=1 bounds out of range');
expect('wilson n=1 wide', one0.upper - one0.lower > 0.5 && one1.upper - one1.lower > 0.5, 'expected wide intervals at n=1');
console.log(`  edge cases: n=20 x=0 [${zero.lower.toFixed(4)}, ${zero.upper.toFixed(4)}], n=20 x=20 [${all.lower.toFixed(4)}, ${all.upper.toFixed(4)}], n=1 x=0 [${one0.lower.toFixed(4)}, ${one0.upper.toFixed(4)}]`);

let sweepChecked = 0;
for (const n of [1, 2, 3, 5, 10, 25, 50, 100, 250]) {
  for (const confidenceLevel of [90, 95, 99]) {
    for (let x = 0; x <= n; x++) {
      const result = wilsonInterval(x, n, confidenceLevel);
      expect('wilson bounds sweep', result.lower >= 0 && result.upper <= 1 && result.lower <= result.upper, `n=${n} x=${x} conf=${confidenceLevel}: [${result.lower}, ${result.upper}]`);
      sweepChecked += 1;
    }
  }
}
console.log(`  wilson bounds swept and verified across ${sweepChecked} (n, x, confidence) combinations`);

const nSeries = [10, 20, 50, 100, 200, 500, 1000];
const mdeSeries = nSeries.map((n) => minimumDetectableEffect(n, 0.9, 95, 80).delta);
let monotonic = true;
for (let i = 1; i < mdeSeries.length; i++) {
  if (mdeSeries[i] >= mdeSeries[i - 1]) monotonic = false;
}
expect('mde monotonic', monotonic, `series did not shrink monotonically: ${mdeSeries.map((d) => d.toFixed(4)).join(', ')}`);
console.log(`  mde by n at baseline 90%, 95% confidence, 80% power: ` + nSeries.map((n, i) => `n=${n} -> ${(mdeSeries[i] * 100).toFixed(1)}%`).join(', '));

const smallEval = minimumDetectableEffect(20, 0.9, 95, 80);
expect('mde honesty at n=20', smallEval.delta > 0.05, `expected the minimum detectable effect at n=20 to exceed 5 percentage points, got ${(smallEval.delta * 100).toFixed(1)}%`);
console.log(`  n=20, baseline 90%: minimum detectable effect is ${(smallEval.delta * 100).toFixed(1)} percentage points`);

// evalSetMde reads n straight from the eval set, not a hypothetical.
const sampleForMde = sampleState();
const setMde = evalSetMde(sampleForMde, 0.8);
expect('evalSetMde uses the real case count', setMde.n === sampleForMde.cases.length, `expected n=${sampleForMde.cases.length}, got ${setMde.n}`);

/* ==================================================================
 * 8. Samples. Four sets, each teaching a different lesson from the
 * PRD's acceptance criteria and outputs. Every sample first passes a
 * generic gate, then gets its own lesson specific assertion below.
 * ================================================================== */

expect('samples count', SAMPLES.length >= 4, `expected at least 4 samples, got ${SAMPLES.length}`);

for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} is missing a field`);
  const built = s.build();
  expect('sample has cases', built.cases.length > 0, `sample ${s.id} has no cases`);
  expect('sample has two or more candidates', built.candidates.length >= 2, `sample ${s.id} needs at least two candidates`);

  const issues = validate(built);
  const errorIssues = issues.filter((i) => i.severity === 'error');
  expect('sample validates without errors', errorIssues.length === 0, `sample ${s.id} failed validation: ${JSON.stringify(errorIssues)}`);

  // Exercise every analysis and export function so a broken sample
  // fails loudly here rather than silently in the browser.
  computeAllAggregates(built);
  computeCoverageGaps(built);
  computeCaseDivergence(built);
  computeRubricInconsistencies(built);
  serialize(built, 'json');
  serialize(built, 'markdown');
}
console.log(`  ${SAMPLES.length} samples load, validate, and score without error: ${SAMPLES.map((s) => s.id).join(', ')}`);

/* ------------------------------------------------------------------
 * 8a. The critical case override, the tool's headline idea.
 * ------------------------------------------------------------------ */
{
  const s = getSample('support-prompt-revision');
  expect('critical override sample exists', Boolean(s), 'expected the support-prompt-revision sample to exist');
  const built = s.build();
  expect('critical override sample has a critical case', built.cases.some((c) => c.critical), 'sample has no critical case, so the headline tension cannot show');

  const aggregates = computeAllAggregates(built);
  const criticalFailure = aggregates.find((a) => a.hasCriticalFailure);
  expect('critical override: a candidate fails on a critical case', Boolean(criticalFailure), 'no candidate has a critical failure in this sample');
  if (criticalFailure) {
    expect(
      'critical override: aggregate is high',
      criticalFailure.rawPassRate >= 0.6,
      `expected a high raw pass rate coexisting with the critical failure, got ${(criticalFailure.rawPassRate * 100).toFixed(1)} percent`,
    );
    expect(
      'critical override: verdict is fail despite the high aggregate',
      criticalFailure.verdict === 'fail',
      `raw pass rate was ${(criticalFailure.rawPassRate * 100).toFixed(1)} percent but verdict was "${criticalFailure.verdict}"`,
    );
    console.log(`  critical override: ${criticalFailure.candidateLabel} scores ${(criticalFailure.rawPassRate * 100).toFixed(1)} percent raw pass rate and still verdicts "${criticalFailure.verdict}" on the failed critical case`);
  }

  const cleanPass = aggregates.some((a) => a.verdict === 'pass');
  expect('critical override: at least one candidate passes for contrast', cleanPass, 'no candidate in this sample actually passes, so there is no contrast to show');
}

/* ------------------------------------------------------------------
 * 8b. Scaled rubric changes the winner. Same manual scores, read
 * once under pass or fail and once under the scale of one to five.
 * ------------------------------------------------------------------ */
{
  const s = getSample('incident-updates-rubric-flip');
  expect('scaled rubric sample exists', Boolean(s), 'expected the incident-updates-rubric-flip sample to exist');
  const built = s.build();

  const passFailAgg = computeAllAggregates({ ...built, scoreMode: 'pass-fail' });
  const scaleAgg = computeAllAggregates({ ...built, scoreMode: 'scale-5' });

  const passFailWinner = passFailAgg.reduce((best, a) => (a.rawPassRate > best.rawPassRate ? a : best));
  const scaleWinner = scaleAgg.reduce((best, a) => (a.rawPassRate > best.rawPassRate ? a : best));

  expect(
    'scaled rubric: winner differs between rubrics on the same data',
    passFailWinner.candidateLabel !== scaleWinner.candidateLabel,
    `expected different winners, got "${passFailWinner.candidateLabel}" under both`,
  );
  console.log(
    `  scaled rubric, pass or fail: ${passFailAgg.map((a) => `${a.candidateLabel} ${(a.rawPassRate * 100).toFixed(1)}%`).join(', ')}, winner ${passFailWinner.candidateLabel}`,
  );
  console.log(
    `  scaled rubric, scale of 1 to 5: ${scaleAgg.map((a) => `${a.candidateLabel} ${(a.rawPassRate * 100).toFixed(1)}%`).join(', ')}, winner ${scaleWinner.candidateLabel}`,
  );
}

/* ------------------------------------------------------------------
 * 8c. Disagreement behind aggregate parity. Two candidates land on
 * the same raw pass rate while diverging sharply case by case.
 * ------------------------------------------------------------------ */
{
  const s = getSample('order-extraction-disagreement');
  expect('disagreement sample exists', Boolean(s), 'expected the order-extraction-disagreement sample to exist');
  const built = s.build();

  const aggregates = computeAllAggregates(built);
  expect('disagreement sample has exactly two candidates', aggregates.length === 2, `expected 2 candidates, got ${aggregates.length}`);
  const aggregateGap = Math.abs(aggregates[0].rawPassRate - aggregates[1].rawPassRate);

  const divergence = computeCaseDivergence(built);
  const sharplyDivergentCases = divergence.filter((d) => d.spread >= 0.99).length;

  expect('disagreement: aggregate gap is small', aggregateGap < 0.05, `expected the two candidates to be near parity in aggregate, got a gap of ${(aggregateGap * 100).toFixed(1)} percentage points`);
  expect('disagreement: per case divergence is high', sharplyDivergentCases >= 2, `expected at least 2 sharply divergent cases, found ${sharplyDivergentCases}`);
  console.log(`  disagreement: aggregate gap ${(aggregateGap * 100).toFixed(1)} percentage points, ${sharplyDivergentCases} case(s) with a full spread despite that parity`);
}

/* ------------------------------------------------------------------
 * 8d. Coverage gap. A declared concern with zero exercising cases,
 * reported by the tool rather than silently dropped.
 * ------------------------------------------------------------------ */
{
  const s = getSample('meeting-followups-coverage-gap');
  expect('coverage gap sample exists', Boolean(s), 'expected the meeting-followups-coverage-gap sample to exist');
  const built = s.build();

  const usedConcerns = new Set(
    built.cases.flatMap((c) => c.expectedProperties.map((p) => p.concern.trim()).filter(Boolean)),
  );
  const unexercised = built.concerns.filter((concern) => concern.trim() && !usedConcerns.has(concern.trim()));
  expect('coverage gap: at least one declared concern is never exercised', unexercised.length >= 1, `expected an unexercised concern among ${JSON.stringify(built.concerns)}, but every declared concern has a case: ${JSON.stringify([...usedConcerns])}`);

  const gaps = computeCoverageGaps(built);
  const reported = unexercised.every((concern) => gaps.some((g) => g.includes(concern)));
  expect('coverage gap: the tool reports the unexercised concern', reported, `expected the coverage report to name ${JSON.stringify(unexercised)}, got: ${JSON.stringify(gaps)}`);
  console.log(`  coverage gap: declared concerns ${JSON.stringify(built.concerns)}, unexercised ${JSON.stringify(unexercised)}, reported: ${JSON.stringify(gaps)}`);
}

/* ==================================================================
 * 9. Reset and empty state, and basic validation.
 * ================================================================== */

expect('empty state has no cases', emptyState().cases.length === 0, 'empty state should start with no cases');
expect('reset equals empty', JSON.stringify(reset().cases) === JSON.stringify(emptyState().cases), 'reset should return the same shape as emptyState');
const emptyIssues = validate(emptyState());
expect('empty state fails validation', emptyIssues.some((i) => i.severity === 'error'), 'an empty, unnamed state produced no error');

const sampleIssues = validate(sampleState());
expect('sample validates without errors', sampleIssues.filter((i) => i.severity === 'error').length === 0, `sample should validate cleanly, got: ${JSON.stringify(sampleIssues)}`);

/* ==================================================================
 * 10. Mutation helpers behave as pure, immutable updates.
 * ================================================================== */

{
  const before = emptyState();
  const afterCase = withCaseAdded(before);
  expect('withCaseAdded does not mutate input', before.cases.length === 0, 'withCaseAdded mutated its input state');
  expect('withCaseAdded adds one case', afterCase.cases.length === 1, 'withCaseAdded did not add a case');

  const withCandidate = withCandidateAdded(afterCase);
  expect('withCandidateAdded adds one candidate', withCandidate.candidates.length === afterCase.candidates.length + 1, 'withCandidateAdded did not add a candidate');

  const caseId = afterCase.cases[0].id;
  const removed = withCaseRemoved(withCandidate, caseId);
  expect('withCaseRemoved removes the case', removed.cases.length === 0, 'withCaseRemoved did not remove the case');
}

/* ---- Report ------------------------------------------------------ */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`EVAL WORKBENCH LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('EVAL WORKBENCH LOGIC: CLEAN');
