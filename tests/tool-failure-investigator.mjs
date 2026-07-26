/**
 * Failure Investigator, logic gate.
 *
 * Run: bun tests/tool-failure-investigator.mjs
 *
 * Proves the PRD acceptance criteria that are properties of the engine
 * rather than of the page:
 *   1. The catalog covers the required mechanisms and has no empty
 *      field anywhere in it.
 *   2. A known answer set narrows to the CORRECT mechanism ranked
 *      first, verified for well more than four distinct mechanisms.
 *   3. Every hypothesis carries evidence structure and a non empty
 *      next diagnostic, for every sample.
 *   4. Contradictory answers do not crash, and produce an honest low
 *      confidence result rather than a false certainty.
 *   5. The postmortem always includes a non empty regression test.
 *   6. Export round trips and discloses that this is local heuristic
 *      scoring, not a proven cause.
 *
 * A gate that only checked "hypotheses.length > 0" would pass on an
 * engine that ranked the wrong mechanism first every time. The whole
 * point of criterion 2 is the ordering, so every sample below is
 * checked against the specific mechanism it was written to teach.
 */

import {
  MECHANISMS,
  QUESTIONS,
  SAMPLES,
  SYMPTOM_CATEGORIES,
  diagnose,
  getMechanism,
  getSample,
  answeredCount,
  buildPostmortem,
  searchMechanisms,
  emptyState,
  sampleState,
  reset,
  validate,
  serialize,
} from '../src/lib/tools/failure-investigator.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

console.log('failure investigator logic gate');

/* ---- 1. Catalog shape and required coverage ----------------------- */
const REQUIRED_MECHANISMS = [
  'context-truncation',
  'lost-in-the-middle',
  'retrieval-miss',
  'stale-index',
  'prompt-injection',
  'instruction-conflict',
  'format-drift',
  'hallucinated-specifics',
  'refusal-overbroad-safety',
  'tokenizer-encoding',
  'nondeterminism-temperature',
  'cache-staleness',
  'tool-error-swallowed',
  'loop-repetition-collapse',
];
const catalogIds = new Set(MECHANISMS.map((m) => m.id));
for (const id of REQUIRED_MECHANISMS) {
  expect('required mechanism present', catalogIds.has(id), `catalog is missing required mechanism "${id}"`);
}
console.log(`  catalog size: ${MECHANISMS.length} mechanisms, all ${REQUIRED_MECHANISMS.length} PRD required ones present`);

const NON_EMPTY_FIELDS = [
  'id',
  'name',
  'category',
  'presentsAs',
  'underlyingReason',
  'howToConfirm',
  'containmentAction',
  'durableFix',
  'suggestedRegressionTest',
];
for (const m of MECHANISMS) {
  for (const field of NON_EMPTY_FIELDS) {
    const value = m[field];
    expect(
      'catalog field non empty',
      typeof value === 'string' && value.trim().length > 0,
      `mechanism "${m.id}" has an empty or missing field "${field}"`,
    );
  }
  expect('catalog has signals', Array.isArray(m.signals) && m.signals.length > 0, `mechanism "${m.id}" has no scoring signals`);
  for (const cue of m.signals) {
    expect(
      'signal shape',
      typeof cue.evidence === 'string' && cue.evidence.trim().length > 0,
      `mechanism "${m.id}" has a signal with no evidence text`,
    );
  }
}
console.log('  every catalog entry has all required fields non empty, and at least one scoring signal');

// Duplicate ids would silently break getMechanism and the UI.
const idCounts = new Map();
for (const m of MECHANISMS) idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
for (const [id, count] of idCounts) {
  expect('unique mechanism id', count === 1, `mechanism id "${id}" appears ${count} times`);
}

/* ---- 2. THE IMPORTANT ONE. Samples must rank their target mechanism
 *         first, across well more than four distinct mechanisms. ---- */
const EXPECTED_TOP = {
  'long-session-forgets-rule': 'context-truncation',
  'support-bot-old-price': 'stale-index',
  'scraper-agent-off-task': 'prompt-injection',
  'invoice-json-breaks-long': 'format-drift',
  'chatbot-repeats-apology': 'loop-repetition-collapse',
  'calendar-tool-silent-timeout': 'tool-error-swallowed',
  'flat-nine-second-replies': 'serial-dependency-latency',
  'nightly-job-bill-spike': 'unbounded-output-cost',
  'fabricated-court-citation': 'hallucinated-specifics',
  'benign-request-refused': 'refusal-overbroad-safety',
};

expect('sample coverage', SAMPLES.length >= 6, `only ${SAMPLES.length} samples`);
expect(
  'expected top mapping covers every sample',
  Object.keys(EXPECTED_TOP).length === SAMPLES.length,
  'EXPECTED_TOP is out of sync with SAMPLES',
);

const distinctTargets = new Set(Object.values(EXPECTED_TOP));
expect('distinct mechanisms verified', distinctTargets.size >= 4, `only ${distinctTargets.size} distinct mechanisms verified, need at least 4`);

for (const sample of SAMPLES) {
  const expectedId = EXPECTED_TOP[sample.id];
  expect('sample has expectation', Boolean(expectedId), `sample "${sample.id}" has no entry in EXPECTED_TOP`);
  if (!expectedId) continue;

  const ranked = diagnose(sample.answers);
  const top = ranked[0];
  expect(
    'sample ranks correct mechanism first',
    top.mechanismId === expectedId,
    `sample "${sample.id}" (${sample.name}) ranked "${top.mechanismId}" (score ${top.score}) first, expected "${expectedId}". Top 3: ${ranked
      .slice(0, 3)
      .map((h) => `${h.mechanismId}=${h.score}`)
      .join(', ')}`,
  );
  expect(
    'top hypothesis has margin over runner up',
    ranked[0].score > ranked[1].score,
    `sample "${sample.id}" has a tie for first place: ${ranked[0].mechanismId}=${ranked[0].score} vs ${ranked[1].mechanismId}=${ranked[1].score}`,
  );
}
console.log(
  `  samples verified: ${SAMPLES.length}, distinct target mechanisms confirmed ranked first: ${distinctTargets.size}`,
);
console.log(`  distinct mechanisms: ${[...distinctTargets].join(', ')}`);

/* ---- 3. Every hypothesis, for every sample, carries real structure  */
let hypothesesChecked = 0;
for (const sample of SAMPLES) {
  const ranked = diagnose(sample.answers);
  expect('full ranking returned', ranked.length === MECHANISMS.length, `sample "${sample.id}" returned ${ranked.length} hypotheses, expected ${MECHANISMS.length}`);
  for (const h of ranked) {
    expect('hypothesis has next diagnostic', typeof h.nextDiagnostic === 'string' && h.nextDiagnostic.trim().length > 0, `hypothesis "${h.mechanismId}" has no next diagnostic`);
    expect('hypothesis has containment action', typeof h.containmentAction === 'string' && h.containmentAction.trim().length > 0, `hypothesis "${h.mechanismId}" has no containment action`);
    expect('hypothesis confidence is valid', ['low', 'moderate', 'high'].includes(h.confidence), `hypothesis "${h.mechanismId}" has invalid confidence "${h.confidence}"`);
    expect('evidence lists exist', Array.isArray(h.evidenceFor) && Array.isArray(h.evidenceAgainst), `hypothesis "${h.mechanismId}" is missing an evidence array`);
    hypothesesChecked += 1;
  }
}
console.log(`  hypotheses checked across all samples: ${hypothesesChecked}`);

/* ---- 4. Contradictory and empty answers do not crash, and are honest */
// Deliberately contradictory: "always reproduces" argues against sampling
// variance, "passes at temperature 0" argues for it. Both cues fire.
const contradictory = { reproducible: 'always', temperatureZero: 'passes' };
const contradictoryRanked = diagnose(contradictory);
expect('contradictory input does not crash', contradictoryRanked.length === MECHANISMS.length, 'diagnose threw or dropped mechanisms on contradictory input');
const nondeterminism = contradictoryRanked.find((h) => h.mechanismId === 'nondeterminism-temperature');
expect('contradiction produces a net wash', nondeterminism.score <= 0, `expected sampling nondeterminism score <= 0 on contradictory evidence, got ${nondeterminism.score}`);
expect('contradiction surfaces evidence against', nondeterminism.evidenceAgainst.length > 0, 'contradictory evidence produced no evidenceAgainst entries');
expect('contradiction surfaces evidence for', nondeterminism.evidenceFor.length > 0, 'contradictory evidence produced no evidenceFor entries');
expect('contradiction is not overconfident', nondeterminism.confidence === 'low', `expected low confidence on a self contradicting mechanism, got "${nondeterminism.confidence}"`);
console.log(`  contradictory answers: sampling nondeterminism scored ${nondeterminism.score}, confidence ${nondeterminism.confidence}, evidence both ways present`);

// Completely empty answers must also be handled without crashing, and
// nothing may claim moderate or high confidence from zero evidence.
const emptyRanked = diagnose({});
expect('empty answers do not crash', emptyRanked.length === MECHANISMS.length, 'diagnose threw or dropped mechanisms on empty input');
expect('empty answers produce zero score for everything', emptyRanked.every((h) => h.score === 0), 'a mechanism scored nonzero with zero answers supplied');
expect('empty answers are all low confidence', emptyRanked.every((h) => h.confidence === 'low'), 'a mechanism claimed above low confidence with zero evidence');
console.log(`  empty answers: all ${emptyRanked.length} mechanisms present, all scored 0, all confidence low`);

expect('answeredCount empty', answeredCount({}) === 0, 'answeredCount({}) should be 0');
expect('answeredCount counts only present answers', answeredCount({ reproducible: 'always', temperatureZero: undefined }) === 1, 'answeredCount miscounted a partial answers object');

/* ---- 5. Postmortem always includes a regression test --------------- */
for (const sample of SAMPLES) {
  const state = sampleState(sample.id);
  const postmortem = buildPostmortem(state);
  expect(
    'postmortem has regression test',
    typeof postmortem.regressionTest === 'string' && postmortem.regressionTest.trim().length > 20,
    `postmortem for "${sample.id}" has no substantive regression test`,
  );
  expect('postmortem names a mechanism', postmortem.mechanism.length > 0, `postmortem for "${sample.id}" has no mechanism name`);
  expect(
    'postmortem mechanism matches expectation',
    getMechanism(EXPECTED_TOP[sample.id]).name === postmortem.mechanism,
    `postmortem for "${sample.id}" selected "${postmortem.mechanism}", expected "${getMechanism(EXPECTED_TOP[sample.id]).name}"`,
  );
}
console.log(`  postmortems built for all ${SAMPLES.length} samples, every one carries a substantive regression test`);

// A user selected mechanism, different from the top ranked one, must
// be honored rather than silently overridden.
{
  const state = sampleState('support-bot-old-price');
  const ranked = diagnose(state.answers);
  const alternate = ranked.find((h) => h.mechanismId !== state.selectedMechanismId);
  state.selectedMechanismId = alternate.mechanismId;
  const postmortem = buildPostmortem(state);
  expect('postmortem honors explicit selection', postmortem.mechanism === alternate.name, 'buildPostmortem ignored an explicit selectedMechanismId');
}

/* ---- 6. Questions and symptom categories ---------------------------*/
expect('questions exist', QUESTIONS.length >= 5, `only ${QUESTIONS.length} discriminating questions`);
for (const q of QUESTIONS) {
  expect('question has options', q.options.length >= 2, `question "${q.id}" has fewer than two options`);
  expect('question has hint', typeof q.hint === 'string' && q.hint.length > 0, `question "${q.id}" has no hint`);
}
expect('symptom categories cover PRD list', SYMPTOM_CATEGORIES.length === 7, `expected 7 symptom categories, got ${SYMPTOM_CATEGORIES.length}`);
for (const required of ['hallucination', 'retrieval', 'permission', 'tool', 'latency', 'loop', 'cost']) {
  expect('symptom category present', SYMPTOM_CATEGORIES.includes(required), `symptom category "${required}" is missing`);
}

/* ---- 7. Catalog search ---------------------------------------------*/
const cacheResults = searchMechanisms('cache', 'all');
expect('search finds cache staleness', cacheResults.some((m) => m.id === 'cache-staleness'), 'searching "cache" did not find cache-staleness');
const retrievalOnly = searchMechanisms('', 'retrieval');
expect('category filter narrows results', retrievalOnly.every((m) => m.category === 'retrieval'), 'category filter "retrieval" returned a non retrieval mechanism');
expect('category filter is non empty', retrievalOnly.length >= 2, 'expected at least two retrieval category mechanisms');
const nothingMatches = searchMechanisms('zzzznomatch', 'all');
expect('search can return nothing', nothingMatches.length === 0, 'a nonsense query unexpectedly matched a mechanism');

/* ---- 8. Tool module contract: empty, sample, reset, validate ------- */
const blank = emptyState();
expect('empty state has no answers', answeredCount(blank.answers) === 0, 'emptyState() started with answers already filled in');
expect('empty state fails validation', validate(blank).some((i) => i.severity === 'error'), 'an empty state produced no error');

for (const sample of SAMPLES) {
  const state = sampleState(sample.id);
  expect('sample state matches source', state.description === sample.description, `sampleState("${sample.id}") lost the description`);
  const issues = validate(state);
  expect('loaded sample has no error', !issues.some((i) => i.severity === 'error'), `sampleState("${sample.id}") failed validation: ${JSON.stringify(issues)}`);
}

const reloaded = reset();
expect('reset matches empty state', JSON.stringify(reloaded) === JSON.stringify(emptyState()), 'reset() does not match emptyState()');

/* ---- 9. Export round trip -------------------------------------------*/
const exportState = sampleState('scraper-agent-off-task');
const json = serialize(exportState, 'json');
const parsed = JSON.parse(json);
expect('export json keeps description', parsed.description === exportState.description, 'JSON export lost the description');
expect('export json has hypotheses', Array.isArray(parsed.hypotheses) && parsed.hypotheses.length === MECHANISMS.length, 'JSON export has an incomplete hypotheses array');
expect('export json discloses heuristic scoring', /ranked set of hypotheses, not a proven root cause/i.test(parsed.note), 'JSON export does not disclose that this is not a proven cause');
expect('export json has postmortem', Boolean(parsed.postmortem && parsed.postmortem.regressionTest), 'JSON export is missing a postmortem with a regression test');

const md = serialize(exportState, 'markdown');
expect('export markdown has header', md.includes('# Failure Investigator postmortem'), 'markdown export missing header');
expect('export markdown discloses heuristic scoring', /not a proven root cause/i.test(md), 'markdown export does not disclose the heuristic nature of the result');
expect('export markdown includes regression test section', md.includes('## Regression test'), 'markdown export missing the regression test section');
console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both disclose local heuristic scoring`);

/* ---- Report ----------------------------------------------------------*/
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`FAILURE INVESTIGATOR LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('FAILURE INVESTIGATOR LOGIC: CLEAN');
