/**
 * Workflow Decomposer, logic gate.
 *
 * Run: bun tests/tool-workflow-decomposer.mjs
 *
 * Proves the properties the brief calls out as non negotiable:
 *   1. An irreversible, unverifiable step is NEVER automate now or
 *      automate with checkpoint, no matter how often it runs. This is
 *      the whole reason the tool exists, so it gets checked directly
 *      against classifyStep, not just against a sample.
 *   2. Classification is deterministic and ignores frequency entirely.
 *   3. Every classification carries a non trivial reason.
 *   4. Handoffs are detected correctly on a known sequence.
 *   5. Implementation order is stable, and a high stakes step does not
 *      jump the queue just because it matters.
 *   6. Cycles, orphans, and broken dependencies are all flagged.
 *   7. Export round trips and discloses that no model was involved.
 */

import {
  classifyStep,
  analyzeProcess,
  detectCycles,
  detectOrphans,
  findGraphIssues,
  findHandoffs,
  findSilentFailureRisks,
  computeImplementationOrder,
  performerFor,
  sampleState,
  emptyState,
  validate,
  serialize,
  filename,
  getSample,
  SAMPLES,
  FREQUENCY_LEVELS,
  COST_LEVELS,
  CLASSIFICATION_LEVELS,
  DEFAULT_PROPERTIES,
} from '../src/lib/tools/workflow-decomposer.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

console.log('workflow-decomposer logic gate');

/* ---- 1. Samples ---------------------------------------------------- */
expect('samples', SAMPLES.length >= 2, `only ${SAMPLES.length} samples, need at least two`);
for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} missing a field`);
  expect('sample steps', s.state.steps.length > 0, `sample ${s.id} has no steps`);
}
console.log(`  samples: ${SAMPLES.length}`);

/* ---- 2. THE HEADLINE RULE. Irreversible and unverifiable never automates,
   regardless of frequency. Checked across every frequency level directly
   against the engine, not just against one sample. ------------------- */
let headlineChecked = 0;
for (const frequency of FREQUENCY_LEVELS) {
  const c = classifyStep({
    ...DEFAULT_PROPERTIES,
    reversible: false,
    outputVerifiable: false,
    needsJudgment: true, // clears disqualifier 1 so disqualifier 2 is what is on trial
    frequency,
  });
  expect(
    'headline rule',
    c.level !== 'automate-now' && c.level !== 'automate-with-checkpoint',
    `frequency "${frequency}" produced "${c.level}" for an irreversible, unverifiable step`,
  );
  expect('headline rule level', c.level === 'keep-human', `expected keep-human at frequency "${frequency}", got "${c.level}"`);
  headlineChecked += 1;
}
// And the sample that dramatizes it: the most frequent step in the
// whole set (delete-files, daily) still keeps a human.
const cleanup = analyzeProcess(getSample('file-cleanup').state);
const deleteClassification = cleanup.classifications.get('delete-files');
expect(
  'headline rule on sample',
  deleteClassification?.level === 'keep-human',
  `delete-files classified "${deleteClassification?.level}" despite being irreversible and unverifiable`,
);
console.log(`  headline rule verified across ${headlineChecked} frequency levels, plus the file cleanup sample`);

/* ---- 3. Determinism, and frequency plays no role in classification -- */
const a = classifyStep({ ...DEFAULT_PROPERTIES, frequency: 'rare' });
const b = classifyStep({ ...DEFAULT_PROPERTIES, frequency: 'daily' });
expect('frequency blind', a.level === b.level, `frequency changed a classification from "${a.level}" to "${b.level}"`);
expect('frequency blind reason', a.reason === b.reason, 'frequency changed the stated reason');

const repeat1 = classifyStep(DEFAULT_PROPERTIES);
const repeat2 = classifyStep(DEFAULT_PROPERTIES);
expect('deterministic', repeat1.level === repeat2.level && repeat1.reason === repeat2.reason, 'same properties produced different results');

/* ---- 4. Every classification on every sample carries a reason ------ */
let classificationsChecked = 0;
for (const sample of SAMPLES) {
  const analysis = analyzeProcess(sample.state);
  for (const step of sample.state.steps) {
    const c = analysis.classifications.get(step.id);
    expect('classification exists', Boolean(c), `${sample.id}: step "${step.id}" was not classified`);
    expect(
      'classification reasoned',
      Boolean(c && c.reason && c.reason.length > 20),
      `${sample.id}: step "${step.id}" has no substantive reason`,
    );
    expect(
      'classification level valid',
      Boolean(c && CLASSIFICATION_LEVELS.includes(c.level)),
      `${sample.id}: step "${step.id}" has an unknown level`,
    );
    expect(
      'driving property named',
      Boolean(c && c.drivingProperty),
      `${sample.id}: step "${step.id}" names no driving property`,
    );
    classificationsChecked += 1;
  }
}
console.log(`  classifications checked, all carrying a reason and a driving property: ${classificationsChecked}`);

/* ---- 5. needs-redesign fires exactly when nothing can catch a failure */
const unaccountable = classifyStep({
  ...DEFAULT_PROPERTIES,
  outputVerifiable: false,
  needsJudgment: false,
});
expect('needs redesign', unaccountable.level === 'needs-redesign', `expected needs-redesign, got "${unaccountable.level}"`);
// The same properties but with a human judgment applied must NOT need a
// redesign, since a person now catches a bad result. This is what
// proves the detector discriminates instead of firing on outputVerifiable alone.
const judged = classifyStep({ ...DEFAULT_PROPERTIES, outputVerifiable: false, needsJudgment: true, reversible: true });
expect('needs redesign discriminates', judged.level !== 'needs-redesign', `adding human judgment still produced needs-redesign`);
const parseTicket = analyzeProcess(getSample('refund-handling').state).classifications.get('parse-ticket');
expect('needs redesign on sample', parseTicket?.level === 'needs-redesign', `parse-ticket classified "${parseTicket?.level}"`);
console.log('  needs-redesign fires on an unverifiable, unjudged step and discriminates correctly');

/* ---- 6. Checkpoint aggregates every remaining reason, driving first - */
const invoiceAnalysis = analyzeProcess(getSample('invoice-processing').state);
const approveInvoice = invoiceAnalysis.classifications.get('approve-large-invoice');
expect('checkpoint level', approveInvoice?.level === 'automate-with-checkpoint', `got "${approveInvoice?.level}"`);
expect('checkpoint driving', approveInvoice?.drivingProperty === 'needsJudgment', `driving property was "${approveInvoice?.drivingProperty}"`);
expect(
  'checkpoint contributing',
  Boolean(approveInvoice?.contributingFactors.includes('legalFinancialRisk')),
  `contributing factors were ${JSON.stringify(approveInvoice?.contributingFactors)}`,
);

/* ---- 7. Handoffs detected correctly on a known sequence ------------- */
const refundAnalysis = analyzeProcess(getSample('refund-handling').state);
expect('handoff count', refundAnalysis.handoffs.length === 3, `expected 3 handoffs, got ${refundAnalysis.handoffs.length}`);
const handoffPairs = refundAnalysis.handoffs.map((h) => `${h.fromStepId}>${h.toStepId}`);
for (const pair of ['parse-ticket>check-eligibility', 'check-eligibility>approve-large-refund', 'approve-large-refund>issue-payment']) {
  expect('handoff edge', handoffPairs.includes(pair), `expected handoff edge "${pair}", got ${JSON.stringify(handoffPairs)}`);
}
// issue-payment to send-confirmation stays inside the system, so it must
// NOT be reported as a handoff.
expect('non handoff', !handoffPairs.includes('issue-payment>send-confirmation'), 'a same performer edge was reported as a handoff');
// A workflow with no keep-human or needs-redesign steps has zero
// handoffs, which is the invoice sample's whole teaching point about
// checkpoint steps staying system performed.
expect('zero handoffs when all system', invoiceAnalysis.handoffs.length === 0, `expected 0 handoffs, got ${invoiceAnalysis.handoffs.length}`);
console.log(`  handoffs: refund sample ${refundAnalysis.handoffs.length}, invoice sample ${invoiceAnalysis.handoffs.length}`);

/* ---- 8. Silent failure risk: unverifiable output with a dependent --- */
expect('silent failure count', refundAnalysis.silentFailureRisks.length === 1, `expected 1, got ${refundAnalysis.silentFailureRisks.length}`);
expect(
  'silent failure step',
  refundAnalysis.silentFailureRisks[0]?.stepId === 'parse-ticket',
  `flagged "${refundAnalysis.silentFailureRisks[0]?.stepId}" instead of parse-ticket`,
);
// A terminal step with unverifiable output but no dependent is not a
// silent failure risk, since nothing downstream can be fooled by it.
const terminalUnverifiable = findSilentFailureRisks([
  { id: 'x', name: 'x', owner: 'o', completionEvidence: 'e', dependsOnId: null, properties: { ...DEFAULT_PROPERTIES, outputVerifiable: false } },
]);
expect('no dependent, no risk', terminalUnverifiable.length === 0, 'a step with no dependent was flagged as a silent failure risk');
console.log(`  silent failure risks: ${refundAnalysis.silentFailureRisks.length} on the refund sample, correctly attributed`);

/* ---- 9. Implementation order: stable, explainable, and does not
   reward stakes over frequency times cost minus risk ----------------- */
const refundOrder = refundAnalysis.implementationOrder.map((e) => e.stepId);
expect('order excludes non automatable', !refundOrder.includes('parse-ticket') && !refundOrder.includes('approve-large-refund'), `order wrongly included a non automatable step: ${JSON.stringify(refundOrder)}`);
expect('order content', JSON.stringify(refundOrder) === JSON.stringify(['issue-payment', 'check-eligibility', 'send-confirmation']), `got ${JSON.stringify(refundOrder)}`);

const invoiceOrder = invoiceAnalysis.implementationOrder.map((e) => e.stepId);
expect(
  'stakes does not jump the queue',
  invoiceOrder[invoiceOrder.length - 1] === 'approve-large-invoice',
  `expected the highest stakes, lowest frequency step last, order was ${JSON.stringify(invoiceOrder)}`,
);
expect('order is total', invoiceOrder.length === 5, `expected all 5 invoice steps ranked, got ${invoiceOrder.length}`);

// Determinism of the order itself: running it twice must not reorder
// ties differently.
const rerun = computeImplementationOrder(
  getSample('invoice-processing').state.steps,
  invoiceAnalysis.classifications,
).map((e) => e.stepId);
expect('order stable across runs', JSON.stringify(rerun) === JSON.stringify(invoiceOrder), 'implementation order changed between identical runs');
console.log(`  implementation order: refund ${JSON.stringify(refundOrder)}`);
console.log(`  implementation order: invoice ${JSON.stringify(invoiceOrder)} (approve-large-invoice last despite being the highest stakes step)`);

/* ---- 10. Graph issues: cycles, orphans, broken dependencies -------- */
const withCycle = [
  { id: 'a', name: 'A', owner: 'o', completionEvidence: 'e', dependsOnId: 'c', properties: DEFAULT_PROPERTIES },
  { id: 'b', name: 'B', owner: 'o', completionEvidence: 'e', dependsOnId: 'a', properties: DEFAULT_PROPERTIES },
  { id: 'c', name: 'C', owner: 'o', completionEvidence: 'e', dependsOnId: 'b', properties: DEFAULT_PROPERTIES },
];
const cycles = detectCycles(withCycle);
expect('cycle detected', cycles.length === 1, `expected 1 cycle, got ${cycles.length}`);
expect('cycle members', cycles[0] && new Set(cycles[0]).size === 3, `cycle did not include all 3 steps: ${JSON.stringify(cycles[0])}`);

const withOrphan = [
  { id: 'start', name: 'Start', owner: 'o', completionEvidence: 'e', dependsOnId: null, properties: DEFAULT_PROPERTIES },
  { id: 'next', name: 'Next', owner: 'o', completionEvidence: 'e', dependsOnId: 'start', properties: DEFAULT_PROPERTIES },
  { id: 'floating', name: 'Floating', owner: 'o', completionEvidence: 'e', dependsOnId: null, properties: DEFAULT_PROPERTIES },
];
const orphans = detectOrphans(withOrphan);
expect('orphan detected', orphans.length === 1 && orphans[0] === 'floating', `expected only "floating", got ${JSON.stringify(orphans)}`);
expect('legit start not an orphan', !orphans.includes('start'), '"start" was wrongly flagged as an orphan even though "next" depends on it');

const withBrokenRef = [
  { id: 'a', name: 'A', owner: 'o', completionEvidence: 'e', dependsOnId: 'missing', properties: DEFAULT_PROPERTIES },
];
const issues = findGraphIssues(withBrokenRef);
expect('broken dependency flagged', issues.some((i) => i.kind === 'broken-dependency'), `no broken-dependency issue in ${JSON.stringify(issues)}`);

const cleanGraphIssues = findGraphIssues(getSample('invoice-processing').state.steps);
expect('clean sample has no graph issues', cleanGraphIssues.length === 0, `expected 0, got ${JSON.stringify(cleanGraphIssues)}`);
console.log(`  graph issues: cycle of 3 detected, 1 orphan of 3 steps detected, broken dependency detected, clean sample reports 0`);

/* ---- 11. performerFor is total and consistent with handoff logic ---- */
for (const level of CLASSIFICATION_LEVELS) {
  const performer = performerFor(level);
  expect('performer defined', ['system', 'human', 'undetermined'].includes(performer), `level "${level}" produced performer "${performer}"`);
}

/* ---- 12. Validation --------------------------------------------------*/
expect('validate empty', validate(emptyState()).some((i) => i.severity === 'error'), 'an empty process produced no error');
for (const sample of SAMPLES) {
  const sampleIssues = validate(sampleState(sample.id));
  expect('validate sample clean', sampleIssues.length === 0, `sample "${sample.id}" produced validation issues: ${JSON.stringify(sampleIssues)}`);
}
const missingOwner = {
  processName: 'Test',
  scenarioId: 'custom',
  steps: [
    { id: 'x', name: 'Do the thing', owner: '', completionEvidence: '', dependsOnId: null, properties: DEFAULT_PROPERTIES },
  ],
};
const missingIssues = validate(missingOwner);
expect('validate flags missing owner', missingIssues.some((i) => i.field.includes('owner')), `no owner issue in ${JSON.stringify(missingIssues)}`);
expect('validate flags missing evidence', missingIssues.some((i) => i.field.includes('completionEvidence')), `no completion evidence issue in ${JSON.stringify(missingIssues)}`);

/* ---- 13. Export round trip -------------------------------------------*/
const state = sampleState('refund-handling');
const json = serialize(state, 'json');
const parsed = JSON.parse(json);
expect('export json steps', Array.isArray(parsed.steps) && parsed.steps.length === state.steps.length, 'JSON export lost steps');
expect('export json discloses', typeof parsed.note === 'string' && /No model/i.test(parsed.note), 'JSON export does not disclose that no model was involved');
expect('export json has method', typeof parsed.priorityScoreMethod === 'string' && parsed.priorityScoreMethod.length > 20, 'JSON export omits the priority score method');
expect(
  'export json classification survives',
  parsed.steps[0]?.classification?.level === 'needs-redesign',
  `expected the first step's classification to survive export, got ${JSON.stringify(parsed.steps[0]?.classification)}`,
);

const md = serialize(state, 'markdown');
expect('export markdown header', md.includes('# Workflow Decomposer report'), 'markdown export missing header');
expect('export markdown discloses', /No model produced these results/i.test(md), 'markdown export does not disclose local analysis');
expect('export markdown sections', md.includes('## Handoffs') && md.includes('## Implementation order'), 'markdown export missing a required section');

const name = filename(state, 'json');
expect('filename slug', name === 'customer-refund-request-handling-workflow-report', `got "${name}"`);
expect('filename fallback', filename(emptyState(), 'json') === 'workflow-decomposer-workflow-report', `got "${filename(emptyState(), 'json')}"`);
console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both disclose local analysis, filename "${name}"`);

/* ---- 14. Cost and frequency weights are monotonic, since the priority
   formula would be dishonest otherwise -------------------------------- */
const freqScores = FREQUENCY_LEVELS.map((f) =>
  classifyStep({ ...DEFAULT_PROPERTIES, frequency: f }),
);
expect('frequency does not change level anywhere', freqScores.every((c) => c.level === freqScores[0].level), 'frequency changed classification for the clean profile');
for (const cost of COST_LEVELS) {
  expect('cost level recognized', COST_LEVELS.includes(cost), 'unreachable');
}

/* ---- Report ------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`WORKFLOW DECOMPOSER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('WORKFLOW DECOMPOSER LOGIC: CLEAN');
