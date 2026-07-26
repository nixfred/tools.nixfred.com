/**
 * Model Selector logic gate.
 *
 * Run: bun tests/tool-model-selector.mjs
 *
 * Proves the PRD acceptance criteria that are properties of the engine
 * rather than of the page:
 *   1. A hard constraint eliminates a candidate, and the elimination
 *      reason names the specific constraint.
 *   2. Changing a weight changes the ranking, proven with two runs.
 *   3. Scoring is deterministic and reproducible.
 *   4. Every candidate carries a per constraint explanation, none blank.
 *   5. A workload no model satisfies returns an honest empty result.
 * Plus the supporting properties the tool depends on: the catalog
 * shape, the tradeoff sensitivity math, the samples, validation, and
 * the export round trip.
 */

import {
  CATALOG,
  SAMPLES,
  AXIS_KEYS,
  DEFAULT_WEIGHTS,
  DEFAULT_TOKEN_BLEND,
  emptyState,
  sampleState,
  reset,
  validate,
  rankCandidates,
  evaluateHardConstraints,
  computeWeightedScore,
  computeSensitivity,
  unansweredQuestions,
  evaluationPlan,
  blendedCost,
  catalogStaleness,
  serialize,
} from '../src/lib/tools/model-selector.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

console.log('model selector logic gate');

/* ---- 0. Catalog shape --------------------------------------------- */
expect('catalog size', CATALOG.length >= 5, `only ${CATALOG.length} candidates, expected at least 5`);
const seenIds = new Set();
for (const m of CATALOG) {
  expect('catalog id unique', !seenIds.has(m.id), `duplicate catalog id "${m.id}"`);
  seenIds.add(m.id);
  expect('catalog shape', Boolean(m.name && m.provider && m.priceSource && m.priceEffectiveDate), `${m.id} is missing a required field`);
  expect('catalog price', m.pricePerMillionInput > 0 && m.pricePerMillionOutput > 0, `${m.id} has a non positive price`);
}
console.log(`  catalog: ${CATALOG.length} candidates, ${seenIds.size} unique ids`);

/* ---- 1. THE IMPORTANT ONE. A hard constraint eliminates a named --- *
 * candidate, and the reason names the specific constraint.          */
{
  const state = emptyState();
  // 5,000,000 tokens exceeds every candidate's published context window
  // (the largest in the catalog is GPT 4.1 at 1,000,000), so this must
  // eliminate the entire catalog on the context check specifically.
  state.requirements.contextNeededTokens = 5_000_000;
  const result = rankCandidates(state);

  expect('hard eliminate all', result.ranked.length === 0, `expected zero survivors of a 5000000 token requirement, got ${result.ranked.length}`);
  expect('hard eliminate count', result.eliminated.length === CATALOG.length, `expected all ${CATALOG.length} candidates eliminated, got ${result.eliminated.length}`);
  for (const e of result.eliminated) {
    const namesContext = e.failedChecks.some((c) => c.key === 'context');
    expect('hard eliminate names constraint', namesContext, `${e.model.name} was eliminated but its failedChecks do not name "context": ${JSON.stringify(e.failedChecks.map((c) => c.key))}`);
    const contextCheck = e.failedChecks.find((c) => c.key === 'context');
    expect('hard eliminate reason text', contextCheck.message.includes('smaller than'), `context elimination message does not state the reason plainly: "${contextCheck.message}"`);
  }
  console.log(`  hard elimination (context): ${result.eliminated.length} of ${CATALOG.length} eliminated, each naming "context"`);
}

// A second, independent hard constraint: self hosted requirement must
// eliminate every closed weight vendor and name "hosting" as the cause.
{
  const state = emptyState();
  state.requirements.hostingRequirement = 'self-hosted';
  const result = rankCandidates(state);
  const closedWeightSurvivors = result.ranked.filter((r) => !CATALOG.find((m) => m.id === r.model.id)?.hosting.includes('self-hosted'));
  expect('hosting hard constraint', closedWeightSurvivors.length === 0, 'a candidate without self hosted availability survived a self hosted requirement');
  const eliminatedByHosting = result.eliminated.filter((e) => e.failedChecks.some((c) => c.key === 'hosting'));
  expect('hosting hard constraint names it', eliminatedByHosting.length > 0, 'expected at least one candidate eliminated specifically by the hosting constraint');
  expect('hosting hard constraint survivors', result.ranked.length > 0, 'expected the open weight candidates to survive a self hosted requirement');
  console.log(`  hard elimination (hosting): ${eliminatedByHosting.length} eliminated by hosting, ${result.ranked.length} self hostable survivors remain`);
}

/* ---- 2. Changing a weight changes the ranking, two runs ----------- */
{
  const state = sampleState('realtime-coding-copilot');
  const capabilityHeavy = rankCandidates({ ...state, weights: { capability: 90, cost: 5, latency: 3, throughput: 2 } });
  const costHeavy = rankCandidates({ ...state, weights: { capability: 2, cost: 90, latency: 5, throughput: 3 } });

  expect('weight change runs', capabilityHeavy.ranked.length > 0 && costHeavy.ranked.length > 0, 'both weight profiles must leave at least one survivor to compare');
  const topCapability = capabilityHeavy.ranked[0].model.id;
  const topCost = costHeavy.ranked[0].model.id;
  expect('weight change reranks', topCapability !== topCost, `expected a different top candidate under capability heavy weights ("${topCapability}") versus cost heavy weights ("${topCost}"), but both picked the same one`);
  console.log(`  weight change: capability heavy top pick "${topCapability}", cost heavy top pick "${topCost}"`);
}

/* ---- 3. Deterministic and reproducible ---------------------------- */
{
  const state = sampleState('support-triage-volume');
  const runA = rankCandidates(state);
  const runB = rankCandidates(state);
  const strip = (result) => ({
    ranked: result.ranked.map((r) => ({ id: r.model.id, score: r.weightedScore, axes: r.axisScores.map((a) => a.score) })),
    eliminated: result.eliminated.map((e) => e.model.id),
  });
  expect('deterministic', JSON.stringify(strip(runA)) === JSON.stringify(strip(runB)), 'two calls to rankCandidates with identical state produced different output');

  // A fresh state object with the same values must reproduce the same
  // result too, proving the determinism is a function of values, not
  // of object identity or of any hidden mutable module state.
  const state2 = sampleState('support-triage-volume');
  const runC = rankCandidates(state2);
  expect('reproducible across fresh state', JSON.stringify(strip(runA)) === JSON.stringify(strip(runC)), 'a freshly constructed but value identical state produced a different result');
  console.log(`  determinism: ${runA.ranked.length} ranked, ${runA.eliminated.length} eliminated, identical across three independent calls`);
}

/* ---- 4. Every candidate carries a per constraint explanation ------ */
{
  let hardChecksVerified = 0;
  let axisScoresVerified = 0;
  for (const sample of SAMPLES) {
    const state = sampleState(sample.id);
    const result = rankCandidates(state);
    for (const r of result.ranked) {
      for (const c of r.hardChecks) {
        expect('hard check has message', typeof c.message === 'string' && c.message.trim().length > 10, `${r.model.name}: hard check "${c.key}" has a blank or trivial message`);
        hardChecksVerified += 1;
      }
      for (const a of r.axisScores) {
        expect('axis score has why', typeof a.why === 'string' && a.why.trim().length > 10, `${r.model.name}: axis "${a.axis}" has a blank or trivial why`);
        expect('axis score in range', a.score >= 0 && a.score <= 100, `${r.model.name}: axis "${a.axis}" score ${a.score} is out of the 0 to 100 range`);
        axisScoresVerified += 1;
      }
    }
    for (const e of result.eliminated) {
      for (const c of e.hardChecks) {
        expect('hard check has message', typeof c.message === 'string' && c.message.trim().length > 10, `${e.model.name}: hard check "${c.key}" has a blank or trivial message`);
        hardChecksVerified += 1;
      }
    }
  }
  expect('coverage', hardChecksVerified > 0 && axisScoresVerified > 0, 'the sample sweep produced no checks to verify, the test is vacuous');
  console.log(`  explanations verified: ${hardChecksVerified} hard checks, ${axisScoresVerified} axis scores, all non blank`);
}

/* ---- 5. A workload no model satisfies returns an honest empty ----- *
 * result, not a least bad pick presented as a fit.                   */
{
  const state = emptyState();
  state.requirements.contextNeededTokens = 10_000_000;
  const result = rankCandidates(state);
  expect('impossible workload, empty ranked', result.ranked.length === 0, `expected zero ranked candidates for an impossible workload, got ${result.ranked.length}`);
  expect('impossible workload, all eliminated', result.eliminated.length === CATALOG.length, 'expected every candidate to appear in eliminated, none silently dropped');

  const sensitivity = computeSensitivity(result.ranked[0], result.ranked[1], DEFAULT_WEIGHTS);
  expect('impossible workload, honest tradeoff', sensitivity.possible === false, 'computeSensitivity claimed a tradeoff was possible with zero survivors');
  expect('impossible workload, tradeoff message', sensitivity.message.length > 10, 'computeSensitivity returned a blank message for the impossible case');

  const questions = unansweredQuestions(state, result);
  expect('impossible workload, questions flag it', questions.some((q) => /eliminated/i.test(q)), 'unansweredQuestions did not flag that every candidate was eliminated');

  const plan = evaluationPlan(state, result);
  expect('impossible workload, plan is honest', plan.length === 1 && /no candidate/i.test(plan[0]), `expected a single honest message when nothing survives, got: ${JSON.stringify(plan)}`);
  console.log(`  impossible workload: 0 of ${CATALOG.length} survive, tradeoff and plan both state this honestly rather than picking a least bad option`);
}

/* ---- 6. Hard constraints never read an editorial rating ----------- */
{
  const state = emptyState();
  const model = CATALOG[0];
  const before = evaluateHardConstraints(model, state.requirements, state.tokenBlend);
  const mutated = { ...model, capabilityTier: 'basic', latencyClass: 'slow', throughputTier: 'limited' };
  const after = evaluateHardConstraints(mutated, state.requirements, state.tokenBlend);
  expect('hard constraints ignore editorial fields', JSON.stringify(before) === JSON.stringify(after), 'changing capabilityTier, latencyClass, or throughputTier changed a hard constraint outcome, but only objective fields may do that');
  console.log('  hard constraints confirmed independent of capability tier, latency class, and throughput tier');
}

/* ---- 7. Sensitivity math checks out by hand ------------------------ */
{
  // Two candidates, four axes, weights chosen so the hand calculation
  // is checkable: winner ahead only on capability, runner up ahead on
  // every other axis.
  const winner = {
    model: { name: 'Winner' },
    axisScores: [
      { axis: 'capability', score: 90 },
      { axis: 'cost', score: 40 },
      { axis: 'latency', score: 50 },
      { axis: 'throughput', score: 50 },
    ],
  };
  const runnerUp = {
    model: { name: 'RunnerUp' },
    axisScores: [
      { axis: 'capability', score: 60 },
      { axis: 'cost', score: 80 },
      { axis: 'latency', score: 50 },
      { axis: 'throughput', score: 50 },
    ],
  };
  const weights = { capability: 40, cost: 10, latency: 20, throughput: 20 };
  // Current weighted scores: winner = (90*40+40*10+50*20+50*20)/90 = (3600+400+1000+1000)/90 = 6000/90 = 66.67
  // runner = (60*40+80*10+50*20+50*20)/90 = (2400+800+1000+1000)/90 = 5200/90 = 57.78
  // Winner leads. Only "cost" has runner ahead (80 vs 40). Required cost
  // weight x solving (winnerRest + 90*40) / ... reduces, per the module's
  // own derivation, to x >= (winnerRest - runnerRest) / (80-40) where
  // winnerRest/runnerRest exclude the cost axis:
  // winnerRest = 40*90 + 20*50 + 20*50 = 3600+1000+1000 = 5600
  // runnerRest = 40*60 + 20*50 + 20*50 = 2400+1000+1000 = 4400
  // required = (5600-4400)/40 = 1200/40 = 30
  const sensitivity = computeSensitivity(winner, runnerUp, weights);
  expect('sensitivity possible', sensitivity.possible === true, 'expected a flip to be possible since the runner up leads on the cost axis');
  expect('sensitivity axis', sensitivity.axis === 'cost', `expected the flip lever to be "cost", got "${sensitivity.axis}"`);
  expect('sensitivity required weight', Math.abs((sensitivity.requiredWeight ?? -1) - 30) < 0.01, `expected a required cost weight of 30, got ${sensitivity.requiredWeight}`);
  console.log(`  sensitivity: hand calculated required cost weight 30, engine returned ${sensitivity.requiredWeight}`);

  // Sanity: raising that weight to the computed threshold must actually
  // flip computeWeightedScore's own ordering.
  const flippedWeights = { ...weights, cost: sensitivity.requiredWeight };
  const winnerScore = computeWeightedScore(winner.axisScores, flippedWeights);
  const runnerScore = computeWeightedScore(runnerUp.axisScores, flippedWeights);
  expect('sensitivity flips ranking', runnerScore >= winnerScore - 1e-9, `at the computed required weight the runner up score ${runnerScore} should be at least the winner score ${winnerScore}`);
}

/* ---- 8. A dominated runner up reports no single axis flip ---------- */
{
  const winner = {
    model: { name: 'Winner' },
    axisScores: [
      { axis: 'capability', score: 90 },
      { axis: 'cost', score: 90 },
      { axis: 'latency', score: 90 },
      { axis: 'throughput', score: 90 },
    ],
  };
  const dominated = {
    model: { name: 'Dominated' },
    axisScores: [
      { axis: 'capability', score: 10 },
      { axis: 'cost', score: 10 },
      { axis: 'latency', score: 10 },
      { axis: 'throughput', score: 10 },
    ],
  };
  const sensitivity = computeSensitivity(winner, dominated, DEFAULT_WEIGHTS);
  expect('dominated cannot flip', sensitivity.possible === false, 'a runner up that trails on every axis should never report a possible flip');
}

/* ---- 9. Samples --------------------------------------------------- */
expect('samples count', SAMPLES.length >= 3, `only ${SAMPLES.length} samples, expected at least 3`);
for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} is missing a field`);
  const state = sampleState(s.id);
  const result = rankCandidates(state);
  expect('sample produces a result', result.ranked.length + result.eliminated.length === CATALOG.length, `sample ${s.id} does not account for every catalog candidate`);
}
console.log(`  samples: ${SAMPLES.length}, each produces a full accounting of the catalog`);

/* ---- 10. Validation ------------------------------------------------ */
{
  const bad = emptyState();
  bad.requirements.contextNeededTokens = 0;
  expect('validate catches bad context', validate(bad).some((i) => i.field === 'contextNeededTokens' && i.severity === 'error'), 'a zero context requirement should be a validation error');

  const goodDefault = emptyState();
  expect('validate default is clean', validate(goodDefault).every((i) => i.severity !== 'error'), 'the default empty state should carry no validation errors');

  const zeroWeights = emptyState();
  zeroWeights.weights = { capability: 0, cost: 0, latency: 0, throughput: 0 };
  expect('validate warns on zero weights', validate(zeroWeights).some((i) => i.field === 'weights' && i.severity === 'warning'), 'all weights at zero should produce a warning');

  expect('reset equals empty', JSON.stringify(reset()) === JSON.stringify(emptyState()), 'reset() should return the same shape as emptyState()');
}

/* ---- 11. Blended cost and cost axis normalization ------------------ */
{
  const model = { pricePerMillionInput: 10, pricePerMillionOutput: 20 };
  const blend = { inputShare: 0.75, outputShare: 0.25 };
  const cost = blendedCost(model, blend);
  expect('blended cost formula', Math.abs(cost - 12.5) < 1e-9, `expected 10*0.75 + 20*0.25 = 12.5, got ${cost}`);
}

/* ---- 12. Catalog staleness is a pure function of the reference date */
{
  const veryFuture = new Date('2099-01-01T00:00:00Z');
  const stale = catalogStaleness(veryFuture);
  expect('staleness grows with time', stale.staleCount === CATALOG.length, `expected every candidate to be stale by 2099, got ${stale.staleCount} of ${CATALOG.length}`);

  const atOldestExactly = new Date(`${stale.oldest.priceEffectiveDate}T00:00:00Z`);
  const freshAtSource = catalogStaleness(atOldestExactly);
  expect('staleness at source date', freshAtSource.oldestDays === 0, `evaluated at its own effective date, the oldest entry should be 0 days old, got ${freshAtSource.oldestDays}`);
}

/* ---- 13. Export round trip ----------------------------------------- */
{
  const state = sampleState('regulated-document-analysis');
  const json = serialize(state, 'json');
  const parsed = JSON.parse(json);
  expect('export json parses', Array.isArray(parsed.ranked) && Array.isArray(parsed.eliminated), 'JSON export is missing ranked or eliminated arrays');
  expect('export json discloses', /not a claim/i.test(parsed.note), 'JSON export does not disclose that this is not a claim of objective best');
  expect('export json weights', JSON.stringify(parsed.weights) === JSON.stringify(state.weights), 'JSON export lost the stated weights');

  const md = serialize(state, 'markdown');
  expect('export markdown header', md.includes('# Model Selector report'), 'markdown export missing header');
  expect('export markdown discloses', /not a claim/i.test(md), 'markdown export does not disclose that this is not a claim of objective best');
  expect('export markdown sections', md.includes('## Tradeoff') && md.includes('## Unanswered questions') && md.includes('## Recommended evaluation plan'), 'markdown export is missing a required section');
  console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both disclose the non authoritative framing`);
}

/* ---- 14. Default weight sum sanity, used across all scoring -------- */
expect('axis keys stable', AXIS_KEYS.length === 4, `expected 4 scored axes, got ${AXIS_KEYS.length}`);
expect('default weights positive', Object.values(DEFAULT_WEIGHTS).every((w) => w > 0), 'every default weight should start above zero so the ranking is meaningful out of the box');
expect('default token blend sums to one', Math.abs(DEFAULT_TOKEN_BLEND.inputShare + DEFAULT_TOKEN_BLEND.outputShare - 1) < 1e-9, 'default token blend shares must sum to 1');

/* ---- Report --------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`MODEL SELECTOR LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('MODEL SELECTOR LOGIC: CLEAN');
