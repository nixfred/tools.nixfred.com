/**
 * Latency Budgeter, logic gate.
 *
 * Run: bun tests/tool-latency-budgeter.mjs
 *
 * Proves the properties the PRD and the assignment both call out as
 * the point of building this tool at all:
 *   1. Composed p99 is LESS than the naive sum of stage p99s.
 *   2. The engine is reproducible: same input, same output, twice.
 *   3. A parallel branch costs the MAX of its members, not the sum.
 *   4. The dominant stage is identified correctly on a hand checkable
 *      case.
 *   5. Halving the dominant stage reduces the total by the predicted
 *      amount.
 * Plus supporting checks (retry tax, streaming TTFT, budget verdicts,
 * validation, export) that would let a broken engine slip through a
 * gate that only checked the five headline properties.
 */

import {
  analyzePipeline,
  fitLognormal,
  fitFromMoments,
  momentsFromFit,
  percentilesFromFit,
  quantileOfMax,
  createStage,
  emptyState,
  sampleState,
  reset,
  validate,
  serialize,
  SAMPLE_BASELINE_STAGES,
} from '../src/lib/tools/latency-budgeter.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

const close = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('latency-budgeter logic gate');

/* ---- 0. Lognormal fit round trips exactly for a single stage ----- */
{
  const fit = fitLognormal(200, 800);
  const moments = momentsFromFit(fit);
  const refit = fitFromMoments(moments);
  const back = percentilesFromFit(refit);
  expect('single stage round trip', close(back.p50, 200, 0.01), `p50 round tripped to ${back.p50}`);
  expect('single stage round trip', close(back.p99, 800, 0.01), `p99 round tripped to ${back.p99}`);
  console.log(`  single stage fit round trip: 200/800 -> ${back.p50.toFixed(3)}/${back.p99.toFixed(3)}`);
}

/* ---- 1. THE HEADLINE PROPERTY: composed p99 < naive sum p99 ------ */
{
  const state = sampleState();
  const result = analyzePipeline(state.baseline, state.budgetMs);
  expect(
    'composed p99 beats naive sum',
    result.totalP99 < result.naiveSumP99,
    `composed ${result.totalP99} is not less than naive sum ${result.naiveSumP99}`,
  );
  console.log(
    `  baseline: naive sum of stage p99s = ${result.naiveSumP99.toFixed(0)} ms, ` +
      `honestly composed total p99 = ${result.totalP99.toFixed(0)} ms ` +
      `(${(100 - (result.totalP99 / result.naiveSumP99) * 100).toFixed(1)} percent lower)`,
  );
}

/* ---- 2. Reproducibility: identical input, identical output ------- */
{
  const state = sampleState();
  const a = analyzePipeline(state.baseline, state.budgetMs);
  const b = analyzePipeline(state.baseline, state.budgetMs);
  expect('reproducible totalP50', a.totalP50 === b.totalP50, `${a.totalP50} !== ${b.totalP50}`);
  expect('reproducible totalP99', a.totalP99 === b.totalP99, `${a.totalP99} !== ${b.totalP99}`);
  expect('reproducible ttftP50', a.ttftP50 === b.ttftP50, `${a.ttftP50} !== ${b.ttftP50}`);
  expect('reproducible ttftP99', a.ttftP99 === b.ttftP99, `${a.ttftP99} !== ${b.ttftP99}`);
  expect('reproducible halved', a.halved.totalP50 === b.halved.totalP50, 'halved projection drifted between runs');
  expect(
    'reproducible dominant',
    a.dominantIndex === b.dominantIndex,
    `dominant index drifted: ${a.dominantIndex} vs ${b.dominantIndex}`,
  );
  console.log(`  ran the same baseline twice: totalP50 ${a.totalP50} both times, totalP99 ${a.totalP99} both times`);
}

/* ---- 3. Parallel branch costs the MAX, not the sum ---------------- */
{
  // Three near deterministic stages (p99 barely above p50, so each is
  // effectively a point mass) so the "correct" answer is hand
  // checkable: the group should cost about as much as its slowest
  // member, nowhere near the sum of all three.
  const pipeline = {
    stages: [
      makeStage('network', 100, 'series'),
      makeStage('tool-call', 300, 'parallel'),
      makeStage('post-processing', 150, 'parallel'),
    ],
  };
  const result = analyzePipeline(pipeline, 10000);
  const naiveSum = 100 + 300 + 150;
  expect('parallel group has one group', result.groups.length === 1, `expected 1 group, got ${result.groups.length}`);
  expect(
    'parallel costs the max not the sum',
    result.totalP50 < naiveSum - 100,
    `total ${result.totalP50} is too close to the naive sum ${naiveSum}`,
  );
  expect(
    'parallel group settles near its slowest member',
    close(result.totalP50, 300, 5),
    `expected the group to cost about 300 ms (its slowest member), got ${result.totalP50}`,
  );
  expect(
    'critical member is the slowest one',
    result.groups[0].criticalIndex === 1,
    `expected stage 1 (300 ms) to be critical, got ${result.groups[0].criticalIndex}`,
  );
  console.log(
    `  parallel group [100, 300, 150] ms: naive sum ${naiveSum} ms, actual group cost ${result.totalP50.toFixed(1)} ms`,
  );
}

/* ---- 4 & 5. Dominant stage identification and Amdahl halving ----- */
{
  // Fully deterministic (p99 = p50) series-only pipeline, so every
  // number below is exact arithmetic, not an approximation the test
  // has to trust the engine about.
  const pipeline = {
    stages: [
      makeStage('network', 100, 'series'),
      makeStage('model-call', 400, 'series'),
      makeStage('post-processing', 100, 'series'),
    ],
  };
  const result = analyzePipeline(pipeline, 10000);

  expect('total is the plain sum when deterministic', close(result.totalP50, 600, 0.5), `total was ${result.totalP50}`);
  expect('dominant stage is the 400ms one', result.dominantIndex === 1, `dominant index was ${result.dominantIndex}`);

  const predictedTotal = 100 + 200 + 100; // dominant stage halved from 400 to 200
  expect(
    'halved total matches hand calculation',
    close(result.halved.totalP50, predictedTotal, 0.5),
    `expected halved total near ${predictedTotal}, got ${result.halved.totalP50}`,
  );
  expect(
    'halved reduction matches hand calculation',
    close(result.halved.reductionP50, 200, 0.5),
    `expected a 200ms reduction, got ${result.halved.reductionP50}`,
  );
  expect('halving a lone series stage does not saturate', result.halved.saturated === false, 'unexpected saturation flag');
  console.log(
    `  series [100, 400, 100] ms: dominant stage index ${result.dominantIndex}, ` +
      `halved total ${result.halved.totalP50.toFixed(1)} ms (predicted ${predictedTotal}), ` +
      `reduction ${result.halved.reductionP50.toFixed(1)} ms`,
  );
}

/* ---- 6. Amdahl saturation: halving inside a parallel group can be
 *        capped by the next slowest member ------------------------- */
{
  const pipeline = {
    stages: [
      makeStage('model-call', 400, 'series'),
      makeStage('tool-call', 350, 'parallel'),
    ],
  };
  const result = analyzePipeline(pipeline, 10000);
  expect('dominant is the 400ms member', result.dominantIndex === 0, `dominant index was ${result.dominantIndex}`);
  // Halving 400 -> 200 would naively predict a 200ms drop, but the
  // 350ms sibling is now the group's bottleneck, so the group can only
  // fall to about 350, a reduction of about 50, not 200.
  expect('saturation is detected', result.halved.saturated === true, 'expected saturation when a sibling becomes the new bottleneck');
  expect(
    'saturated reduction is capped near the sibling',
    result.halved.reductionP50 < 100,
    `expected a small reduction well under the naive 200ms, got ${result.halved.reductionP50}`,
  );
  console.log(
    `  parallel [400, 350] ms: halving the 400ms member only saves ${result.halved.reductionP50.toFixed(1)} ms ` +
      `(naive prediction was ${result.halved.naivePredictedReduction.toFixed(1)} ms), saturated=${result.halved.saturated}`,
  );
}

/* ---- 7. Retry tax is visible --------------------------------------- */
{
  const state = sampleState();
  const result = analyzePipeline(state.baseline, state.budgetMs);
  const modelIndex = state.baseline.stages.findIndex((s) => s.id === 'baseline-model');
  const modelComputed = result.stages[modelIndex];
  expect(
    'retry tax inflates p99 more than p50',
    modelComputed.retryTaxP99 > modelComputed.retryTaxP50,
    `p99 tax ${modelComputed.retryTaxP99} should exceed p50 tax ${modelComputed.retryTaxP50}`,
  );
  expect('retry tax is positive', modelComputed.retryTaxP99 > 0, 'expected a nonzero retry tax on a retrying stage');
  const noRetryIndex = state.baseline.stages.findIndex((s) => s.id === 'baseline-network-in');
  expect(
    'no retry tax without retries',
    result.stages[noRetryIndex].retryTaxP99 === 0,
    'a stage with 1 attempt should show zero retry tax',
  );
  console.log(
    `  model call retry tax: p50 +${modelComputed.retryTaxP50.toFixed(1)} ms, p99 +${modelComputed.retryTaxP99.toFixed(1)} ms`,
  );
}

/* ---- 8. Streaming: time to first token is honestly less than time
 *        to last token, and the budget verdict can differ between
 *        them ---------------------------------------------------- */
{
  const state = sampleState();
  const result = analyzePipeline(state.baseline, state.budgetMs);
  expect('has streaming detected', result.hasStreaming === true, 'sample baseline has a streaming stage');
  expect('ttft p50 beats total p50', result.ttftP50 < result.totalP50, `ttft ${result.ttftP50} should be less than total ${result.totalP50}`);
  expect('ttft p99 beats total p99', result.ttftP99 < result.totalP99, `ttft ${result.ttftP99} should be less than total ${result.totalP99}`);
  expect(
    'streaming changes the budget verdict',
    result.budget.fitsTtftP50 === true && result.budget.fitsTotalP99 === false,
    `expected first token to fit the budget while the full p99 reply misses it: ttft fits=${result.budget.fitsTtftP50}, total p99 fits=${result.budget.fitsTotalP99}`,
  );
  console.log(
    `  baseline budget ${state.budgetMs} ms: total p50/p99 = ${result.totalP50.toFixed(0)}/${result.totalP99.toFixed(0)} ms, ` +
      `first token p50/p99 = ${result.ttftP50.toFixed(0)}/${result.ttftP99.toFixed(0)} ms`,
  );
}

/* ---- 9. Proposed pipeline actually improves on baseline ----------- */
{
  const state = sampleState();
  const baseline = analyzePipeline(state.baseline, state.budgetMs);
  const proposed = analyzePipeline(state.proposed, state.budgetMs);
  expect('proposed total p99 is lower', proposed.totalP99 < baseline.totalP99, `proposed ${proposed.totalP99} should beat baseline ${baseline.totalP99}`);
  expect('proposed fits the budget at p99', proposed.budget.fitsTotalP99 === true, 'the whole point of the proposed design is to fit the budget');
  console.log(
    `  baseline total p99 ${baseline.totalP99.toFixed(0)} ms vs proposed total p99 ${proposed.totalP99.toFixed(0)} ms, ` +
      `proposed fits budget at p99: ${proposed.budget.fitsTotalP99}`,
  );
}

/* ---- 10. Quantile of a single fit matches the closed form --------- */
{
  const fit = fitLognormal(500, 1500);
  const p50 = quantileOfMax([fit], 0.5);
  const p99 = quantileOfMax([fit], 0.99);
  expect('quantileOfMax single member p50', close(p50, 500, 0.01), `got ${p50}`);
  expect('quantileOfMax single member p99', close(p99, 1500, 0.01), `got ${p99}`);
}

/* ---- 11. Validation ------------------------------------------------ */
{
  expect('empty state has an error', validate(emptyState()).some((i) => i.severity === 'error'), 'an empty baseline should error');
  expect('sample state is valid', validate(sampleState()).length === 0, 'the shipped sample should never fail validation');
  expect('reset matches empty', JSON.stringify(reset()) === JSON.stringify(emptyState()), 'reset() should equal emptyState()');

  const badStage = createStage('model-call');
  badStage.p99 = badStage.p50 - 1;
  const badState = { baseline: { stages: [badStage] }, proposed: { stages: [] }, budgetMs: 2000 };
  expect(
    'p99 below p50 is rejected',
    validate(badState).some((i) => i.severity === 'error' && /p99 cannot be less than p50/.test(i.message)),
    'expected a validation error for p99 < p50',
  );
}

/* ---- 12. Export round trip ----------------------------------------- */
{
  const state = sampleState();
  const json = serialize(state, 'json');
  const parsed = JSON.parse(json);
  expect('export json has both pipelines', Array.isArray(parsed.baseline.stages) && Array.isArray(parsed.proposed.stages), 'export lost a pipeline');
  expect('export json discloses no live network test', /No live network test/i.test(parsed.note), 'export should disclose the planning-estimate boundary');
  expect('export json states the composition method', typeof parsed.compositionMethod === 'string' && parsed.compositionMethod.length > 20, 'method should be disclosed');

  const md = serialize(state, 'markdown');
  expect('export markdown has a header', md.includes('# Latency Budgeter report'), 'markdown export missing header');
  expect('export markdown discloses independence assumption', /independent/i.test(md), 'markdown export should mention the independence assumption');
  console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes`);
}

/* ---- Report --------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`LATENCY BUDGETER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('LATENCY BUDGETER LOGIC: CLEAN');

/** Small helper so the hand checkable test cases above stay readable:
 * a deterministic stage (p99 === p50) with no retries and no streaming. */
function makeStage(kind, ms, relation) {
  const stage = createStage(kind, relation);
  stage.p50 = ms;
  stage.p99 = ms;
  return stage;
}
