/**
 * Drift Monitor, logic gate.
 *
 * Run: bun tests/tool-drift-monitor.mjs
 *
 * This tool's entire value is arithmetic, so this gate checks the
 * arithmetic, not just that the functions return something. Every
 * reference value below is either a widely published figure (the
 * Wilson interval cases) or hand derived in a comment showing the
 * work (the z test, the Fisher exact cases), then printed alongside
 * the tolerance it is checked against, exactly so a human reviewing
 * this output can re-derive it independently rather than trust the
 * assertion blindly.
 */

import {
  normalCDF,
  normalQuantile,
  wilsonInterval,
  twoProportionZTest,
  fisherExactTest,
  differenceInterval,
  minimumDetectableEffect,
  bonferroniAlpha,
  bonferroniPValue,
  analyzeDrift,
  validate,
  emptyState,
  sampleState,
  getSample,
  serialize,
  SAMPLES,
} from '../src/lib/tools/drift-monitor.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

function close(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

console.log('drift-monitor logic gate');

/* ==================================================================
   1. NORMAL DISTRIBUTION PRIMITIVES

   Everything downstream is built on these two functions, so they are
   checked first against the standard normal table values every stats
   text publishes.
   ================================================================== */
console.log('\n1. normal distribution primitives');
const z975 = normalQuantile(0.975);
console.log(`  normalQuantile(0.975) = ${z975} (published value: 1.959964)`);
expect('z 0.975', close(z975, 1.959964, 0.00001), `got ${z975}`);

const z80 = normalQuantile(0.8);
console.log(`  normalQuantile(0.8) = ${z80} (published value: 0.841621, this is z for 80 percent power)`);
expect('z power 0.8', close(z80, 0.841621, 0.00001), `got ${z80}`);

const roundTrip = normalCDF(z975);
console.log(`  normalCDF(normalQuantile(0.975)) = ${roundTrip} (must round trip to 0.975)`);
expect('cdf/quantile round trip', close(roundTrip, 0.975, 0.0001), `got ${roundTrip}`);

/* ==================================================================
   2. WILSON SCORE INTERVAL, KNOWN REFERENCE VALUES

   Reference 1 is the value stated in this tool's own build brief.
   References 2 through 4 are derived here by hand from the closed
   form Wilson formula so the arithmetic is checkable independently of
   this file's own implementation:

     center = (p + z^2/2n) / (1 + z^2/n)
     margin = z * sqrt(p(1-p)/n + z^2/4n^2) / (1 + z^2/n)

   using z = 1.959964 (the 97.5th percentile, verified above).
   ================================================================== */
console.log('\n2. Wilson score interval, known reference values');

// Reference 1: n=100, successes=80. Stated reference: approximately
// 0.7111 to 0.8668.
const w1 = wilsonInterval(80, 100, 0.95);
console.log(`  n=100 x=80: [${w1.lower.toFixed(4)}, ${w1.upper.toFixed(4)}] (reference: 0.7111 to 0.8668)`);
expect('wilson n=100 x=80 lower', close(w1.lower, 0.7111, 0.001), `got ${w1.lower}`);
expect('wilson n=100 x=80 upper', close(w1.upper, 0.8668, 0.001), `got ${w1.upper}`);

// Reference 2: n=10, successes=5 (p=0.5). By hand: z^2=3.841459,
// denom=1+3.841459/10=1.384146, center=(0.5+0.192073)/1.384146=0.5
// exactly (symmetry at p=0.5), margin=1.959964*sqrt(0.025+0.009604)/
// 1.384146 = 1.959964*0.185979/1.384146 = 0.263392. Interval:
// 0.236608 to 0.763392.
const w2 = wilsonInterval(5, 10, 0.95);
console.log(`  n=10 x=5: [${w2.lower.toFixed(4)}, ${w2.upper.toFixed(4)}] (hand derived: 0.2366 to 0.7634)`);
expect('wilson n=10 x=5 lower', close(w2.lower, 0.2366, 0.001), `got ${w2.lower}`);
expect('wilson n=10 x=5 upper', close(w2.upper, 0.7634, 0.001), `got ${w2.upper}`);

// Reference 3: n=50, successes=0 (p=0). By hand: at p=0 the formula
// collapses (margin equals center), center = (z^2/2n)/(1+z^2/n) =
// (3.841459/100)/(1+3.841459/50) = 0.038415/1.076829 = 0.035678,
// so lower=0 (clamped) and upper=2*0.035678=0.071356.
const w3 = wilsonInterval(0, 50, 0.95);
console.log(`  n=50 x=0: [${w3.lower.toFixed(4)}, ${w3.upper.toFixed(4)}] (hand derived: 0.0000 to 0.0714)`);
expect('wilson n=50 x=0 lower', w3.lower === 0, `got ${w3.lower}`);
expect('wilson n=50 x=0 upper', close(w3.upper, 0.0714, 0.001), `got ${w3.upper}`);

// Reference 4: n=50, successes=50 (p=1). Mirror image of reference 3.
const w4 = wilsonInterval(50, 50, 0.95);
console.log(`  n=50 x=50: [${w4.lower.toFixed(4)}, ${w4.upper.toFixed(4)}] (hand derived: 0.9286 to 1.0000)`);
expect('wilson n=50 x=50 lower', close(w4.lower, 0.9286, 0.001), `got ${w4.lower}`);
// Floating point, not exactly 1: the clamp is Math.min(1, computed),
// and the unclamped computation can land a sliver under 1 as well as
// over it. Either side of the boundary is correct here.
expect('wilson n=50 x=50 upper', close(w4.upper, 1, 1e-9), `got ${w4.upper}`);

/* ==================================================================
   3. TWO PROPORTION Z TEST, HAND VERIFIED TEXTBOOK CASE

   Baseline 100 of 200 (50 percent), current 120 of 200 (60 percent).
   By hand:
     pooled p = (100+120)/(200+200) = 220/400 = 0.55
     variance = 0.55 * 0.45 * (1/200 + 1/200) = 0.2475 * 0.01 = 0.002475
     SE = sqrt(0.002475) = 0.049749
     z = (0.60 - 0.50) / 0.049749 = 2.0101
     p (two sided) = 2 * (1 - Phi(2.0101)); a standard normal table
     gives Phi(2.01) approximately 0.9778, so p approximately
     2 * 0.0222 = 0.0444.
   ================================================================== */
console.log('\n3. two proportion z test, hand verified case');
const zt = twoProportionZTest({ n: 200, successes: 120 }, { n: 200, successes: 100 });
console.log(
  `  pooled p=${zt.pooledProportion}, SE=${zt.standardError.toFixed(6)}, z=${zt.z.toFixed(4)}, p=${zt.pValue.toFixed(4)}`,
);
console.log('  hand calc: pooled p=0.55, SE=0.049749, z=2.0101, p approximately 0.0444');
expect('z test pooled p', zt.pooledProportion === 0.55, `got ${zt.pooledProportion}`);
expect('z test SE', close(zt.standardError, 0.049749, 0.00001), `got ${zt.standardError}`);
expect('z test z', close(zt.z, 2.0101, 0.001), `got ${zt.z}`);
expect('z test p', close(zt.pValue, 0.0444, 0.001), `got ${zt.pValue}`);

/* ==================================================================
   4. FISHER EXACT TEST, HAND DERIVED CASES

   Case A: current 2 of 2, baseline 0 of 2. Total N=4, total
   successes K=2, draw n=2. C(4,2)=6. Table probabilities by k
   (successes landing in the "current" draw): k=0 -> C(2,0)C(2,2)/6 =
   1/6; k=1 -> C(2,1)C(2,1)/6 = 4/6; k=2 -> C(2,2)C(2,0)/6 = 1/6.
   Observed k=2, probability 1/6. Two sided p sums every table with
   probability <= 1/6: k=0 and k=2, giving 2/6 = 0.33333.

   Case B: current 3 of 4, baseline 1 of 4. Total N=8, K=4, n=4,
   C(8,4)=70. Probabilities: k=0 -> 1/70, k=1 -> 16/70, k=2 -> 36/70,
   k=3 -> 16/70, k=4 -> 1/70 (sums to 70/70, confirms the table).
   Observed k=3, probability 16/70. Two sided p sums every table with
   probability <= 16/70: k=0, 1, 3, 4, giving (1+16+16+1)/70 =
   34/70 = 0.485714.
   ================================================================== */
console.log('\n4. Fisher exact test, hand derived cases');
const fA = fisherExactTest({ n: 2, successes: 2 }, { n: 2, successes: 0 });
console.log(`  2/2 vs 0/2: p=${fA.pValue.toFixed(6)} (hand calc: 2/6 = 0.333333)`);
expect('fisher case A', close(fA.pValue, 1 / 3, 0.0001), `got ${fA.pValue}`);

const fB = fisherExactTest({ n: 4, successes: 3 }, { n: 4, successes: 1 });
console.log(`  3/4 vs 1/4: p=${fB.pValue.toFixed(6)} (hand calc: 34/70 = 0.485714)`);
expect('fisher case B', close(fB.pValue, 34 / 70, 0.0001), `got ${fB.pValue}`);

/* ==================================================================
   5. EDGE CASES THAT BREAK NAIVE CODE

   Zero successes, all successes, n=1, and both groups identical, run
   through every function in the file and through the full pipeline,
   checked for NaN, for Infinity, and for any interval bound outside
   0 to 1 (or -1 to 1 for the signed difference interval).
   ================================================================== */
console.log('\n5. edge cases: no NaN, no Infinity, no interval outside range');

function checkFinite(label, value) {
  expect(`${label} finite`, Number.isFinite(value), `got ${value}`);
}
function checkUnitInterval(label, interval, min = 0, max = 1) {
  checkFinite(`${label} lower`, interval.lower);
  checkFinite(`${label} upper`, interval.upper);
  expect(`${label} lower >= ${min}`, interval.lower >= min, `got ${interval.lower}`);
  expect(`${label} upper <= ${max}`, interval.upper <= max, `got ${interval.upper}`);
  expect(`${label} lower <= upper`, interval.lower <= interval.upper, `${interval.lower} > ${interval.upper}`);
}

const edgeSnapshots = [
  ['zero successes', { n: 50, successes: 0 }],
  ['all successes', { n: 50, successes: 50 }],
  ['n=1 zero', { n: 1, successes: 0 }],
  ['n=1 one', { n: 1, successes: 1 }],
];
for (const [label, snap] of edgeSnapshots) {
  const w = wilsonInterval(snap.successes, snap.n, 0.95);
  checkUnitInterval(`wilson ${label}`, w);
}

const edgeStates = [
  ['n=1 both groups', { n: 1, successes: 0 }, { n: 1, successes: 1 }],
  ['both zero successes', { n: 30, successes: 0 }, { n: 50, successes: 0 }],
  ['both all successes', { n: 30, successes: 30 }, { n: 50, successes: 50 }],
  ['both groups identical', { n: 5000, successes: 2500 }, { n: 5000, successes: 2500 }],
];
for (const [label, baseline, current] of edgeStates) {
  const state = {
    metricName: label,
    baseline,
    current,
    alpha: 0.05,
    metricsMonitored: 1,
    targetPower: 0.8,
    minMeaningfulEffect: 0.05,
    evalSetChanged: 'no',
  };
  const a = analyzeDrift(state);
  checkFinite(`${label}: z`, a.zTest.z);
  checkFinite(`${label}: z pValue`, a.zTest.pValue);
  checkFinite(`${label}: minimumDetectableEffect`, a.minimumDetectableEffect);
  checkUnitInterval(`${label}: baseline wilson`, a.baselineInterval);
  checkUnitInterval(`${label}: current wilson`, a.currentInterval);
  checkUnitInterval(`${label}: difference interval`, a.differenceInterval, -1, 1);
  expect(`${label}: verdict is one of the four`, ['real-change', 'noise', 'insufficient-data', 'invalid-comparison'].includes(a.verdict), `got ${a.verdict}`);
  console.log(`  ${label}: z=${a.zTest.z.toFixed(3)} diff=[${a.differenceInterval.lower.toFixed(4)},${a.differenceInterval.upper.toFixed(4)}] verdict=${a.verdict}`);
}

// "Both groups identical" specifically should read as no evidence of
// any difference: the interval on the difference must straddle zero.
const identical = analyzeDrift({
  metricName: 'identical',
  baseline: { n: 5000, successes: 2500 },
  current: { n: 5000, successes: 2500 },
  alpha: 0.05,
  metricsMonitored: 1,
  targetPower: 0.8,
  minMeaningfulEffect: 0.05,
  evalSetChanged: 'no',
});
expect('identical groups: diff is exactly zero', identical.differenceInterval.diff === 0, `got ${identical.differenceInterval.diff}`);
expect('identical groups: CI straddles zero', identical.differenceInterval.lower <= 0 && identical.differenceInterval.upper >= 0, 'CI did not straddle zero');
expect('identical groups: verdict is noise (well powered null)', identical.verdict === 'noise', `got ${identical.verdict}`);

/* ==================================================================
   6. BONFERRONI CORRECTION ACTUALLY CHANGES THE VERDICT

   400 versus 400, a move from 50 percent to 58 percent. The z test
   alone (one metric) clears the ordinary 0.05 bar. Monitoring the
   same result as 1 of 20 metrics forces a stricter bar and the
   verdict changes from what a naive read would conclude.
   ================================================================== */
console.log('\n6. Bonferroni correction changes the verdict at a known threshold');

expect('bonferroniAlpha(0.05, 20)', bonferroniAlpha(0.05, 20) === 0.0025, `got ${bonferroniAlpha(0.05, 20)}`);
expect('bonferroniPValue(0.01, 20)', close(bonferroniPValue(0.01, 20), 0.2, 1e-9), `got ${bonferroniPValue(0.01, 20)}`);
expect('bonferroniPValue clamps to 1', bonferroniPValue(0.5, 20) === 1, `got ${bonferroniPValue(0.5, 20)}`);

const baseCase = { baseline: { n: 400, successes: 200 }, current: { n: 400, successes: 232 } };
const singleMetric = analyzeDrift({
  metricName: 'single', ...baseCase, alpha: 0.05, metricsMonitored: 1,
  targetPower: 0.8, minMeaningfulEffect: 0.05, evalSetChanged: 'no',
});
const twentyMetrics = analyzeDrift({
  metricName: 'twenty', ...baseCase, alpha: 0.05, metricsMonitored: 20,
  targetPower: 0.8, minMeaningfulEffect: 0.05, evalSetChanged: 'no',
});
console.log(`  raw p=${singleMetric.zTest.pValue.toFixed(4)} (significant alone at 0.05: ${singleMetric.zTest.pValue < 0.05})`);
console.log(`  monitored as 1 of 1: verdict=${singleMetric.verdict}, CI=[${singleMetric.differenceInterval.lower.toFixed(4)},${singleMetric.differenceInterval.upper.toFixed(4)}]`);
console.log(`  monitored as 1 of 20: verdict=${twentyMetrics.verdict}, CI=[${twentyMetrics.differenceInterval.lower.toFixed(4)},${twentyMetrics.differenceInterval.upper.toFixed(4)}]`);
expect('raw p is below 0.05 on its own', singleMetric.zTest.pValue < 0.05, `got ${singleMetric.zTest.pValue}`);
expect('single metric reads as a real change', singleMetric.verdict === 'real-change', `got ${singleMetric.verdict}`);
expect('same data as 1 of 20 no longer clears the bar', twentyMetrics.verdict !== 'real-change', `got ${twentyMetrics.verdict}`);
expect('the 20 metric CI is wider than the 1 metric CI', (twentyMetrics.differenceInterval.upper - twentyMetrics.differenceInterval.lower) > (singleMetric.differenceInterval.upper - singleMetric.differenceInterval.lower), 'correction did not widen the interval');

/* ==================================================================
   7. SMALL SAMPLE INSUFFICIENT DATA VERDICT

   A comparison that could not have reliably detected the effect size
   that was said to matter must say so rather than report noise, per
   this tool's whole reason for existing.
   ================================================================== */
console.log('\n7. small sample returns insufficient data, not a confident verdict');
const smallSample = analyzeDrift({
  metricName: 'small', baseline: { n: 40, successes: 32 }, current: { n: 40, successes: 27 },
  alpha: 0.05, metricsMonitored: 1, targetPower: 0.8, minMeaningfulEffect: 0.05, evalSetChanged: 'no',
});
console.log(`  40 vs 40, raw drop ${((smallSample.baselineRate - smallSample.currentRate) * 100).toFixed(1)} points: MDE=${(smallSample.minimumDetectableEffect * 100).toFixed(1)} points, verdict=${smallSample.verdict}`);
expect('small sample: verdict is insufficient-data', smallSample.verdict === 'insufficient-data', `got ${smallSample.verdict}`);
expect('small sample: MDE exceeds the stated meaningful effect', smallSample.minimumDetectableEffect > 0.05, `got ${smallSample.minimumDetectableEffect}`);

/* ==================================================================
   8. WHICH TEST APPLIES

   The small sample above should defer to the exact test; the huge
   sample sample should trust the z test.
   ================================================================== */
console.log('\n8. which test applies, small cell counts versus large samples');
// smallSample above (40 vs 40 at 70 to 80 percent rates) still has
// every expected cell over 5, so Cochran's rule correctly keeps the z
// test primary there; a small n alone does not push a comparison into
// the exact test regime, extreme rates or very small n does. This
// case is deliberately both: n=20 per group at a 5 percent rate,
// giving an expected cell of 20*0.05=1, well under the threshold.
const smallCellSample = analyzeDrift({
  metricName: 'small cells', baseline: { n: 20, successes: 1 }, current: { n: 20, successes: 2 },
  alpha: 0.05, metricsMonitored: 1, targetPower: 0.8, minMeaningfulEffect: 0.05, evalSetChanged: 'no',
});
expect('small expected cells: fisher is primary', smallCellSample.primary.primaryTest === 'fisher', `got ${smallCellSample.primary.primaryTest}, smallest expected cell ${smallCellSample.primary.smallestExpectedCell}`);
const hugeSample = analyzeDrift(sampleState('quiet-drop-is-real'));
expect('huge sample: z is primary', hugeSample.primary.primaryTest === 'z', `got ${hugeSample.primary.primaryTest}`);
console.log(`  n=20 per group at 5 to 10 percent rates, smallest expected cell ${smallCellSample.primary.smallestExpectedCell.toFixed(2)}: primary test ${smallCellSample.primary.primaryTest}`);
console.log(`  huge sample (50000 vs 50000) primary test: ${hugeSample.primary.primaryTest}`);

/* ==================================================================
   9. EVAL SET CHANGED SHORT CIRCUITS TO invalid-comparison
   ================================================================== */
console.log('\n9. a changed eval set invalidates the comparison rather than computing a p value as if nothing happened');
const changedSet = analyzeDrift({
  metricName: 'changed', baseline: { n: 100, successes: 80 }, current: { n: 100, successes: 60 },
  alpha: 0.05, metricsMonitored: 1, targetPower: 0.8, minMeaningfulEffect: 0.05, evalSetChanged: 'yes',
});
expect('changed eval set: verdict is invalid-comparison', changedSet.verdict === 'invalid-comparison', `got ${changedSet.verdict}`);
expect('changed eval set: numbers are still computed, not hidden', Number.isFinite(changedSet.zTest.z), 'z test was not computed');

/* ==================================================================
   10. SAMPLES: shape and each one's intended verdict

   Four samples ship, tuned by running these exact functions (not by
   hand waving) to land on a specific, distinct lesson each.
   ================================================================== */
console.log('\n10. samples');
expect('at least three samples ship', SAMPLES.length >= 3, `only ${SAMPLES.length} samples`);
for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} missing a field`);
  expect('sample validates cleanly', validate(sampleState(s.id)).length === 0, `sample ${s.id} fails its own validation`);
}

const expectedVerdicts = {
  'small-sample-cant-tell': 'insufficient-data',
  'scary-drop-is-noise': 'noise',
  'quiet-drop-is-real': 'real-change',
  'twenty-metrics-one-false-alarm': 'insufficient-data',
};
for (const [id, expected] of Object.entries(expectedVerdicts)) {
  const sample = getSample(id);
  expect(`sample exists: ${id}`, Boolean(sample), `no sample with id ${id}`);
  const a = analyzeDrift(sampleState(id));
  console.log(`  ${id}: verdict=${a.verdict} (expected ${expected})`);
  expect(`sample verdict: ${id}`, a.verdict === expected, `got ${a.verdict}`);
}

/* ==================================================================
   11. EXPORT ROUND TRIP
   ================================================================== */
console.log('\n11. export round trip');
const exportState = sampleState('quiet-drop-is-real');
const json = serialize(exportState, 'json');
const parsed = JSON.parse(json);
expect('json export: input preserved', parsed.input.current.successes === exportState.current.successes, 'JSON export lost the current count');
expect('json export: analysis present', typeof parsed.analysis.verdict === 'string', 'JSON export has no verdict');
expect('json export: discloses local analysis', /No model/i.test(parsed.note), 'JSON export does not disclose that no model was involved');
const md = serialize(exportState, 'markdown');
expect('markdown export: header', md.includes('# Drift Monitor report'), 'markdown export missing header');
expect('markdown export: verdict present', md.includes('Real change'), 'markdown export missing the verdict label');
expect('markdown export: assumptions section present', md.includes('## Assumptions'), 'markdown export missing assumptions');
console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes`);

/* ==================================================================
   12. VALIDATION
   ================================================================== */
console.log('\n12. validation');
expect('empty state produces errors', validate(emptyState()).some((i) => i.severity === 'error'), 'empty state produced no error');
expect('a loaded sample validates cleanly', validate(sampleState()).length === 0, 'sample state produced validation issues');
const overCount = validate({
  metricName: '', baseline: { n: 10, successes: 20 }, current: { n: 10, successes: 5 },
  alpha: 0.05, metricsMonitored: 1, targetPower: 0.8, minMeaningfulEffect: 0.05, evalSetChanged: 'no',
});
expect('successes greater than n is an error', overCount.some((i) => i.field === 'baseline.successes'), 'out of range successes was not caught');

/* ==================================================================
   Report
   ================================================================== */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`DRIFT MONITOR LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('DRIFT MONITOR LOGIC: CLEAN');
