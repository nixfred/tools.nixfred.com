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
 *   6. Cycles are found by a real depth first search, and the reported
 *      path is the actual loop, not just the fact that one exists.
 *   7. Orphan steps and broken dependencies are flagged.
 *   8. A step missing an owner or completion evidence is flagged.
 *   9. Export round trips in both JSON and Markdown.
 *  10. The Agent Designer payload validates against its documented
 *      shape without importing that module.
 */

import {
  classifyStep,
  analyzeProcess,
  detectCycles,
  detectOrphans,
  findGraphIssues,
  findSilentFailureRisks,
  computeImplementationOrder,
  deriveActors,
  deriveApprovalPoints,
  buildAgentDesignerPayload,
  validateAgentDesignerPayload,
  AGENT_DESIGNER_SCHEMA,
  sampleState,
  emptyState,
  validate,
  serialize,
  filename,
  getSample,
  SAMPLES,
  FREQUENCY_LEVELS,
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

/** Builds a minimal Step for synthetic graph tests, properties aside. */
function makeStep(id, dependsOn, overrides = {}) {
  return {
    id,
    name: overrides.name ?? id,
    owner: overrides.owner ?? 'Test owner',
    completionEvidence: overrides.completionEvidence ?? 'Test evidence',
    dependsOn,
    properties: overrides.properties ?? { ...DEFAULT_PROPERTIES },
  };
}

console.log('workflow-decomposer logic gate');

/* ---- 1. Samples ---------------------------------------------------- */
expect('samples', SAMPLES.length >= 2, `only ${SAMPLES.length} samples, need at least two`);
for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} missing a field`);
  expect('sample steps', s.state.steps.length > 0, `sample ${s.id} has no steps`);
  expect(
    'sample process fields',
    typeof s.state.outcome === 'string' && typeof s.state.inputs === 'string' && typeof s.state.constraints === 'string',
    `sample ${s.id} missing outcome, inputs, or constraints`,
  );
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
expect('non handoff', !handoffPairs.includes('issue-payment>send-confirmation'), 'a same performer edge was reported as a handoff');
expect('zero handoffs when all system', invoiceAnalysis.handoffs.length === 0, `expected 0 handoffs, got ${invoiceAnalysis.handoffs.length}`);
console.log(`  handoffs: refund sample ${refundAnalysis.handoffs.length}, invoice sample ${invoiceAnalysis.handoffs.length}`);

/* ---- 8. Silent failure risk: unverifiable output with a dependent --- */
expect('silent failure count', refundAnalysis.silentFailureRisks.length === 1, `expected 1, got ${refundAnalysis.silentFailureRisks.length}`);
expect(
  'silent failure step',
  refundAnalysis.silentFailureRisks[0]?.stepId === 'parse-ticket',
  `flagged "${refundAnalysis.silentFailureRisks[0]?.stepId}" instead of parse-ticket`,
);
const terminalUnverifiable = findSilentFailureRisks([
  makeStep('x', [], { properties: { ...DEFAULT_PROPERTIES, outputVerifiable: false } }),
]);
expect('no dependent, no risk', terminalUnverifiable.length === 0, 'a step with no dependent was flagged as a silent failure risk');
console.log(`  silent failure risks: ${refundAnalysis.silentFailureRisks.length} on the refund sample, correctly attributed`);

/* ---- 9. Implementation order: stable, explainable, and does not
   reward stakes over frequency times cost minus risk ----------------- */
const refundOrder = refundAnalysis.implementationOrder.map((e) => e.stepId);
expect('order excludes non automatable', !refundOrder.includes('parse-ticket') && !refundOrder.includes('approve-large-refund'), `order wrongly included a non automatable step: ${JSON.stringify(refundOrder)}`);
expect('order content', JSON.stringify(refundOrder) === JSON.stringify(['issue-payment', 'check-eligibility', 'send-confirmation']), `got ${JSON.stringify(refundOrder)}`);

const invoiceOrder = invoiceAnalysis.implementationOrder;
const invoiceOrderIds = invoiceOrder.map((e) => e.stepId);
expect('order is total', invoiceOrderIds.length === 6, `expected all 6 invoice steps ranked, got ${invoiceOrderIds.length}`);
// The two highest stakes steps, both monthly and both high cost with
// legal or financial risk, take the biggest risk penalty and both land
// at the very bottom, tied at the lowest score. Which one of the tied
// pair prints last is a stable tie break detail, not the point; the
// point is that stakes alone never buys either of them a better spot.
const lastTwo = invoiceOrderIds.slice(-2);
expect(
  'stakes does not jump the queue',
  new Set(lastTwo).size === 2 &&
    lastTwo.includes('approve-large-invoice') &&
    lastTwo.includes('verify-vendor-bank-details'),
  `expected the two highest stakes, lowest frequency steps last, order was ${JSON.stringify(invoiceOrderIds)}`,
);
const lowestScore = Math.min(...invoiceOrder.map((e) => e.score));
expect(
  'tied steps share the lowest score',
  invoiceOrder.find((e) => e.stepId === 'approve-large-invoice')?.score === lowestScore &&
    invoiceOrder.find((e) => e.stepId === 'verify-vendor-bank-details')?.score === lowestScore,
  `expected both to share the minimum score ${lowestScore}`,
);

const rerun = computeImplementationOrder(
  getSample('invoice-processing').state.steps,
  invoiceAnalysis.classifications,
).map((e) => e.stepId);
expect('order stable across runs', JSON.stringify(rerun) === JSON.stringify(invoiceOrderIds), 'implementation order changed between identical runs');
console.log(`  implementation order: refund ${JSON.stringify(refundOrder)}`);
console.log(`  implementation order: invoice ${JSON.stringify(invoiceOrderIds)} (the two highest stakes steps tied last)`);

/* ---- 10. Cycles: a real DFS with a recursion stack, reporting the
   actual loop, over a graph where a step can depend on more than one
   other step -------------------------------------------------------- */
const withCycle = [makeStep('a', ['c']), makeStep('b', ['a']), makeStep('c', ['b'])];
const cycles = detectCycles(withCycle);
expect('cycle detected', cycles.length === 1, `expected 1 cycle, got ${cycles.length}`);
expect('cycle members', cycles[0] && new Set(cycles[0]).size === 3, `cycle did not include all 3 steps: ${JSON.stringify(cycles[0])}`);
// The reported path is the actual loop in order: rotating it to start
// at 'a' must read a, c, b, the real walk order, not some unrelated
// ordering.
const rotated = (() => {
  const i = cycles[0].indexOf('a');
  return [...cycles[0].slice(i), ...cycles[0].slice(0, i)];
})();
expect(
  'cycle path is the real loop',
  JSON.stringify(rotated) === JSON.stringify(['a', 'c', 'b']),
  `expected the walk a, c, b in some rotation, got ${JSON.stringify(cycles[0])}`,
);

// A DAG merge, one step depending on two others, is not a cycle.
const diamond = [
  makeStep('start', []),
  makeStep('left', ['start']),
  makeStep('right', ['start']),
  makeStep('merge', ['left', 'right']),
];
expect('diamond is not a cycle', detectCycles(diamond).length === 0, 'a legitimate DAG merge was reported as a cycle');

// A self dependency is a 1 step cycle.
const selfLoop = [makeStep('lonely', ['lonely'])];
expect('self loop detected', detectCycles(selfLoop).length === 1 && detectCycles(selfLoop)[0].length === 1, 'a step depending on itself was not detected as a cycle');

// The invoice and refund samples, both real DAGs, must report zero
// cycles despite the invoice sample's merge point.
for (const sample of SAMPLES) {
  expect('shipped sample acyclic', detectCycles(sample.state.steps).length === 0, `sample "${sample.id}" reports a cycle`);
}
console.log(`  cycles: 3 node loop detected as ${JSON.stringify(cycles[0])}, diamond DAG correctly acyclic, self loop detected, all 3 samples acyclic`);

/* ---- 11. Orphans and broken dependencies --------------------------- */
const withOrphan = [makeStep('start', []), makeStep('next', ['start']), makeStep('floating', [])];
const orphans = detectOrphans(withOrphan);
expect('orphan detected', orphans.length === 1 && orphans[0] === 'floating', `expected only "floating", got ${JSON.stringify(orphans)}`);
expect('legit start not an orphan', !orphans.includes('start'), '"start" was wrongly flagged as an orphan even though "next" depends on it');
// A step depended on by two others, the diamond's start, is not an
// orphan either, generalizing the check past a single dependent.
expect('diamond start not an orphan', detectOrphans(diamond).length === 0, 'the diamond DAG reported a spurious orphan');

const withBrokenRef = [makeStep('a', ['missing-1', 'missing-2'])];
const issues = findGraphIssues(withBrokenRef);
const brokenIssue = issues.find((i) => i.kind === 'broken-dependency');
expect('broken dependency flagged', Boolean(brokenIssue), `no broken-dependency issue in ${JSON.stringify(issues)}`);
expect('broken dependency counts both', Boolean(brokenIssue && /2 steps/.test(brokenIssue.message)), `expected the message to count both missing ids, got "${brokenIssue?.message}"`);

for (const sample of SAMPLES) {
  expect('shipped sample has no graph issues', findGraphIssues(sample.state.steps).length === 0, `sample "${sample.id}" reports a graph issue`);
}
console.log('  orphans and broken dependencies: single orphan detected, diamond start correctly not an orphan, broken dependency counts both missing ids, all 3 samples clean');

/* ---- 12. A step missing an owner or completion evidence is flagged - */
const missingOwner = {
  outcome: 'Test',
  inputs: '',
  constraints: '',
  scenarioId: 'custom',
  steps: [makeStep('x', [], { name: 'Do the thing', owner: '', completionEvidence: '' })],
};
const missingIssues = validate(missingOwner);
expect('validate flags missing owner', missingIssues.some((i) => i.field.includes('owner')), `no owner issue in ${JSON.stringify(missingIssues)}`);
expect('validate flags missing evidence', missingIssues.some((i) => i.field.includes('completionEvidence')), `no completion evidence issue in ${JSON.stringify(missingIssues)}`);
expect('validate empty process', validate(emptyState()).some((i) => i.severity === 'error'), 'an empty process produced no error');
for (const sample of SAMPLES) {
  const sampleIssues = validate(sampleState(sample.id));
  expect('validate sample clean', sampleIssues.length === 0, `sample "${sample.id}" produced validation issues: ${JSON.stringify(sampleIssues)}`);
}
console.log('  completeness: a step missing owner or completion evidence is flagged, every shipped sample is complete');

/* ---- 13. Actors and approval points, derived not duplicated -------- */
const invoiceActors = deriveActors(getSample('invoice-processing').state.steps);
expect(
  'actors derived from owners',
  invoiceActors.length === 5 && new Set(invoiceActors).size === 5,
  `expected 5 distinct actors, got ${JSON.stringify(invoiceActors)}`,
);
const refundApprovalPoints = deriveApprovalPoints(
  getSample('refund-handling').state.steps,
  refundAnalysis.classifications,
  refundAnalysis.handoffs,
);
const approvalPointIds = refundApprovalPoints.map((p) => p.stepId);
expect(
  'approval points found',
  approvalPointIds.includes('approve-large-refund') && approvalPointIds.includes('issue-payment'),
  `expected the human approval and the checkpoint payment step, got ${JSON.stringify(approvalPointIds)}`,
);
expect('approval points exclude clean automation', !approvalPointIds.includes('check-eligibility'), 'a clean automate-now step was wrongly listed as an approval point');
console.log(`  actors: ${invoiceActors.length} distinct on the invoice sample. approval points on the refund sample: ${JSON.stringify(approvalPointIds)}`);

/* ---- 14. Export round trip, both formats --------------------------- */
const state = sampleState('refund-handling');
const json = serialize(state, 'json');
const parsed = JSON.parse(json);
expect('export json steps', Array.isArray(parsed.steps) && parsed.steps.length === state.steps.length, 'JSON export lost steps');
expect('export json discloses', typeof parsed.note === 'string' && /No model/i.test(parsed.note), 'JSON export does not disclose that no model was involved');
expect('export json has method', typeof parsed.priorityScoreMethod === 'string' && parsed.priorityScoreMethod.length > 20, 'JSON export omits the priority score method');
expect('export json process fields', parsed.outcome === state.outcome && parsed.inputs === state.inputs && parsed.constraints === state.constraints, 'JSON export lost outcome, inputs, or constraints');
expect('export json actors', Array.isArray(parsed.actors) && parsed.actors.length > 0, 'JSON export lost actors');
expect('export json approval points', Array.isArray(parsed.approvalPoints), 'JSON export lost approval points');
expect(
  'export json classification survives',
  parsed.steps[0]?.classification?.level === 'needs-redesign',
  `expected the first step's classification to survive export, got ${JSON.stringify(parsed.steps[0]?.classification)}`,
);
expect(
  'export json dependsOn survives',
  Array.isArray(parsed.steps[1]?.dependsOn) && parsed.steps[1].dependsOn[0] === 'parse-ticket',
  `expected step 2's dependsOn to survive export, got ${JSON.stringify(parsed.steps[1]?.dependsOn)}`,
);

const md = serialize(state, 'markdown');
expect('export markdown header', md.includes('# Workflow Decomposer report'), 'markdown export missing header');
expect('export markdown discloses', /No model produced these results/i.test(md), 'markdown export does not disclose local analysis');
expect(
  'export markdown sections',
  ['## Handoffs', '## Implementation order', '## Approval points', '## Structural issues'].every((h) => md.includes(h)),
  'markdown export missing a required section',
);
expect('export markdown process fields', md.includes('Outcome:') && md.includes('Inputs:') && md.includes('Constraints:') && md.includes('Actors:'), 'markdown export missing the process input model');

const name = filename(state, 'json');
expect('filename slug', name === 'customer-refund-request-handling-workflow-report', `got "${name}"`);
expect('filename fallback', filename(emptyState(), 'json') === 'workflow-decomposer-workflow-report', `got "${filename(emptyState(), 'json')}"`);
console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both formats round trip and disclose local analysis`);

/* ---- 15. Agent Designer payload, an explicit export only ----------- */
// This file must never import src/lib/tools/agent-designer.ts. The
// payload is validated against ITS OWN documented shape, defined and
// checked entirely inside workflow-decomposer.ts, which is the whole
// point: the contract is explicit, not a shared import.
const agentPayload = buildAgentDesignerPayload(sampleState('refund-handling'));
const agentErrors = validateAgentDesignerPayload(agentPayload);
expect('agent designer payload valid', agentErrors.length === 0, `shape errors: ${JSON.stringify(agentErrors)}`);
expect('agent designer schema tag', agentPayload.schema === AGENT_DESIGNER_SCHEMA, `got schema "${agentPayload.schema}"`);
expect(
  'agent designer candidates only automatable',
  agentPayload.candidates.every((c) => c.classification === 'automate-now' || c.classification === 'automate-with-checkpoint'),
  'a keep-human or needs-redesign step leaked into the candidate list',
);
expect(
  'agent designer excludes keep-human and needs-redesign',
  !agentPayload.candidates.some((c) => c.sourceStepId === 'parse-ticket' || c.sourceStepId === 'approve-large-refund'),
  'needs-redesign or keep-human step wrongly became a candidate',
);
expect(
  'agent designer escalation paths land on a person',
  agentPayload.escalationPaths.every((p) => p.toPerformer === 'human'),
  'an escalation path did not land on a person',
);
expect('agent designer escalation present', agentPayload.escalationPaths.length > 0, 'expected at least one escalation path on the refund sample');

// A visibly malformed payload must fail validation, proving the
// validator actually checks the shape rather than always passing.
const brokenPayload = { ...agentPayload, candidates: [{ sourceStepId: 'x' }] };
const brokenErrors = validateAgentDesignerPayload(brokenPayload);
expect('validator rejects malformed payload', brokenErrors.length > 0, 'a malformed Agent Designer payload passed validation');
expect('validator rejects non object', validateAgentDesignerPayload('not an object').length > 0, 'a bare string passed validation');
expect('validator rejects wrong schema', validateAgentDesignerPayload({ ...agentPayload, schema: 'wrong' }).length > 0, 'a wrong schema tag passed validation');
console.log(`  agent designer payload: ${agentPayload.candidates.length} candidates, ${agentPayload.escalationPaths.length} escalation paths, shape valid, malformed payloads correctly rejected`);

/* ---- Report ------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`WORKFLOW DECOMPOSER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('WORKFLOW DECOMPOSER LOGIC: CLEAN');
