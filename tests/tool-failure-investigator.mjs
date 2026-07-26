/**
 * Failure Investigator, logic gate.
 *
 * Run: bun tests/tool-failure-investigator.mjs
 *
 * Proves the PRD acceptance criteria that are properties of the engine
 * rather than of the page:
 *   1. The catalog covers the required mechanisms, all seven required
 *      symptom categories are represented, and every field is non
 *      empty, including a permission class incident narrowing to a
 *      permission category mechanism.
 *   2. A known answer set narrows to the CORRECT mechanism ranked
 *      first, verified for well more than four distinct mechanisms.
 *   3. STRONG FORM: no hypothesis can ever be produced with an empty
 *      evidence array, asserted across every mechanism and every
 *      signal in the catalog, not just the samples.
 *   4. Every destructive containment proposal is phrased as a proposal,
 *      marked destructive, and carries a substantive reversibility
 *      statement. Non destructive ones still carry one.
 *   5. Contradictory answers do not crash, and produce an honest low
 *      confidence result rather than a false certainty.
 *   6. The postmortem, and the exported report in both formats, always
 *      include a non empty regression test.
 *
 * A gate that only checked "hypotheses.length > 0" would pass on an
 * engine that ranked the wrong mechanism first every time, or that
 * rendered a hypothesis with nothing behind it. Every sample below is
 * checked against the specific mechanism it was written to teach, and
 * every mechanism's every signal is checked in isolation for criterion 3.
 */

import {
  MECHANISMS,
  QUESTIONS,
  SAMPLES,
  SYMPTOM_CATEGORIES,
  MECHANISM_CATEGORIES,
  diagnose,
  visibleHypotheses,
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

/* ---- 1. Catalog shape, required coverage, and category coverage ---- */
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

// PRD acceptance criterion 1, verbatim: "Supports hallucination,
// retrieval, permission, tool, latency, loop, and cost incidents."
// Every one of those seven must have a real mechanism behind it, not
// just a label in SYMPTOM_CATEGORIES with nothing backing it.
expect('symptom categories cover PRD list', SYMPTOM_CATEGORIES.length === 7, `expected 7 symptom categories, got ${SYMPTOM_CATEGORIES.length}`);
for (const required of ['hallucination', 'retrieval', 'permission', 'tool', 'latency', 'loop', 'cost']) {
  expect('symptom category present', SYMPTOM_CATEGORIES.includes(required), `symptom category "${required}" is missing`);
  const covering = MECHANISMS.filter((m) => m.category === required);
  expect(
    'symptom category has a backing mechanism',
    covering.length >= 1,
    `symptom category "${required}" has no mechanism in the catalog tagged with that category`,
  );
}
const permissionMechanisms = MECHANISMS.filter((m) => m.category === 'permission');
console.log(
  `  permission category mechanisms: ${permissionMechanisms.map((m) => m.id).join(', ')} (${permissionMechanisms.length} total)`,
);
expect(
  'permission covered by more than one mechanism',
  permissionMechanisms.length >= 2,
  'permission incidents (denied access, excess authority, injected authority) collapse to a single mechanism',
);

const NON_EMPTY_TEXT_FIELDS = ['id', 'name', 'category', 'presentsAs', 'underlyingReason', 'howToConfirm', 'durableFix', 'suggestedRegressionTest'];
for (const m of MECHANISMS) {
  for (const field of NON_EMPTY_TEXT_FIELDS) {
    const value = m[field];
    expect(
      'catalog field non empty',
      typeof value === 'string' && value.trim().length > 0,
      `mechanism "${m.id}" has an empty or missing field "${field}"`,
    );
  }
  expect('catalog category is valid', MECHANISM_CATEGORIES.includes(m.category), `mechanism "${m.id}" has an unknown category "${m.category}"`);
  expect('catalog has signals', Array.isArray(m.signals) && m.signals.length > 0, `mechanism "${m.id}" has no scoring signals`);
  for (const cue of m.signals) {
    expect(
      'signal shape',
      typeof cue.evidence === 'string' && cue.evidence.trim().length > 0,
      `mechanism "${m.id}" has a signal with no evidence text`,
    );
  }

  // Containment: 4. Every proposal is phrased as a proposal, marked
  // destructive or not, and carries a substantive reversibility
  // statement regardless. A destructive one is held to a higher bar,
  // since a thin reversibility statement next to a destructive action
  // is close to no statement at all.
  const c = m.containment;
  expect('containment exists', Boolean(c) && typeof c === 'object', `mechanism "${m.id}" has no containment object`);
  expect('containment proposal non empty', typeof c?.proposal === 'string' && c.proposal.trim().length > 0, `mechanism "${m.id}" containment has no proposal text`);
  expect(
    'containment reads as a proposal, not a command',
    /^consider\b/i.test(c?.proposal ?? ''),
    `mechanism "${m.id}" containment proposal does not read as a proposal: "${c?.proposal}"`,
  );
  expect('containment destructive is boolean', typeof c?.destructive === 'boolean', `mechanism "${m.id}" containment.destructive is not a boolean`);
  expect('containment reversibility non empty', typeof c?.reversibility === 'string' && c.reversibility.trim().length > 0, `mechanism "${m.id}" containment has no reversibility statement`);
  if (c?.destructive) {
    expect(
      'destructive containment has a substantive reversibility statement',
      c.reversibility.trim().length > 40,
      `mechanism "${m.id}" is marked destructive but its reversibility statement is too thin: "${c.reversibility}"`,
    );
  }
}
const destructiveMechanisms = MECHANISMS.filter((m) => m.containment.destructive);
console.log(
  `  containment proposals: ${MECHANISMS.length} total, ${destructiveMechanisms.length} marked destructive (${destructiveMechanisms.map((m) => m.id).join(', ')}), every one carries a reversibility statement`,
);
expect('at least one destructive containment exists to actually test the safety property', destructiveMechanisms.length >= 1, 'no mechanism is marked destructive, so the destructive path is untested');

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
  'agent-writes-outside-scope': 'excess-agency',
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

// A permission incident, specifically, narrows to a permission
// category mechanism. Two independent samples prove it two ways: one
// via injected authority, one via denied access.
for (const sampleId of ['scraper-agent-off-task', 'benign-request-refused', 'agent-writes-outside-scope']) {
  const sample = getSample(sampleId);
  const top = diagnose(sample.answers)[0];
  const mechanism = getMechanism(top.mechanismId);
  expect('sample symptom category is permission', sample.symptomCategory === 'permission', `sample "${sampleId}" is not tagged as a permission incident`);
  expect(
    'permission incident narrows to a permission mechanism',
    mechanism.category === 'permission',
    `sample "${sampleId}" (permission incident) narrowed to "${top.mechanismId}", category "${mechanism.category}", expected category "permission"`,
  );
}
console.log('  permission incidents (injection, refusal, excess agency) each narrow to a permission category mechanism');

/* ---- 3. STRONG FORM: no hypothesis ever appears with empty evidence,
 *         checked structurally, and checked for every signal in the
 *         entire catalog, not merely for the ten sample scenarios. --- */
expect('visibleHypotheses of empty answers is empty', visibleHypotheses({}).length === 0, 'visibleHypotheses({}) produced a hypothesis with zero evidence behind it');

let visibleChecked = 0;
for (const sample of SAMPLES) {
  const visible = visibleHypotheses(sample.answers);
  expect('sample produces at least one visible hypothesis', visible.length > 0, `sample "${sample.id}" produced no visible hypotheses at all`);
  for (const h of visible) {
    expect(
      'visible hypothesis carries evidence',
      h.evidenceFor.length > 0 || h.evidenceAgainst.length > 0,
      `sample "${sample.id}": hypothesis "${h.mechanismId}" appears in visibleHypotheses with an empty evidence array both ways`,
    );
    visibleChecked += 1;
  }
}
console.log(`  visible hypotheses checked across all samples: ${visibleChecked}, none with empty evidence both ways`);

// The exhaustive check: for every mechanism, for every single signal
// it defines, answering ONLY the question that signal names must make
// that mechanism appear in visibleHypotheses with non empty evidence
// on the correct side. This is what "asserted across every mechanism
// in the catalog" means literally, not just for the ten narratives.
let signalsChecked = 0;
for (const mechanism of MECHANISMS) {
  for (const cue of mechanism.signals) {
    const answers = { [cue.questionId]: cue.answer };
    const visible = visibleHypotheses(answers);
    const hit = visible.find((h) => h.mechanismId === mechanism.id);
    expect(
      'single signal produces a visible, evidenced hypothesis',
      Boolean(hit),
      `mechanism "${mechanism.id}" did not appear in visibleHypotheses when answering only {${cue.questionId}: "${cue.answer}"}`,
    );
    if (hit) {
      const evidenceList = cue.weight >= 0 ? hit.evidenceFor : hit.evidenceAgainst;
      expect(
        'single signal evidence lands on the correct side',
        evidenceList.length > 0,
        `mechanism "${mechanism.id}", signal {${cue.questionId}: "${cue.answer}"} (weight ${cue.weight}) did not produce evidence on the expected side`,
      );
    }
    signalsChecked += 1;
  }
}
console.log(`  individual signals checked in isolation across the full catalog: ${signalsChecked}, every one surfaces a visible, evidenced hypothesis`);

/* ---- 4. Every hypothesis, for every sample, carries real structure  */
let hypothesesChecked = 0;
for (const sample of SAMPLES) {
  const ranked = diagnose(sample.answers);
  expect('full ranking returned', ranked.length === MECHANISMS.length, `sample "${sample.id}" returned ${ranked.length} hypotheses, expected ${MECHANISMS.length}`);
  for (const h of ranked) {
    expect('hypothesis has next diagnostic', typeof h.nextDiagnostic === 'string' && h.nextDiagnostic.trim().length > 0, `hypothesis "${h.mechanismId}" has no next diagnostic`);
    expect('hypothesis has containment proposal', typeof h.containment?.proposal === 'string' && h.containment.proposal.trim().length > 0, `hypothesis "${h.mechanismId}" has no containment proposal`);
    expect('hypothesis has containment reversibility', typeof h.containment?.reversibility === 'string' && h.containment.reversibility.trim().length > 0, `hypothesis "${h.mechanismId}" has no reversibility statement`);
    expect('hypothesis confidence is valid', ['low', 'moderate', 'high'].includes(h.confidence), `hypothesis "${h.mechanismId}" has invalid confidence "${h.confidence}"`);
    expect('evidence lists exist', Array.isArray(h.evidenceFor) && Array.isArray(h.evidenceAgainst), `hypothesis "${h.mechanismId}" is missing an evidence array`);
    hypothesesChecked += 1;
  }
}
console.log(`  hypotheses checked across all samples: ${hypothesesChecked}`);

/* ---- 5. Contradictory and empty answers do not crash, and are honest */
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
console.log(`  empty answers: all ${emptyRanked.length} mechanisms present in diagnose(), all scored 0, all confidence low, visibleHypotheses({}) is empty`);

expect('answeredCount empty', answeredCount({}) === 0, 'answeredCount({}) should be 0');
expect('answeredCount counts only present answers', answeredCount({ reproducible: 'always', temperatureZero: undefined }) === 1, 'answeredCount miscounted a partial answers object');

/* ---- 6. Postmortem and export always include a regression test ---- */
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
  expect('postmortem carries a containment proposal', Boolean(postmortem.containment?.proposal), `postmortem for "${sample.id}" has no containment proposal`);
}
console.log(`  postmortems built for all ${SAMPLES.length} samples, every one carries a substantive regression test and a containment proposal`);

// A postmortem built from zero evidence must still be honest and still
// carry a regression test, never crash, never silently invent evidence.
{
  const blankPostmortem = buildPostmortem(emptyState());
  expect(
    'postmortem on zero evidence is labeled honestly',
    /not yet determined/i.test(blankPostmortem.mechanism),
    `postmortem on an empty state should say it has not been determined, got "${blankPostmortem.mechanism}"`,
  );
  expect('postmortem on zero evidence still has a regression test', blankPostmortem.regressionTest.trim().length > 20, 'postmortem on empty state has no regression test');
  expect('postmortem on zero evidence has empty evidence lists', blankPostmortem.evidenceFor.length === 0 && blankPostmortem.evidenceAgainst.length === 0, 'postmortem on empty state fabricated evidence that was never gathered');
}

// A user selected mechanism, different from the top ranked one, must
// be honored rather than silently overridden.
{
  const state = sampleState('support-bot-old-price');
  const visible = visibleHypotheses(state.answers);
  const alternate = visible.find((h) => h.mechanismId !== state.selectedMechanismId);
  state.selectedMechanismId = alternate.mechanismId;
  const postmortem = buildPostmortem(state);
  expect('postmortem honors explicit selection', postmortem.mechanism === alternate.name, 'buildPostmortem ignored an explicit selectedMechanismId');
}

/* ---- 7. Questions -----------------------------------------------------*/
expect('questions exist', QUESTIONS.length >= 5, `only ${QUESTIONS.length} discriminating questions`);
for (const q of QUESTIONS) {
  expect('question has options', q.options.length >= 2, `question "${q.id}" has fewer than two options`);
  expect('question has hint', typeof q.hint === 'string' && q.hint.length > 0, `question "${q.id}" has no hint`);
}

/* ---- 8. Catalog search ---------------------------------------------*/
const cacheResults = searchMechanisms('cache', 'all');
expect('search finds cache staleness', cacheResults.some((m) => m.id === 'cache-staleness'), 'searching "cache" did not find cache-staleness');
const retrievalOnly = searchMechanisms('', 'retrieval');
expect('category filter narrows results', retrievalOnly.every((m) => m.category === 'retrieval'), 'category filter "retrieval" returned a non retrieval mechanism');
expect('category filter is non empty', retrievalOnly.length >= 2, 'expected at least two retrieval category mechanisms');
const permissionOnly = searchMechanisms('', 'permission');
expect('permission category filter matches catalog count', permissionOnly.length === permissionMechanisms.length, 'category filter "permission" is out of sync with the catalog');
const nothingMatches = searchMechanisms('zzzznomatch', 'all');
expect('search can return nothing', nothingMatches.length === 0, 'a nonsense query unexpectedly matched a mechanism');

/* ---- 9. Tool module contract: empty, sample, reset, validate ------- */
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

/* ---- 10. Export round trip, including the safety and evidence
 *          properties surviving into the exported document --------- */
const exportState = sampleState('scraper-agent-off-task');
const json = serialize(exportState, 'json');
const parsed = JSON.parse(json);
expect('export json keeps description', parsed.description === exportState.description, 'JSON export lost the description');
expect('export json has hypotheses', Array.isArray(parsed.hypotheses) && parsed.hypotheses.length > 0, 'JSON export has an empty hypotheses array');
expect(
  'export json hypotheses all carry evidence',
  parsed.hypotheses.every((h) => h.evidenceFor.length > 0 || h.evidenceAgainst.length > 0),
  'JSON export included a hypothesis with no evidence either way',
);
expect('export json discloses heuristic scoring', /ranked set of hypotheses, not a proven root cause/i.test(parsed.note), 'JSON export does not disclose that this is not a proven cause');
expect('export json discloses propose only never perform', /never executes one/i.test(parsed.note), 'JSON export does not disclose that containment steps are proposals, never executions');
expect('export json has postmortem with regression test', Boolean(parsed.postmortem && parsed.postmortem.regressionTest && parsed.postmortem.regressionTest.length > 20), 'JSON export is missing a postmortem with a substantive regression test');
expect('export json postmortem has containment', Boolean(parsed.postmortem?.containment?.proposal), 'JSON export postmortem is missing a containment proposal');

const md = serialize(exportState, 'markdown');
expect('export markdown has header', md.includes('# Failure Investigator postmortem'), 'markdown export missing header');
expect('export markdown discloses heuristic scoring', /not a proven root cause/i.test(md), 'markdown export does not disclose the heuristic nature of the result');
expect('export markdown states propose never perform', /never performs them/i.test(md), 'markdown export does not state that this tool proposes and never performs');
expect('export markdown includes regression test section', md.includes('## Regression test'), 'markdown export missing the regression test section');
expect('export markdown includes containment section', md.includes('## Containment proposal'), 'markdown export missing the containment proposal section');
console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both disclose local heuristic scoring and propose-never-perform`);

// A destructive sample's export must show the destructive marker and a
// reversibility statement, not just the bare proposal text.
{
  const destructiveState = sampleState('agent-writes-outside-scope');
  const destructiveMd = serialize(destructiveState, 'markdown');
  expect('export marks a destructive containment as destructive', /DESTRUCTIVE, proposal only/i.test(destructiveMd), 'markdown export of a destructive containment sample does not mark it destructive');
  expect('export includes reversibility text for a destructive step', /Reversibility:/i.test(destructiveMd), 'markdown export of a destructive containment sample has no reversibility statement');
}

/* ---- Report ------------------------------------------------------ */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`FAILURE INVESTIGATOR LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('FAILURE INVESTIGATOR LOGIC: CLEAN');
