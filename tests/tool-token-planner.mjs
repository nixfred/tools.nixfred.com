/**
 * TOKEN PLANNER ARITHMETIC GATE.
 *
 * tools-nixfred-prds/tools/02-TOKEN-PLANNER.md, acceptance criterion:
 * "Currency rounding does not corrupt underlying calculations. Keep
 * full precision internally, round only at render."
 *
 * Run: bun tests/tool-token-planner.mjs
 *
 * Three things are proved here, each a named section below:
 *   1. A long chain of multiplications does not drift when rounding
 *      is deferred to render time, contrasted against a naive
 *      per request rounding approach that would zero the total out.
 *   2. Cache hit rate and retry rate interact multiplicatively and
 *      independently: turning on a cache discount does not change
 *      how the retry multiplier is applied, and vice versa.
 *   3. Zero requests is a valid input, not a crash. Every period
 *      total is exactly zero, nothing is NaN, and per request cost
 *      is still computed since it does not depend on request count.
 *
 * This gate imports src/lib/tools/token-planner.ts directly, the same
 * way tests/check-registry.mjs imports src/data files, so it fails on
 * a broken formula even when the Astro build is green.
 */

import {
  calculateScenario,
  compareScenarios,
  getThresholdWarnings,
  validate,
  emptyState,
} from '../src/lib/tools/token-planner.ts';

const failures = [];
function fail(label, detail) {
  failures.push(`VIOLATION [${label}]: ${detail}`);
}
function expect(label, condition, detail) {
  if (!condition) fail(label, detail);
}
function close(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon;
}

function baseScenario(overrides = {}) {
  const empty = emptyState().scenarioA;
  return { ...empty, ...overrides };
}

/* ==================================================================
   1. ROUNDING CHAIN
   ================================================================== */

{
  const inputs = baseScenario({
    profileId: 'custom',
    inputPerMillion: 1,
    outputPerMillion: 0,
    cachedInputPerMillion: 0,
    systemPromptTokens: 1,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    requestsPerPeriod: 1_000_000,
    retryRatePercent: 0,
    cacheHitRatePercent: 0,
  });

  const result = calculateScenario(inputs, 'day');

  // One token at $1 per million is $0.000001 per request. At two
  // decimal places that is indistinguishable from zero, which is
  // exactly the trap this criterion guards against.
  expect(
    'rounding chain, per request magnitude',
    close(result.costPerRequest, 0.000001, 1e-12),
    `costPerRequest was ${result.costPerRequest}, expected 0.000001`,
  );

  // One million such requests in a day is one dollar. If the
  // calculation had rounded the per request cost before multiplying
  // by volume, this would come out as zero instead.
  expect(
    'rounding chain, full precision total',
    close(result.dailyCost, 1, 1e-6),
    `dailyCost was ${result.dailyCost}, expected approximately 1`,
  );

  // The naive comparison: round to cents PER REQUEST first, exactly
  // the shortcut this codebase must not take, then multiply by
  // volume. That naive path loses the entire dollar.
  const naiveCostPerRequest = Math.round(result.costPerRequest * 100) / 100;
  const naiveDailyCost = naiveCostPerRequest * inputs.requestsPerPeriod;

  expect(
    'rounding chain, naive path demonstrates the drift',
    naiveCostPerRequest === 0 && naiveDailyCost === 0,
    `expected the naive per request rounded approach to collapse to zero, got per request ${naiveCostPerRequest} and total ${naiveDailyCost}`,
  );

  expect(
    'rounding chain, full precision beats the naive path',
    Math.abs(result.dailyCost - naiveDailyCost) > 0.9,
    `full precision dailyCost (${result.dailyCost}) should differ from the naive total (${naiveDailyCost}) by close to a dollar`,
  );

  console.log(
    `rounding chain: 1,000,000 requests at $${result.costPerRequest} each ` +
      `totals $${result.dailyCost.toFixed(6)} per day (full precision), ` +
      `versus $${naiveDailyCost.toFixed(6)} if rounded per request first`,
  );
}

/* ==================================================================
   2. CACHE AND RETRY INTERACTION
   ================================================================== */

{
  const cached = baseScenario({
    profileId: 'custom',
    inputPerMillion: 10,
    outputPerMillion: 0,
    cachedInputPerMillion: 1, // ten percent of the input price, the published cache discount shape
    systemPromptTokens: 1000,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    requestsPerPeriod: 100,
    retryRatePercent: 50,
    cacheHitRatePercent: 100,
  });
  const uncached = { ...cached, cacheHitRatePercent: 0 };

  const resultCached = calculateScenario(cached, 'day');
  const resultUncached = calculateScenario(uncached, 'day');

  expect(
    'cache and retry, retry factor applied',
    close(resultCached.executionsPerRequest, 1.5, 1e-12),
    `executionsPerRequest was ${resultCached.executionsPerRequest}, expected 1.5`,
  );
  expect(
    'cache and retry, executions per request is cache independent',
    resultCached.executionsPerRequest === resultUncached.executionsPerRequest,
    'the retry multiplier must not change when the cache hit rate changes',
  );

  expect(
    'cache and retry, cached cost per request',
    close(resultCached.costPerRequest, 0.0015, 1e-12),
    `cached costPerRequest was ${resultCached.costPerRequest}, expected 0.0015`,
  );
  expect(
    'cache and retry, uncached cost per request',
    close(resultUncached.costPerRequest, 0.015, 1e-12),
    `uncached costPerRequest was ${resultUncached.costPerRequest}, expected 0.015`,
  );

  // The cache discount is a flat ten to one ratio in this fixture. If
  // retries were applied before the cache split, or the cache split
  // leaked into the retry multiplier, this ratio would drift away
  // from exactly 10.
  const ratio = resultUncached.costPerRequest / resultCached.costPerRequest;
  expect(
    'cache and retry, the two effects stay independent',
    close(ratio, 10, 1e-9),
    `uncached to cached cost ratio was ${ratio}, expected exactly 10 regardless of the shared 1.5x retry multiplier`,
  );

  expect(
    'cache and retry, daily cost matches cost per request times volume',
    close(resultCached.dailyCost, 0.15, 1e-9),
    `cached dailyCost was ${resultCached.dailyCost}, expected 0.15`,
  );

  console.log(
    `cache and retry interaction: retry multiplier ${resultCached.executionsPerRequest}x is identical ` +
      `cached and uncached, cache discount ratio holds at ${ratio.toFixed(6)}x`,
  );
}

/* ==================================================================
   3. ZERO REQUEST EDGE CASE
   ================================================================== */

{
  const inputs = baseScenario({
    profileId: 'custom',
    inputPerMillion: 5,
    outputPerMillion: 25,
    cachedInputPerMillion: 0.5,
    systemPromptTokens: 1200,
    avgInputTokens: 400,
    avgOutputTokens: 600,
    requestsPerPeriod: 0,
    retryRatePercent: 10,
    cacheHitRatePercent: 50,
  });

  for (const period of ['day', 'week', 'month', 'year']) {
    const result = calculateScenario(inputs, period);

    expect(
      `zero requests, ${period}: cost per request is still real`,
      Number.isFinite(result.costPerRequest) && result.costPerRequest > 0,
      `costPerRequest was ${result.costPerRequest}, expected a positive finite number`,
    );
    expect(
      `zero requests, ${period}: requestsPerDay is zero, not NaN`,
      result.requestsPerDay === 0,
      `requestsPerDay was ${result.requestsPerDay}`,
    );

    for (const field of ['dailyCost', 'monthlyCost', 'annualCost', 'dailyTokens', 'monthlyTokens', 'annualTokens']) {
      expect(
        `zero requests, ${period}: ${field} is exactly zero`,
        result[field] === 0,
        `${field} was ${result[field]}`,
      );
    }

    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'number') {
        expect(`zero requests, ${period}: ${key} is not NaN`, !Number.isNaN(value), `${key} was NaN`);
      }
    }
  }

  const zeroState = {
    period: 'day',
    compareEnabled: false,
    scenarioA: inputs,
    scenarioB: baseScenario(),
  };
  const issues = validate(zeroState);
  expect(
    'zero requests: validate() accepts zero as a legitimate value',
    issues.length === 0,
    `expected no validation issues for a zero request volume, got ${JSON.stringify(issues)}`,
  );

  const resultA = calculateScenario(zeroState.scenarioA, zeroState.period);
  const warnings = getThresholdWarnings(zeroState, resultA, null);
  expect(
    'zero requests: getThresholdWarnings flags it without throwing',
    warnings.some((w) => w.key === 'zero-requests'),
    `expected a zero-requests warning, got keys ${warnings.map((w) => w.key).join(', ')}`,
  );

  console.log(
    `zero request edge case: costPerRequest stayed real across day, week, month, and year ` +
      `while every period total landed on exactly zero, no NaN anywhere`,
  );
}

/* ==================================================================
   4. SCENARIO COMPARISON SANITY, not part of the rounding criterion
   but cheap to prove alongside it since compareScenarios() is the
   other place two full precision numbers meet.
   ================================================================== */

{
  const a = calculateScenario(
    baseScenario({ profileId: 'custom', inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5, systemPromptTokens: 1200, avgInputTokens: 400, avgOutputTokens: 600, requestsPerPeriod: 5000 }),
    'day',
  );
  const b = calculateScenario(
    baseScenario({ profileId: 'custom', inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.1, systemPromptTokens: 1200, avgInputTokens: 400, avgOutputTokens: 600, requestsPerPeriod: 5000 }),
    'day',
  );
  const comparison = compareScenarios(a, b);
  expect(
    'scenario comparison: cheaper scenario identified correctly',
    comparison.cheaper === 'B',
    `expected scenario B (cheaper per token prices) to be cheaper, got ${comparison.cheaper}`,
  );
  expect(
    'scenario comparison: delta sign matches direction',
    comparison.monthlyCostDelta < 0,
    `expected a negative monthly cost delta for a cheaper scenario B, got ${comparison.monthlyCostDelta}`,
  );
}

/* ---- report ------------------------------------------------------ */

if (failures.length) {
  console.log(`TOKEN PLANNER ARITHMETIC: FAILED (${failures.length})`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('TOKEN PLANNER ARITHMETIC: CLEAN');
