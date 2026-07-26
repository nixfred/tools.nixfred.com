/**
 * AI Stack Mapper, logic gate.
 *
 * Run: bun tests/tool-stack-mapper.mjs
 *
 * Proves the properties the team brief graded this build against:
 *   1. At least two realistic samples ship, a simple chat stack and a
 *      RAG stack with tool calls.
 *   2. SVG layout is deterministic: the same stack produces byte
 *      identical diagram output every time.
 *   3. No node in a known stack's diagram overlaps another.
 *   4. Data flow analysis correctly names every component that sees raw
 *      user input, hand checked against both samples.
 *   5. A guardrail placed after the model it guards is flagged, and a
 *      correctly placed guardrail is not, proving the check
 *      discriminates rather than always firing.
 *   6. The textual equivalent (describePath) mentions every component
 *      in the diagram, which is what proves the a11y path is not a
 *      stub standing in for the picture.
 *   7. The other three structural flags (no timeout, single point of
 *      failure, third party with raw data) fire on exactly the
 *      components designed to trip them, and nowhere else.
 *   8. Validation, export, and the small CRUD primitives behave.
 *
 * A gate that only checked "flags.length > 0" would pass on an engine
 * that flagged everything indiscriminately, which is worse than
 * flagging nothing: it trains the user to ignore the panel. So every
 * count below is asserted exactly, against a stack whose properties
 * were chosen and hand verified for this file.
 */

import {
  SAMPLES,
  CATALOG,
  COMPONENT_KINDS,
  buildDiagram,
  analyzeStack,
  analyzeRiskFlags,
  analyzeDataFlow,
  describePath,
  traceRequest,
  validate,
  emptyState,
  sampleState,
  reset,
  createComponent,
  addComponent,
  removeComponent,
  moveComponent,
  serialize,
  getSample,
} from '../src/lib/tools/stack-mapper.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

console.log('stack-mapper logic gate');

const simpleChat = SAMPLES.find((s) => s.id === 'simple-chat');
const ragTools = SAMPLES.find((s) => s.id === 'rag-tools');

/* ---- 1. Samples ---------------------------------------------------- */
expect('samples', SAMPLES.length >= 2, `only ${SAMPLES.length} samples, PRD requires at least two`);
expect('sample shape simple chat', Boolean(simpleChat), 'no simple chat sample found');
expect('sample shape rag', Boolean(ragTools), 'no RAG with tool calls sample found');
expect(
  'rag sample has tool call',
  ragTools.components.some((c) => c.kind === 'tool-call'),
  'the RAG sample is required to exercise a tool call',
);
expect(
  'rag sample has retrieval components',
  ragTools.components.some((c) => c.kind === 'retriever') &&
    ragTools.components.some((c) => c.kind === 'vector-store'),
  'the RAG sample is required to exercise retrieval',
);
for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches && s.components.length), `sample ${s.id} is malformed`);
}
console.log(`  samples: ${SAMPLES.map((s) => `${s.id} (${s.components.length} components)`).join(', ')}`);

/* ---- 2. Diagram determinism ---------------------------------------- */
for (const sample of SAMPLES) {
  const state = { components: sample.components, sampleId: sample.id };
  const a = buildDiagram(state);
  const b = buildDiagram(state);
  expect('diagram deterministic', a.svg === b.svg, `${sample.id}: two builds of the same stack produced different SVG`);
  expect('diagram deterministic', a.width === b.width && a.height === b.height, `${sample.id}: dimensions drifted between builds`);
}
console.log('  diagram determinism: byte identical SVG across repeated builds, both samples');

/* ---- 3. No node overlaps another ------------------------------------ */
function boxesOverlap(a, b) {
  const separated = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  return !separated;
}

for (const sample of SAMPLES) {
  const state = { components: sample.components, sampleId: sample.id };
  const { nodes } = buildDiagram(state);
  expect('diagram node count', nodes.length === sample.components.length, `${sample.id}: diagram drew ${nodes.length} nodes for ${sample.components.length} components`);
  let overlapping = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (boxesOverlap(nodes[i], nodes[j])) overlapping += 1;
    }
  }
  expect('no node overlap', overlapping === 0, `${sample.id}: ${overlapping} overlapping node pair(s) in a ${nodes.length} node diagram`);
}
console.log('  no node overlaps another, verified by bounding box, both samples');

/* ---- 4. Data flow analysis, hand checked ---------------------------- */
// Hand count against simple-chat's declared seesRawUserData: client,
// gateway, and logging default true; auth and rate-limiter are false;
// the guardrail and the model provider are both explicitly true.
const simpleChatState = { components: simpleChat.components, sampleId: simpleChat.id };
const simpleFlow = analyzeDataFlow(simpleChatState);
expect(
  'data flow raw input, simple chat',
  JSON.stringify(simpleFlow.rawInputSeenBy) ===
    JSON.stringify(['client-1', 'gateway-1', 'guardrail-1', 'model-provider-1', 'logging-1']),
  `got ${JSON.stringify(simpleFlow.rawInputSeenBy)}`,
);
expect(
  'data flow excludes auth and rate limiter, simple chat',
  !simpleFlow.rawInputSeenBy.includes('auth-1') && !simpleFlow.rawInputSeenBy.includes('rate-limiter-1'),
  'auth or the rate limiter was wrongly included',
);
expect('data flow third party, simple chat', JSON.stringify(simpleFlow.thirdPartyHops) === JSON.stringify(['model-provider-1']));
expect('data flow storage, simple chat', JSON.stringify(simpleFlow.storagePoints) === JSON.stringify(['logging-1']));

// rag-tools: the vector store is a third party that does NOT see raw
// input, which is the whole point of that sample, so it must be absent
// from rawInputSeenBy even though it is present in thirdPartyHops.
const ragState = { components: ragTools.components, sampleId: ragTools.id };
const ragFlow = analyzeDataFlow(ragState);
expect(
  'data flow raw input, rag',
  JSON.stringify(ragFlow.rawInputSeenBy) ===
    JSON.stringify([
      'client-1',
      'gateway-1',
      'cache-1',
      'retriever-1',
      'reranker-1',
      'model-provider-1',
      'tool-call-1',
      'guardrail-1',
      'logging-1',
      'human-review-1',
    ]),
  `got ${JSON.stringify(ragFlow.rawInputSeenBy)}`,
);
expect(
  'vector store is third party but does not see raw input',
  ragFlow.thirdPartyHops.includes('vector-store-1') && !ragFlow.rawInputSeenBy.includes('vector-store-1'),
  'the vector store either lost its third party flag or wrongly gained raw input visibility',
);
expect(
  'data flow storage, rag',
  JSON.stringify(ragFlow.storagePoints) === JSON.stringify(['cache-1', 'vector-store-1', 'logging-1', 'evaluation-hook-1']),
  `got ${JSON.stringify(ragFlow.storagePoints)}`,
);
console.log(
  `  data flow, raw input seen by: simple chat ${simpleFlow.rawInputSeenBy.length}/7, rag ${ragFlow.rawInputSeenBy.length}/13 components, both hand verified`,
);

/* ---- 5. Guardrail placement discriminates ---------------------------- */
const simpleFlags = analyzeRiskFlags(simpleChatState);
const ragFlags = analyzeRiskFlags(ragState);

expect(
  'guardrail correctly placed is not flagged',
  simpleFlags.filter((f) => f.kind === 'guardrail-misplaced').length === 0,
  'the simple chat guardrail sits before the model provider and must not be flagged',
);
const misplaced = ragFlags.filter((f) => f.kind === 'guardrail-misplaced');
expect('guardrail placed after the model is flagged', misplaced.length === 1, `expected exactly 1 misplaced guardrail flag, got ${misplaced.length}`);
if (misplaced.length) {
  expect('misplaced guardrail identifies itself', misplaced[0].componentId === 'guardrail-1', `flag attached to ${misplaced[0].componentId}`);
  expect(
    'misplaced guardrail message names the model provider',
    /model provider/i.test(misplaced[0].message),
    `message was: ${misplaced[0].message}`,
  );
}
console.log(`  guardrail-misplaced: 0 on the correctly placed sample, 1 on the sample where it runs after the model`);

/* ---- 6. Textual equivalent mentions every component ------------------ */
for (const sample of SAMPLES) {
  const state = { components: sample.components, sampleId: sample.id };
  const lines = describePath(state);
  const joined = lines.join(' ');
  const missing = sample.components.filter((c) => !joined.includes(c.label));
  expect('textual equivalent mentions every component', missing.length === 0, `${sample.id}: missing ${missing.map((c) => c.label).join(', ')}`);
  expect('textual equivalent line count', lines.length === sample.components.length, `${sample.id}: ${lines.length} lines for ${sample.components.length} components`);
}
console.log('  textual equivalent (describePath) mentions every component, both samples');

/* ---- 7. The other structural flags, exact counts --------------------- */
const countBy = (flags, kind) => flags.filter((f) => f.kind === kind).length;

expect('no-timeout count, simple chat', countBy(simpleFlags, 'no-timeout') === 1, `got ${countBy(simpleFlags, 'no-timeout')}`);
expect('single-point-of-failure count, simple chat', countBy(simpleFlags, 'single-point-of-failure') === 2, `got ${countBy(simpleFlags, 'single-point-of-failure')}`);
expect('third-party-raw-data count, simple chat', countBy(simpleFlags, 'third-party-raw-data') === 1, `got ${countBy(simpleFlags, 'third-party-raw-data')}`);
expect('simple chat total flags', simpleFlags.length === 4, `got ${simpleFlags.length}: ${simpleFlags.map((f) => f.kind).join(', ')}`);

expect('no-timeout count, rag', countBy(ragFlags, 'no-timeout') === 3, `got ${countBy(ragFlags, 'no-timeout')}`);
expect('single-point-of-failure count, rag', countBy(ragFlags, 'single-point-of-failure') === 2, `got ${countBy(ragFlags, 'single-point-of-failure')}`);
expect('third-party-raw-data count, rag', countBy(ragFlags, 'third-party-raw-data') === 2, `got ${countBy(ragFlags, 'third-party-raw-data')}`);
expect('rag total flags', ragFlags.length === 8, `got ${ragFlags.length}: ${ragFlags.map((f) => f.kind).join(', ')}`);

const ragThirdPartyRaw = ragFlags.filter((f) => f.kind === 'third-party-raw-data').map((f) => f.componentId);
expect(
  'third party raw data flags name the model provider and the tool call, not the vector store',
  JSON.stringify(ragThirdPartyRaw.sort()) === JSON.stringify(['model-provider-1', 'tool-call-1']),
  `got ${JSON.stringify(ragThirdPartyRaw)}`,
);
console.log(
  `  structural flags, exact hand verified counts: simple chat ${simpleFlags.length} total, rag ${ragFlags.length} total, all four kinds exercised`,
);

/* ---- 8. Trace mode carries the data forward -------------------------- */
const simpleTrace = traceRequest(simpleChatState);
expect('trace hop count', simpleTrace.length === simpleChat.components.length, `${simpleTrace.length} hops for ${simpleChat.components.length} components`);
const lastHop = simpleTrace[simpleTrace.length - 1];
expect(
  'raw input was sanitized before the trace ends',
  !lastHop.after.includes('raw-input') && lastHop.after.includes('sanitized-input'),
  `final data present: ${JSON.stringify(lastHop.after)}`,
);
const rerankerHop = traceRequest(ragState).find((h) => h.componentLabel === 'Reranker');
expect(
  'reranker strips retrieved context and adds ranked context',
  rerankerHop.stripped.includes('retrieved-context') && rerankerHop.added.includes('ranked-context'),
  `reranker hop: stripped ${JSON.stringify(rerankerHop.stripped)}, added ${JSON.stringify(rerankerHop.added)}`,
);
console.log('  trace mode: guardrail sanitizes raw input, reranker strips retrieved context for ranked context');

/* ---- 9. Validation ---------------------------------------------------- */
const emptyIssues = validate(emptyState());
expect('validate empty', emptyIssues.some((i) => i.severity === 'error'), 'an empty stack produced no error');
expect('validate sample clean', validate(sampleState('simple-chat')).length === 0, `sample produced validation issues: ${JSON.stringify(validate(sampleState('simple-chat')))}`);
expect('validate sample clean', validate(sampleState('rag-tools')).length === 0, `sample produced validation issues: ${JSON.stringify(validate(sampleState('rag-tools')))}`);

const disconnected = validate({
  components: [
    createComponent('client', []),
    { ...createComponent('guardrail', []), guards: 'tool-call' },
  ],
  sampleId: 'simple-chat',
});
expect(
  'disconnected guardrail is flagged',
  disconnected.some((i) => /connected to nothing/.test(i.message)),
  `expected a disconnected guardrail warning, got ${JSON.stringify(disconnected)}`,
);
console.log('  validation: empty stack errors, both samples are clean, a guardrail guarding an absent kind is flagged');

/* ---- 10. Export round trip --------------------------------------------- */
const jsonExport = serialize(sampleState('rag-tools'), 'json');
const parsed = JSON.parse(jsonExport);
expect('export json parses', Array.isArray(parsed.components) && parsed.components.length === 13, 'JSON export lost components');
expect('export json discloses local analysis', /not infrastructure provisioning/i.test(parsed.note), 'JSON export does not disclose the design tool boundary');
expect('export json carries risk flags', Array.isArray(parsed.riskFlags) && parsed.riskFlags.length === 8, `expected 8 risk flags in export, got ${parsed.riskFlags?.length}`);

const mdExport = serialize(sampleState('simple-chat'), 'markdown');
expect('export markdown header', mdExport.includes('# AI Stack Mapper, system description'), 'markdown export missing header');
expect('export markdown discloses boundary', /not infrastructure provisioning/i.test(mdExport), 'markdown export does not disclose the design tool boundary');
expect('export markdown lists every component', simpleChat.components.every((c) => mdExport.includes(c.label)), 'markdown export dropped a component from the path');
console.log(`  export: json ${jsonExport.length} bytes, markdown ${mdExport.length} bytes, both disclose the design-tool boundary`);

/* ---- 11. CRUD primitives ------------------------------------------------ */
let state = emptyState();
state = addComponent(state, 'client');
state = addComponent(state, 'guardrail');
expect('addComponent appends', state.components.length === 2, `got ${state.components.length}`);
expect('createComponent defaults from catalog', state.components[1].guards === 'model-provider', 'a new guardrail should default to guarding the model provider');

const modelDefaults = createComponent('model-provider', []);
expect('model provider default third party', modelDefaults.thirdParty === true, 'model providers default to third party');
expect('model provider default sees raw data', modelDefaults.seesRawUserData === true, 'model providers default to seeing raw input');
expect('new component defaults conservative on timeout', modelDefaults.hasTimeout === false, 'a fresh component should not be assumed to have a timeout');
expect('new component defaults conservative on fallback', modelDefaults.hasFallback === false, 'a fresh component should not be assumed to have a fallback');

// Id collision guard: remove the first of two same-kind instances, add a
// third, and confirm the new id never collides with the one that remains.
let idState = emptyState();
idState = addComponent(idState, 'guardrail');
idState = addComponent(idState, 'guardrail');
idState = removeComponent(idState, idState.components[0].id);
idState = addComponent(idState, 'guardrail');
const ids = idState.components.map((c) => c.id);
expect('no id collisions after remove and re-add', new Set(ids).size === ids.length, `ids were: ${JSON.stringify(ids)}`);

// moveComponent reorders and a move past either end is a no-op.
let moveState = { components: [createComponent('client', []), createComponent('gateway', [])], sampleId: 'simple-chat' };
const movedUp = moveComponent(moveState, moveState.components[1].id, 'up');
expect('moveComponent reorders', movedUp.components[0].kind === 'gateway', 'moving the second item up should put it first');
const noop = moveComponent(moveState, moveState.components[0].id, 'up');
expect('moveComponent no-ops past the start', noop.components[0].id === moveState.components[0].id, 'moving the first item up should not change order');
console.log('  CRUD primitives: add, remove, move, and id collision avoidance after remove and re-add');

/* ---- 12. Catalog coverage ------------------------------------------------ */
// UPDATED 2026-07-26, deliberately: was a hardcoded 14. Three kinds the
// PRD names were missing (orchestration, memory, storage) and were added,
// so a fixed count is now the wrong assertion. Checking the floor plus
// the PRD vocabulary is stricter than a magic number: it cannot be
// satisfied by adding arbitrary kinds, and it fails if a named one is
// removed.
expect('component kind floor', COMPONENT_KINDS.length >= 17, `got ${COMPONENT_KINDS.length}, expected at least 17`);
for (const required of ['client', 'gateway', 'orchestration', 'model-provider', 'retriever', 'tool-call', 'memory', 'guardrail', 'logging', 'storage']) {
  expect('PRD vocabulary covered', COMPONENT_KINDS.includes(required), `${required} is named in the PRD workflow line but missing from COMPONENT_KINDS`);
}
for (const kind of COMPONENT_KINDS) {
  expect('catalog entry complete', Boolean(CATALOG[kind]?.label && CATALOG[kind]?.whatCouldFail), `${kind} is missing a catalog fact`);
}

/* ---- 13. Diagram accessibility scaffolding -------------------------------- */
for (const sample of SAMPLES) {
  const { svg } = buildDiagram({ components: sample.components, sampleId: sample.id });
  expect('svg has role img', svg.includes('role="img"'), `${sample.id}: svg is missing role="img"`);
  expect('svg has a title element', /<title id="[^"]+">/.test(svg), `${sample.id}: svg is missing a <title>`);
  expect('svg has a desc element', /<desc id="[^"]+">/.test(svg), `${sample.id}: svg is missing a <desc>`);
  expect('svg title names the first component', svg.includes(sample.components[0].label), `${sample.id}: svg title does not name the first component`);
}
console.log('  diagram accessibility: role=img, title, and desc present on both samples');

/* ---- Report --------------------------------------------------------------- */

/* ==================================================================
   TEMPLATES, added 2026-07-26.

   14-STACK-MAPPER.md's workflow line offers "an architecture template
   or assemble ... components". Templates were the missing half.

   The load bearing assertion is that EVERY shipped template validates
   clean. A template that ships with a validity finding teaches the
   wrong thing on first click, and it is also the control proving the
   validator discriminates rather than firing on everything.
   ================================================================== */
{
  const mod = await import('../src/lib/tools/stack-mapper.ts');
  const { TEMPLATES, templateState, getTemplate, validate, COMPONENT_KINDS, CATALOG } = mod;

  expect('templates exist', Array.isArray(TEMPLATES) && TEMPLATES.length >= 3,
    `expected at least 3 templates, got ${TEMPLATES?.length}`);

  const seen = new Set();
  for (const t of TEMPLATES) {
    expect('template shape', Boolean(t.id && t.name && t.description),
      `template ${t.id} is missing a field`);
    expect('template unique', !seen.has(t.id), `duplicate template id ${t.id}`);
    seen.add(t.id);

    expect('template kinds valid', t.kinds.every((k) => COMPONENT_KINDS.includes(k)),
      `template ${t.id} names a kind not in COMPONENT_KINDS`);

    // Every path must begin at a client, which is what the validator
    // requires and what makes a trace meaningful.
    expect('template starts at client', t.kinds[0] === 'client',
      `template ${t.id} starts at ${t.kinds[0]}, not client`);

    const state = templateState(t.id);
    expect('template materializes', state.components.length === t.kinds.length,
      `template ${t.id} produced ${state.components.length} components for ${t.kinds.length} kinds`);

    // Ids must be unique or the diagram and CRUD both break.
    const ids = state.components.map((c) => c.id);
    expect('template ids unique', new Set(ids).size === ids.length,
      `template ${t.id} produced duplicate component ids`);

    const findings = validate(state);
    expect('template validates clean', findings.length === 0,
      `template ${t.id} ships with validity findings: ${findings.map((f) => f.message || f.kind).join('; ')}`);
  }

  // An unknown id must not throw; it falls back to the first template.
  const fallback = templateState('no-such-template');
  expect('template fallback', fallback.components.length > 0,
    'unknown template id produced an empty stack instead of falling back');
  expect('getTemplate miss', getTemplate('no-such-template') === undefined,
    'getTemplate returned something for an unknown id');

  // The PRD names a vocabulary. Confirm the three that were missing
  // before 2026-07-26 now exist and are reachable from a template.
  for (const kind of ['orchestration', 'memory', 'storage']) {
    expect('prd vocabulary present', COMPONENT_KINDS.includes(kind),
      `${kind} is named in the PRD workflow but is not a component kind`);
    expect('prd vocabulary has catalog entry', Boolean(CATALOG[kind]?.label),
      `${kind} has no catalog entry`);
    expect('prd vocabulary reachable', TEMPLATES.some((t) => t.kinds.includes(kind)),
      `${kind} exists but no template uses it, so a visitor never meets it`);
  }

  console.log(`  templates: ${TEMPLATES.length}, all validate clean, all start at a client`);
  console.log(`  component kinds: ${COMPONENT_KINDS.length}, including orchestration, memory, and storage`);
}


console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`STACK MAPPER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('STACK MAPPER LOGIC: CLEAN');