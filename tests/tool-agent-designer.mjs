/**
 * Agent Designer, logic gate.
 *
 * Run: bun tests/tool-agent-designer.mjs
 *
 * Proves the properties that are the actual point of this tool, not
 * generic shape checks:
 *   1. Full autonomy plus an irreversible mutating tool is ALWAYS
 *      flagged, regardless of what else is in the spec.
 *   2. An escalation path with no owner is flagged.
 *   3. A missing stop condition is flagged.
 *   4. The completeness score rises monotonically as required fields
 *      are filled in, and the spec is never reported complete while
 *      one of them is still blank.
 *   5. The markdown export contains every section.
 *   6. At least two realistic samples ship, and the unsafe one trips
 *      every rule above at once.
 */

import {
  emptyState,
  sampleState,
  getSample,
  evaluateSpec,
  computeCompleteness,
  isReadyToBuild,
  validate,
  serialize,
  SAMPLES,
  AUTONOMY_LEVELS,
} from '../src/lib/tools/agent-designer.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

function blankTool(overrides = {}) {
  return {
    id: 'test-tool',
    name: 'Test tool',
    input: 'x',
    output: 'y',
    mutates: false,
    irreversible: false,
    needsConfirmation: false,
    ...overrides,
  };
}

function blankHandoff(overrides = {}) {
  return {
    id: 'test-handoff',
    trigger: 'x',
    target: 'y',
    contextTransferred: 'z',
    owner: 'someone',
    ...overrides,
  };
}

console.log('agent-designer logic gate');

/* ---- 1. Samples ---------------------------------------------------- */
expect('samples', SAMPLES.length >= 2, `only ${SAMPLES.length} samples, at least two are required`);
for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} is missing a field`);
  expect('sample shape', Boolean(s.state && s.state.name), `sample ${s.id} has no named agent`);
}
console.log(`  samples: ${SAMPLES.length}`);

/* ---- 2. THE HEADLINE RULE. Full autonomy plus an irreversible ------ *
 * mutating tool is ALWAYS flagged, no matter what else is true. Swept
 * across every combination of the other two tool booleans and every
 * other autonomy level, to prove the rule is about this one
 * combination and not a coincidence of the sample data.
 * -------------------------------------------------------------------- */
for (const needsConfirmation of [true, false]) {
  const state = {
    ...emptyState(),
    tools: [blankTool({ mutates: true, irreversible: true, needsConfirmation })],
    autonomy: { level: 'fully-autonomous', rationale: 'because' },
  };
  const flags = evaluateSpec(state);
  expect(
    'fully autonomous + irreversible mutation always flagged',
    flags.some((f) => f.severity === 'critical' && f.panel === 'autonomy'),
    `needsConfirmation=${needsConfirmation}: no critical autonomy flag among ${JSON.stringify(flags)}`,
  );
}
// The same tool at every OTHER autonomy level must not trip this
// specific rule, which is what proves it is reading the level rather
// than always firing on any irreversible tool.
for (const level of AUTONOMY_LEVELS.filter((l) => l !== 'fully-autonomous')) {
  const state = {
    ...emptyState(),
    tools: [blankTool({ mutates: true, irreversible: true, needsConfirmation: true })],
    autonomy: { level, rationale: 'because' },
  };
  const flags = evaluateSpec(state);
  expect(
    'irreversible mutation is not flagged as an autonomy contradiction outside full autonomy',
    !flags.some((f) => f.id.startsWith('autonomy-irreversible')),
    `level ${level} unexpectedly tripped the fully autonomous irreversible rule`,
  );
}
// And a reversible mutation at full autonomy must NOT trip this
// specific rule, proving it keys on irreversible, not on mutates alone.
{
  const state = {
    ...emptyState(),
    tools: [blankTool({ mutates: true, irreversible: false, needsConfirmation: false })],
    autonomy: { level: 'fully-autonomous', rationale: 'because' },
  };
  const flags = evaluateSpec(state);
  expect(
    'a reversible mutation at full autonomy does not trip the irreversible rule',
    !flags.some((f) => f.id.startsWith('autonomy-irreversible')),
    `reversible tool unexpectedly tripped the irreversible rule: ${JSON.stringify(flags)}`,
  );
}
console.log('  full autonomy + irreversible mutating tool: always flagged, confirmed by sweep');

/* ---- 3. An escalation path with no owner is flagged ---------------- */
{
  const withOwner = { ...emptyState(), handoffs: [blankHandoff({ owner: 'the team lead' })] };
  const withoutOwner = { ...emptyState(), handoffs: [blankHandoff({ owner: '' })] };
  expect(
    'handoff with an owner is not flagged',
    !evaluateSpec(withOwner).some((f) => f.panel === 'handoffs'),
    'a fully specified handoff should not trip the owner check',
  );
  expect(
    'handoff with no owner is flagged',
    evaluateSpec(withoutOwner).some((f) => f.severity === 'critical' && f.panel === 'handoffs'),
    'a handoff with a blank owner did not produce a critical flag',
  );
  const untouched = { ...emptyState(), handoffs: [blankHandoff({ trigger: '', target: '', contextTransferred: '', owner: '' })] };
  expect(
    'a completely untouched handoff row is not flagged yet',
    !evaluateSpec(untouched).some((f) => f.panel === 'handoffs'),
    'an empty, unstarted handoff row should not be treated as a missing owner',
  );
}
console.log('  escalation path with no owner: flagged; untouched row: not flagged; owned row: clean');

/* ---- 4. A missing stop condition is flagged ------------------------ */
{
  const noStop = { ...emptyState(), limits: { ...emptyState().limits, stopConditions: [] } };
  const blankStop = { ...emptyState(), limits: { ...emptyState().limits, stopConditions: ['   ', ''] } };
  const withStop = { ...emptyState(), limits: { ...emptyState().limits, stopConditions: ['Step budget reached'] } };
  expect(
    'no stop conditions at all is flagged',
    evaluateSpec(noStop).some((f) => f.id === 'limits-stop-condition' && f.severity === 'critical'),
    'an empty stopConditions array did not trip the flag',
  );
  expect(
    'stop conditions that are only whitespace are flagged',
    evaluateSpec(blankStop).some((f) => f.id === 'limits-stop-condition'),
    'whitespace only stop conditions were treated as real ones',
  );
  expect(
    'a real stop condition clears the flag',
    !evaluateSpec(withStop).some((f) => f.id === 'limits-stop-condition'),
    'a real stop condition still tripped the missing condition flag',
  );
}
console.log('  missing stop condition: flagged; whitespace only: flagged; a real one: clean');

/* ---- 5. Completeness: monotonic, and never complete while blank ---- */
{
  let state = emptyState();
  let previousScore = computeCompleteness(state).score;
  expect('empty state is not complete', computeCompleteness(state).missing.length > 0, 'an empty spec reported no missing fields');
  expect('empty state is not ready to build', !isReadyToBuild(state), 'an empty spec reported ready to build');

  const fillSteps = [
    () => ({ ...state, name: 'Test agent' }),
    () => ({ ...state, purpose: { ...state.purpose, summary: 'x' } }),
    () => ({ ...state, purpose: { ...state.purpose, mustNever: 'x' } }),
    () => ({ ...state, purpose: { ...state.purpose, doneLooksLike: 'x' } }),
    () => ({ ...state, purpose: { ...state.purpose, successMeasure: 'x' } }),
    () => ({ ...state, tools: [blankTool()] }),
    () => ({ ...state, autonomy: { ...state.autonomy, rationale: 'x' } }),
    () => ({ ...state, handoffs: [blankHandoff()] }),
    () => ({ ...state, limits: { ...state.limits, stepBudget: 5 } }),
    () => ({ ...state, limits: { ...state.limits, timeBudgetMinutes: 5 } }),
    () => ({ ...state, limits: { ...state.limits, costCeiling: '$1' } }),
    () => ({ ...state, limits: { ...state.limits, retryPolicy: 'x' } }),
    () => ({ ...state, limits: { ...state.limits, stopConditions: ['x'] } }),
    () => ({ ...state, failure: { ...state.failure, onToolFailure: 'x' } }),
    () => ({ ...state, failure: { ...state.failure, onUncertainty: 'x' } }),
    () => ({ ...state, failure: { ...state.failure, onLoopDetected: 'x' } }),
  ];

  for (const step of fillSteps) {
    state = step();
    const completeness = computeCompleteness(state);
    expect(
      'score never decreases as fields are filled',
      completeness.score >= previousScore,
      `score dropped from ${previousScore} to ${completeness.score}`,
    );
    if (completeness.missing.length > 0) {
      expect('never reports 100 while a field is missing', completeness.score < 100, `score is 100 but missing: ${completeness.missing.join(', ')}`);
    }
    previousScore = completeness.score;
  }

  const finalCompleteness = computeCompleteness(state);
  expect('fully filled state has zero missing fields', finalCompleteness.missing.length === 0, `still missing: ${finalCompleteness.missing.join(', ')}`);
  expect('fully filled state scores 100', finalCompleteness.score === 100, `score is ${finalCompleteness.score}`);
  expect('fully filled, flag free state is ready to build', isReadyToBuild(state), 'a complete, clean spec was not ready to build');
  console.log(`  completeness climbed from an empty spec to ${finalCompleteness.score} percent across ${fillSteps.length} fill steps, never early`);
}

/* ---- 6. A spec can be 100 percent complete and still not ready, ---- *
 * when a critical flag remains. Proves completeness and risk are
 * tracked separately rather than completeness quietly absorbing risk.
 * ---------------------------------------------------------------------- */
{
  const cleanFilled = {
    name: 'x',
    purpose: { summary: 'x', mustNever: 'x', doneLooksLike: 'x', successMeasure: 'x' },
    tools: [blankTool({ mutates: true, irreversible: true, needsConfirmation: true })],
    autonomy: { level: 'fully-autonomous', rationale: 'x' },
    handoffs: [blankHandoff()],
    limits: { stepBudget: 1, timeBudgetMinutes: 1, costCeiling: 'x', retryPolicy: 'x', stopConditions: ['x'] },
    failure: { onToolFailure: 'x', onUncertainty: 'x', onLoopDetected: 'x' },
  };
  const completeness = computeCompleteness(cleanFilled);
  expect('every field can be filled while a contradiction remains', completeness.missing.length === 0, `unexpected missing fields: ${completeness.missing.join(', ')}`);
  expect(
    '100 percent complete is not the same as ready to build',
    !isReadyToBuild(cleanFilled),
    'a spec with a fully autonomous, irreversible, confirmation requiring tool was reported ready to build',
  );
}
console.log('  100 percent complete with an unresolved contradiction: correctly not ready to build');

/* ---- 7. The unsafe sample trips every rule at once ----------------- */
{
  const unsafe = getSample('cleanup-agent');
  const flags = evaluateSpec(unsafe.state);
  const critical = flags.filter((f) => f.severity === 'critical');
  expect('unsafe sample trips the irreversible autonomy rule', flags.some((f) => f.id.startsWith('autonomy-irreversible')), 'missing');
  expect('unsafe sample trips the confirmation autonomy rule', flags.some((f) => f.id.startsWith('autonomy-confirmation')), 'missing');
  expect('unsafe sample trips the missing owner rule', flags.some((f) => f.id.startsWith('handoff-owner')), 'missing');
  expect('unsafe sample trips the missing stop condition rule', flags.some((f) => f.id === 'limits-stop-condition'), 'missing');
  expect('unsafe sample trips the missing uncertainty rule', flags.some((f) => f.id === 'failure-uncertainty'), 'missing');
  expect('unsafe sample has at least five critical flags', critical.length >= 5, `only ${critical.length} critical flags`);
  expect('unsafe sample is not ready to build', !isReadyToBuild(unsafe.state), 'the deliberately unsafe sample was reported ready to build');
  console.log(`  unsafe sample: ${critical.length} critical flags, all five rules confirmed firing together`);
}

/* ---- 8. The other two samples are clean, proving the checks --------
 * discriminate rather than always firing. --------------------------- */
for (const id of ['support-triage', 'research-digest']) {
  const sample = getSample(id);
  const flags = evaluateSpec(sample.state);
  expect(`sample ${id} is flag free`, flags.length === 0, `unexpected flags: ${JSON.stringify(flags)}`);
  expect(`sample ${id} is ready to build`, isReadyToBuild(sample.state), `sample ${id} was not ready to build`);
}
console.log('  support-triage and research-digest samples: zero flags, both ready to build');

/* ---- 9. Markdown export contains every section --------------------- */
{
  const state = sampleState('support-triage');
  const md = serialize(state, 'markdown');
  const requiredSections = ['## Purpose', '## Tools', '## Autonomy', '## Handoffs', '## Limits', '## Failure', '## Risk flags'];
  for (const section of requiredSections) {
    expect('markdown export has section', md.includes(section), `missing "${section}"`);
  }
  expect('markdown export names the agent', md.includes(state.name), 'agent name missing from export');
  expect('markdown export states readiness', /Ready to build: (yes|no)\./.test(md), 'no readiness line in export');
  expect('markdown export discloses no model was involved', /Nothing here called a model/i.test(md), 'markdown export does not disclose that no model produced this spec');
  console.log(`  markdown export: ${md.length} bytes, all ${requiredSections.length} sections present`);
}

/* ---- 10. JSON export round trip ------------------------------------ */
{
  const state = sampleState('cleanup-agent');
  const json = serialize(state, 'json');
  const parsed = JSON.parse(json);
  expect('json export preserves the spec', parsed.spec.name === state.name, 'JSON export lost the agent name');
  expect('json export carries flags', Array.isArray(parsed.flags) && parsed.flags.length > 0, 'JSON export lost the risk flags');
  expect('json export carries completeness', typeof parsed.completeness.score === 'number', 'JSON export lost the completeness score');
  expect('json export discloses no model was involved', /No model|Nothing here called a model/i.test(parsed.note), 'export note does not disclose local analysis');
  console.log(`  json export: ${json.length} bytes, spec plus flags plus completeness all round trip`);
}

/* ---- 11. validate() ------------------------------------------------- */
{
  expect('validate flags an empty name', validate(emptyState()).some((i) => i.severity === 'error'), 'an unnamed agent produced no error');
  expect('validate is clean for a full sample', validate(sampleState('support-triage')).length === 0, 'a loaded sample produced validation issues');
}

/* ---- Report ---------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`AGENT DESIGNER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('AGENT DESIGNER LOGIC: CLEAN');
