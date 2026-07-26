/**
 * Signal Tester, logic gate.
 *
 * Run: bun tests/tool-signal-tester.mjs
 *
 * Proves the PRD acceptance criteria that are properties of the engine
 * rather than of the page:
 *   1. Cohen's kappa matches a standard worked example, hand derived
 *      below, plus perfect agreement, chance level agreement, and the
 *      degenerate single category case.
 *   2. Pearson correlation matches a hand derived dataset, plus perfect
 *      positive, perfect negative, exact zero, and the degenerate zero
 *      variance case.
 *   3. The gameability catalog has no empty field.
 *   4. A confirmed known failure mode is never dropped from "does not
 *      support", and the word "valid" never appears anywhere the tool
 *      generates, because this tool must never certify a proxy.
 *   5. At least three samples ship, each with a real shape.
 *   6. Export round trips.
 */

import {
  cohensKappa,
  pearsonCorrelation,
  interpretKappa,
  interpretCorrelation,
  parsePairedRows,
  parseNumericPairs,
  buildPairedRaw,
  detectGameabilityMatches,
  computeStatistics,
  analyzeSignal,
  validate,
  serialize,
  emptyState,
  sampleState,
  GAMEABILITY_CATALOG,
  SAMPLES,
} from '../src/lib/tools/signal-tester.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

function close(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

console.log('signal-tester logic gate');

/* ---- 1. Cohen's kappa, the standard worked example ---------------
 *
 * HAND DERIVATION. Two raters over a 2x2 table:
 *
 *              rater 2 yes   rater 2 no    row total
 *  rater 1 yes      a=20         b=5           25
 *  rater 1 no        c=10        d=15          25
 *  col total          30          20            N=50
 *
 * po (observed agreement)  = (a + d) / N = (20 + 15) / 50 = 0.70
 * pe (chance agreement)    = (row1*col1 + row2*col2) / N^2
 *                          = (25*30 + 25*20) / 2500
 *                          = (750 + 500) / 2500 = 1250 / 2500 = 0.50
 * kappa = (po - pe) / (1 - pe) = (0.70 - 0.50) / (1 - 0.50)
 *       = 0.20 / 0.50 = 0.40
 *
 * This is the textbook example (it also appears on Wikipedia's Cohen's
 * kappa article), used because it is independently checkable by hand
 * rather than trusted because this file says so.
 * ------------------------------------------------------------------- */
{
  const pairs = [
    ...Array(20).fill({ proxy: 'yes', outcome: 'yes' }),
    ...Array(5).fill({ proxy: 'yes', outcome: 'no' }),
    ...Array(10).fill({ proxy: 'no', outcome: 'yes' }),
    ...Array(15).fill({ proxy: 'no', outcome: 'no' }),
  ];
  const result = cohensKappa(pairs);
  expect('kappa worked example: po', close(result.observedAgreement, 0.7), `got ${result.observedAgreement}`);
  expect('kappa worked example: pe', close(result.chanceAgreement, 0.5), `got ${result.chanceAgreement}`);
  expect('kappa worked example: kappa', close(result.kappa, 0.4), `got ${result.kappa}`);
  expect('kappa worked example: interpretation says fair', /fair/i.test(interpretKappa(result)), interpretKappa(result));
  console.log(`  kappa worked example: po=${result.observedAgreement}, pe=${result.chanceAgreement}, kappa=${result.kappa}`);
}

/* ---- 1b. Perfect agreement gives 1.0 ------------------------------
 * a=10 (X,X), d=15 (Y,Y), no off diagonal.
 * po = 1. row totals 10/15, col totals 10/15.
 * pe = (10/25)^2 + (15/25)^2 = 0.16 + 0.36 = 0.52
 * kappa = (1 - 0.52) / (1 - 0.52) = 1
 * ------------------------------------------------------------------- */
{
  const pairs = [
    ...Array(10).fill({ proxy: 'X', outcome: 'X' }),
    ...Array(15).fill({ proxy: 'Y', outcome: 'Y' }),
  ];
  const result = cohensKappa(pairs);
  expect('kappa perfect agreement', close(result.kappa, 1), `got ${result.kappa}`);
  expect('kappa perfect agreement not flagged degenerate', result.degenerate === false, 'a real 2 category perfect agreement should not be the degenerate single category case');
  console.log(`  kappa perfect agreement: ${result.kappa}`);
}

/* ---- 1c. Chance level agreement gives approximately 0 -------------
 * Independent distribution: rows split 30/70, columns split 40/60,
 * cell counts are exactly the row*col/N product, so observed agreement
 * equals what chance predicts.
 * a=12 (30*40/100), b=18 (30*60/100), c=28 (70*40/100), d=42 (70*60/100)
 * po = (12+42)/100 = 0.54, pe = (30*40+70*60)/10000 = 5400/10000 = 0.54
 * kappa = (0.54-0.54)/(1-0.54) = 0
 * ------------------------------------------------------------------- */
{
  const pairs = [
    ...Array(12).fill({ proxy: 'yes', outcome: 'yes' }),
    ...Array(18).fill({ proxy: 'yes', outcome: 'no' }),
    ...Array(28).fill({ proxy: 'no', outcome: 'yes' }),
    ...Array(42).fill({ proxy: 'no', outcome: 'no' }),
  ];
  const result = cohensKappa(pairs);
  expect('kappa chance level', close(result.kappa, 0), `got ${result.kappa}, expected approximately 0`);
  console.log(`  kappa chance level (independent 30/70 x 40/60 table): ${result.kappa}`);
}

/* ---- 1d. Degenerate: every rating identical, must not be NaN ------
 * All 30 pairs are (yes, yes). pe = 1, so 1 - pe = 0, the denominator
 * that breaks a naive implementation. This one must report 1, not NaN,
 * and its interpretation must say the agreement is trivial.
 * ------------------------------------------------------------------- */
{
  const pairs = Array(30).fill({ proxy: 'yes', outcome: 'yes' });
  const result = cohensKappa(pairs);
  expect('kappa degenerate: not NaN', Number.isFinite(result.kappa), `got ${result.kappa}`);
  expect('kappa degenerate: flagged', result.degenerate === true, 'single category case must set degenerate');
  expect('kappa degenerate: value', result.kappa === 1, `got ${result.kappa}`);
  expect(
    'kappa degenerate: interpretation explains it',
    /degenerate/i.test(interpretKappa(result)) && /no disagreement|variation/i.test(interpretKappa(result)),
    interpretKappa(result),
  );
  console.log(`  kappa degenerate (all identical): kappa=${result.kappa}, ${interpretKappa(result)}`);
}
{
  // Zero pairs must also be handled without throwing or producing NaN.
  const result = cohensKappa([]);
  expect('kappa empty input', Number.isFinite(result.kappa), `got ${result.kappa}`);
}

/* ---- 2. Pearson correlation, hand derived dataset -----------------
 *
 * x = [1, 2, 3, 4, 5], y = [2, 3, 5, 4, 6]
 * mean x = 3, mean y = 4
 * dx = [-2, -1, 0, 1, 2], dy = [-2, -1, 1, 0, 2]
 * sum(dx*dy) = 4 + 1 + 0 + 0 + 4 = 9
 * sum(dx^2)  = 4 + 1 + 0 + 1 + 4 = 10
 * sum(dy^2)  = 4 + 1 + 1 + 0 + 4 = 10
 * r = 9 / sqrt(10 * 10) = 9 / 10 = 0.9
 * ------------------------------------------------------------------- */
{
  const pairs = [1, 2, 3, 4, 5].map((x, i) => ({ x, y: [2, 3, 5, 4, 6][i] }));
  const result = pearsonCorrelation(pairs);
  expect('correlation hand derived', close(result.r, 0.9), `got ${result.r}`);
  console.log(`  correlation hand derived dataset: r=${result.r}`);
}

/* ---- 2b. Perfect positive, perfect negative, exact zero ----------- */
{
  const perfectPos = pearsonCorrelation([1, 2, 3, 4, 5].map((x) => ({ x, y: 2 * x })));
  expect('correlation perfect positive', close(perfectPos.r, 1), `got ${perfectPos.r}`);

  const perfectNeg = pearsonCorrelation([1, 2, 3, 4, 5].map((x) => ({ x, y: -3 * x + 1 })));
  expect('correlation perfect negative', close(perfectNeg.r, -1), `got ${perfectNeg.r}`);

  // x = [1,2,3,4], y = [2,1,1,2]: mean y = 1.5, dy = [0.5,-0.5,-0.5,0.5]
  // dx = [-1.5,-0.5,0.5,1.5]; sum dx*dy = -0.75+0.25-0.25+0.75 = 0 -> r = 0
  const zero = pearsonCorrelation([1, 2, 3, 4].map((x, i) => ({ x, y: [2, 1, 1, 2][i] })));
  expect('correlation exact zero', close(zero.r, 0), `got ${zero.r}`);
  console.log(`  correlation: perfect positive=${perfectPos.r}, perfect negative=${perfectNeg.r}, exact zero=${zero.r}`);
}

/* ---- 2c. Degenerate: zero variance must not be NaN ---------------- */
{
  const constantY = pearsonCorrelation([1, 2, 3, 4].map((x) => ({ x, y: 7 })));
  expect('correlation degenerate: r is null not NaN', constantY.r === null, `got ${constantY.r}`);
  expect('correlation degenerate: flagged', constantY.degenerate === true, 'zero variance must set degenerate');
  expect(
    'correlation degenerate: interpretation explains it',
    /undefined|never varied/i.test(interpretCorrelation(constantY)),
    interpretCorrelation(constantY),
  );
  const empty = pearsonCorrelation([]);
  expect('correlation empty input', empty.r === null, `got ${empty.r}`);
  console.log(`  correlation degenerate (constant y): ${interpretCorrelation(constantY)}`);
}

/* ---- 3. Gameability catalog has no empty field -------------------- */
{
  expect('catalog size', GAMEABILITY_CATALOG.length >= 6, `only ${GAMEABILITY_CATALOG.length} entries, expected at least the six named in the brief`);
  const requiredFields = ['id', 'label', 'proxy', 'outcome', 'gameMove', 'whyItFails', 'detectPattern'];
  for (const entry of GAMEABILITY_CATALOG) {
    for (const field of requiredFields) {
      expect('catalog field', typeof entry[field] === 'string' && entry[field].trim().length > 0, `${entry.id || '(no id)'} has an empty ${field}`);
    }
    // Every detectPattern must actually compile as a regular expression.
    expect('catalog pattern compiles', (() => {
      try {
        new RegExp(entry.detectPattern, 'i');
        return true;
      } catch {
        return false;
      }
    })(), `${entry.id}: detectPattern does not compile`);
  }
  const names = ['response-length', 'thumbs-up-rate', 'exact-match', 'latency', 'refusal-rate', 'test-pass-rate'];
  for (const name of names) {
    expect('catalog names the required entry', GAMEABILITY_CATALOG.some((e) => e.id === name), `catalog is missing "${name}"`);
  }
  console.log(`  catalog: ${GAMEABILITY_CATALOG.length} entries, all fields populated, all six required patterns present`);
}

/* ---- 3b. Detection actually fires on wording that names the pattern */
{
  const detected = detectGameabilityMatches('The proxy is the user thumbs up rate.', 'Outcome is factual correctness.');
  expect('detection fires', detected.includes('thumbs-up-rate'), `got ${JSON.stringify(detected)}`);
  const none = detectGameabilityMatches('', '');
  expect('detection empty input', none.length === 0, `got ${JSON.stringify(none)}`);
}

/* ---- 4. Honesty: never certifies a proxy as valid ----------------- *
 * This is the operational form of "never certify a proxy as valid":
 * the word must not appear anywhere the engine generates text, across
 * every shipped sample and a hand built worst and best case.
 * ------------------------------------------------------------------- */
{
  const neverContainsValid = (state, label) => {
    const analysis = analyzeSignal(state);
    const haystack = [
      analysis.assessment.headline,
      ...analysis.assessment.supports,
      ...analysis.assessment.doesNotSupport,
      ...analysis.assessment.casesToAdd,
    ].join(' ');
    expect('never certifies valid', !/\bvalid\b/i.test(haystack), `${label}: generated text contains the word "valid": ${haystack}`);
    const json = serialize(state, 'json');
    const md = serialize(state, 'markdown');
    expect('export never certifies valid (json)', !/"[^"]*\bvalid\b[^"]*"/i.test(JSON.stringify(JSON.parse(json).analysis)), `${label}: json export analysis contains "valid"`);
  };

  for (const sample of SAMPLES) neverContainsValid(sample.state, sample.id);
  neverContainsValid(emptyState(), 'empty state');

  // A documented failure mode must survive into doesNotSupport even
  // when the paired statistics look very strong.
  const strongButGameable = {
    outcome: 'the extracted field is semantically correct',
    proxy: 'the extracted field matches the reference string exactly',
    proxyKind: 'categorical',
    proxySucceedsOutcomeFails: '',
    outcomeHoldsProxyFails: '',
    selectedFailureModes: ['exact-match'],
    customFailureMode: '',
    // Shared label set, "yes" meaning the proxy or outcome read
    // positive, so the diagonal of the confusion matrix is meaningful.
    pairedDataRaw: buildPairedRaw([
      ['yes', 'yes', 95],
      ['no', 'no', 5],
    ]),
  };
  const analysis = analyzeSignal(strongButGameable);
  const stats = analysis.statistics;
  expect('strong stats sanity', stats.kind === 'categorical' && stats.kappa.kappa > 0.9, `expected a very high kappa, got ${JSON.stringify(stats)}`);
  expect(
    'documented failure mode survives strong agreement',
    analysis.assessment.doesNotSupport.some((s) => /exact match/i.test(s)),
    `doesNotSupport did not mention the confirmed failure mode even with kappa ${stats.kind === 'categorical' ? stats.kappa.kappa : 'n/a'}: ${JSON.stringify(analysis.assessment.doesNotSupport)}`,
  );
  expect(
    'headline does not go quiet on strong agreement',
    /do not treat/i.test(analysis.assessment.headline),
    analysis.assessment.headline,
  );
  console.log(`  strong-but-gameable case: kappa=${stats.kind === 'categorical' ? stats.kappa.kappa.toFixed(3) : 'n/a'}, headline still: "${analysis.assessment.headline}"`);
}

/* ---- 5. Samples ---------------------------------------------------- */
{
  expect('samples count', SAMPLES.length >= 3, `only ${SAMPLES.length} samples`);
  for (const s of SAMPLES) {
    expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} missing a field`);
    expect('sample outcome', Boolean(s.state.outcome.trim()), `sample ${s.id} has no outcome`);
    expect('sample proxy', Boolean(s.state.proxy.trim()), `sample ${s.id} has no proxy`);
    expect('sample validates clean on required fields', validate(s.state).every((i) => i.severity !== 'error'), `sample ${s.id} fails required-field validation`);
  }
  console.log(`  samples: ${SAMPLES.length}`);
}

/* ---- 5b. The shipped kappa worked example reproduces through the whole path */
{
  const state = sampleState('thumbs-up-fact-check');
  const stats = computeStatistics(state);
  expect('sample reproduces worked example', stats.kind === 'categorical' && close(stats.kappa.kappa, 0.4), `got ${JSON.stringify(stats)}`);
  console.log(`  sample "thumbs-up-fact-check" reproduces kappa=${stats.kind === 'categorical' ? stats.kappa.kappa : 'n/a'} through parsePairedRows + cohensKappa`);
}

/* ---- 6. Paired data parsing ---------------------------------------- */
{
  const { rows, skipped } = parsePairedRows('yes, correct\n# a comment\n\nno, incorrect\nmalformed line\nup , down ');
  expect('parse rows', rows.length === 3, `got ${rows.length} rows`);
  expect('parse skip malformed', skipped === 1, `got ${skipped} skipped`);
  expect('parse trims values', rows[2].proxyValue === 'up' && rows[2].outcomeValue === 'down', JSON.stringify(rows[2]));

  const numeric = parseNumericPairs([
    { proxyValue: '10', outcomeValue: '20' },
    { proxyValue: 'not a number', outcomeValue: '5' },
    { proxyValue: '3', outcomeValue: '4' },
  ]);
  expect('numeric parse keeps valid rows', numeric.pairs.length === 2, `got ${numeric.pairs.length}`);
  expect('numeric parse skips bad rows', numeric.skipped === 1, `got ${numeric.skipped}`);
}

/* ---- 7. Validation -------------------------------------------------- */
{
  expect('validate empty has errors', validate(emptyState()).some((i) => i.severity === 'error'), 'empty state produced no error');
  expect('validate sample is clean', validate(sampleState()).length === 0, 'a loaded sample produced validation issues');
}

/* ---- 8. Export round trip ------------------------------------------- */
{
  const state = sampleState('thumbs-up-fact-check');
  const json = serialize(state, 'json');
  const parsed = JSON.parse(json);
  expect('export json state', parsed.state.proxy === state.proxy, 'json export lost the proxy text');
  expect('export json note discloses local analysis', /no model was scored|no fact was checked/i.test(parsed.note), parsed.note);
  expect('export json kappa present', parsed.analysis.statistics.kind === 'categorical', JSON.stringify(parsed.analysis.statistics.kind));

  const md = serialize(state, 'markdown');
  expect('export markdown header', md.includes('# Signal Tester report'), 'missing header');
  expect('export markdown discloses local analysis', /no model was scored/i.test(md), 'markdown export does not disclose local analysis');
  expect('export markdown has kappa', /Cohen's kappa/i.test(md), 'markdown export omits the kappa line');
  console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both disclose local analysis`);
}

/* ---- Report ---------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`SIGNAL TESTER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('SIGNAL TESTER LOGIC: CLEAN');
