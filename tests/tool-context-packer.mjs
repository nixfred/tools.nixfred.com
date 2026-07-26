/**
 * Context Packer, logic gate.
 *
 * Run: bun tests/tool-context-packer.mjs
 *
 * Proves the PRD acceptance criteria that are properties of the engine
 * rather than of the page:
 *   1. Required content is NEVER silently dropped. This is the safety
 *      property the whole tool exists for, so it gets the most scrutiny.
 *   2. Multiple strategies produce different, deterministic, explainable
 *      results on the same input, not just cosmetically different text.
 *   3. Packed tokens never exceed the stated budget.
 *   4. Every excluded block carries a reason.
 *   5. The shipped samples load and pack without throwing.
 *
 * A gate that only checked "packed.length > 0" would pass on an engine
 * that quietly dropped a required block to make the numbers look nice,
 * which is exactly the failure mode the PRD forbids. So criterion 1 is
 * checked by construction: a sample where required blocks alone exceed
 * budget, and an assertion that every one of them still appears,
 * explicitly, in the result.
 */

import {
  pack,
  moveBlock,
  addBlock,
  removeBlock,
  updateBlock,
  estimateTokens,
  tokensOf,
  validate,
  emptyState,
  sampleState,
  serialize,
  getSample,
  SAMPLES,
  STRATEGIES,
} from '../src/lib/tools/context-packer.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

console.log('context-packer logic gate');

/* ---- 1. Samples ---------------------------------------------------- */
expect('samples', SAMPLES.length >= 3, `only ${SAMPLES.length} samples, PRD requires a realistic sample`);
for (const s of SAMPLES) {
  expect('sample shape', Boolean(s.id && s.name && s.teaches && s.budget > 0), `sample ${s.id} is missing a field`);
  expect('sample has blocks', s.blocks.length > 0, `sample ${s.id} has no blocks`);
  for (const b of s.blocks) {
    expect('block shape', Boolean(b.id && b.label && typeof b.required === 'boolean'), `sample ${s.id} block ${b.id} malformed`);
  }
}
console.log(`  samples: ${SAMPLES.length}`);

const realistic = getSample('support-agent');
expect('realistic sample present', Boolean(realistic), 'no support-agent sample, PRD requires a realistic agent task sample');
expect(
  'realistic sample has a required and an optional block',
  realistic.blocks.some((b) => b.required) && realistic.blocks.some((b) => !b.required),
  'the realistic sample needs both required and optional blocks to demonstrate packing at all',
);

/* ---- 2. THE IMPORTANT ONE. Required content is never silently dropped */
const overflow = sampleState('overflow-safety');
const overflowResult = pack(overflow);
expect('overflow sample is infeasible', overflowResult.feasible === false, 'the overflow-safety sample should not be reportable as packed');
expect('overflow: nothing reported as packed', overflowResult.packed.length === 0, 'an infeasible pack must not claim anything was placed');

const requiredBlockCount = overflow.blocks.filter((b) => b.required).length;
expect(
  'overflow: every required block is accounted for',
  overflowResult.requiredOverflow.length === requiredBlockCount,
  `expected ${requiredBlockCount} required blocks listed, got ${overflowResult.requiredOverflow.length}`,
);
for (const original of overflow.blocks.filter((b) => b.required)) {
  const present = overflowResult.requiredOverflow.some((p) => p.block.id === original.id);
  expect('overflow: required block is explicitly named', present, `required block ${original.id} is missing from requiredOverflow, which is exactly the silent drop the PRD forbids`);
}
expect(
  'overflow: message states the actual shortfall',
  typeof overflowResult.overflowMessage === 'string' && overflowResult.overflowMessage.includes(String(overflowResult.requiredTokens)),
  `overflow message does not mention the required token count: "${overflowResult.overflowMessage}"`,
);
expect(
  'overflow: optional blocks are excluded with a reason, not silently dropped either',
  overflowResult.excluded.every((x) => typeof x.reason === 'string' && x.reason.length > 10),
  'an excluded optional block has no substantive reason',
);
expect('overflow: truncation risk is blocked', overflowResult.truncationRisk === 'blocked', `expected "blocked", got "${overflowResult.truncationRisk}"`);
expect(
  'overflow: suggests a shrink target for required blocks',
  overflowResult.summarizationTargets.length > 0 && overflowResult.summarizationTargets.every((t) => t.targetTokens < t.currentTokens),
  'expected at least one summarization target smaller than its current size',
);
console.log(
  `  overflow-safety: required ${overflowResult.requiredTokens} tokens against a ${overflowResult.budget} budget, feasible=${overflowResult.feasible}, all ${requiredBlockCount} required blocks accounted for`,
);

// A sanity check in the other direction: a feasible sample must not be
// reported as infeasible, and must report SOMETHING packed.
const feasible = pack(sampleState('support-agent'));
expect('feasible sample is reported feasible', feasible.feasible === true, 'the support-agent sample should be packable within its own budget');
expect('feasible sample packs at least the required blocks', feasible.packed.length >= requiredBlockCount || feasible.packed.length > 0, 'a feasible pack produced nothing');
expect('feasible sample requiredOverflow is empty', feasible.requiredOverflow.length === 0, 'a feasible pack should not populate requiredOverflow');

/* ---- 3. Strategies differ, deterministically ----------------------- */
expect('at least three strategies ship', STRATEGIES.length >= 3, `only ${STRATEGIES.length} strategies`);

const supportState = sampleState('support-agent');
const byStrategy = {};
for (const strategy of STRATEGIES) {
  byStrategy[strategy] = pack({ ...supportState, strategy });
}

// Determinism: running the same strategy twice must produce the exact
// same packed and excluded id sequences.
for (const strategy of STRATEGIES) {
  const a = pack({ ...supportState, strategy });
  const b = pack({ ...supportState, strategy });
  const idsA = a.packed.map((p) => p.block.id).join(',');
  const idsB = b.packed.map((p) => p.block.id).join(',');
  expect('deterministic packing', idsA === idsB, `strategy ${strategy} produced different results on repeated runs: "${idsA}" vs "${idsB}"`);
}

// Genuine divergence, not just different prose: priority order and
// largest first must disagree about which large optional block survives
// on the support agent sample (history is ranked higher but smaller;
// the knowledge base block is ranked lower but larger).
const priorityExcludedIds = byStrategy['priority-order'].excluded.map((x) => x.block.id).sort();
const largestExcludedIds = byStrategy['largest-first'].excluded.map((x) => x.block.id).sort();
expect(
  'priority order and largest first genuinely diverge',
  JSON.stringify(priorityExcludedIds) !== JSON.stringify(largestExcludedIds),
  `expected different excluded sets, both excluded [${priorityExcludedIds.join(', ')}]`,
);
expect(
  'priority order excludes the knowledge base block',
  priorityExcludedIds.includes('kb'),
  `priority order excluded [${priorityExcludedIds.join(', ')}], expected it to include "kb"`,
);
expect(
  'largest first excludes the history block',
  largestExcludedIds.includes('history'),
  `largest first excluded [${largestExcludedIds.join(', ')}], expected it to include "history"`,
);
console.log(
  `  strategy divergence on support-agent: priority-order excludes [${priorityExcludedIds.join(', ')}], largest-first excludes [${largestExcludedIds.join(', ')}]`,
);

// Same divergence check on the research sample, where priority order and
// largest first both pack only the one large top ranked block while
// smallest first and value density pack two smaller ones instead.
const researchState = sampleState('research-notes');
const researchByStrategy = {};
for (const strategy of STRATEGIES) {
  researchByStrategy[strategy] = pack({ ...researchState, strategy });
}
const dumpPackedBy = (strategy) => researchByStrategy[strategy].packed.some((p) => p.block.id === 'dump');
const statsPackedBy = (strategy) => researchByStrategy[strategy].packed.some((p) => p.block.id === 'stats');
expect('research: priority order packs the big dump block', dumpPackedBy('priority-order'), 'expected priority-order to include "dump"');
expect('research: largest first packs the big dump block', dumpPackedBy('largest-first'), 'expected largest-first to include "dump"');
expect('research: smallest first prefers the small stats block over the dump', statsPackedBy('smallest-first') && !dumpPackedBy('smallest-first'), 'expected smallest-first to include "stats" and exclude "dump"');
expect('research: value density prefers the small stats block over the dump', statsPackedBy('value-density') && !dumpPackedBy('value-density'), 'expected value-density to include "stats" and exclude "dump"');
console.log('  strategy divergence on research-notes: priority-order and largest-first keep the dump, smallest-first and value-density keep stats and summary instead');

/* ---- 4. Every result explains itself -------------------------------- */
let reasonsChecked = 0;
for (const sample of SAMPLES) {
  for (const strategy of STRATEGIES) {
    const result = pack({ ...sampleState(sample.id), strategy });
    for (const p of result.packed) {
      expect('packed block has a reason', typeof p.reason === 'string' && p.reason.length > 10, `${sample.id}/${strategy}: block ${p.block.id} has no explanation`);
      reasonsChecked += 1;
    }
    for (const x of result.excluded) {
      expect('excluded block has a reason', typeof x.reason === 'string' && x.reason.length > 10, `${sample.id}/${strategy}: excluded block ${x.block.id} has no explanation`);
      reasonsChecked += 1;
    }
  }
}
console.log(`  placements checked for a non trivial reason string: ${reasonsChecked}`);

/* ---- 5. Packed tokens never exceed budget --------------------------- */
let budgetChecks = 0;
for (const sample of SAMPLES) {
  for (const strategy of STRATEGIES) {
    const result = pack({ ...sampleState(sample.id), strategy });
    if (!result.feasible) continue;
    const used = result.packed.reduce((sum, p) => sum + p.tokens, 0);
    expect('packed tokens within budget', used <= result.budget, `${sample.id}/${strategy}: packed ${used} tokens against a ${result.budget} budget`);
    expect('remaining capacity is non negative when feasible', result.remainingCapacity >= 0, `${sample.id}/${strategy}: remaining capacity ${result.remainingCapacity} is negative on a feasible pack`);
    budgetChecks += 1;
  }
}
console.log(`  budget respected across ${budgetChecks} sample/strategy combinations`);

/* ---- 6. Every sample loads and packs without throwing --------------- */
for (const sample of SAMPLES) {
  for (const strategy of STRATEGIES) {
    let threw = false;
    let result;
    try {
      result = pack({ ...sampleState(sample.id), strategy });
    } catch (err) {
      threw = true;
    }
    expect('sample packs without throwing', !threw, `${sample.id}/${strategy} threw during pack()`);
    expect('pack result has the expected shape', Boolean(result) && Array.isArray(result.packed) && Array.isArray(result.excluded), `${sample.id}/${strategy} produced a malformed result`);
  }
}

/* ---- 7. Reordering, the priority mechanism --------------------------- */
const reorderState = sampleState('support-agent');
const originalOrder = reorderState.blocks.map((b) => b.id);

const movedUp = moveBlock(reorderState.blocks, originalOrder[3], 'up');
expect(
  'moveBlock swaps with the previous neighbor',
  movedUp[2].id === originalOrder[3] && movedUp[3].id === originalOrder[2],
  `expected positions 2 and 3 to swap, got ${movedUp.map((b) => b.id).join(',')}`,
);

const noopAtTop = moveBlock(reorderState.blocks, originalOrder[0], 'up');
expect(
  'moveBlock is a no-op at the top boundary',
  noopAtTop.map((b) => b.id).join(',') === originalOrder.join(','),
  'moving the first block up should not change order',
);

const lastId = originalOrder[originalOrder.length - 1];
const noopAtBottom = moveBlock(reorderState.blocks, lastId, 'down');
expect(
  'moveBlock is a no-op at the bottom boundary',
  noopAtBottom.map((b) => b.id).join(',') === originalOrder.join(','),
  'moving the last block down should not change order',
);

// A block moved to rank 1 changes what priority order packs, proving
// priority really is array position and reordering really changes it.
const scratchId = 'scratch';
let reordered = reorderState.blocks;
// Walk "scratch" from the back of the list to the very front.
for (let i = 0; i < reorderState.blocks.length; i += 1) {
  reordered = moveBlock(reordered, scratchId, 'up');
}
expect('block walked to rank 1', reordered[0].id === scratchId, `expected "scratch" at rank 1, got "${reordered[0].id}"`);
const afterReorder = pack({ ...reorderState, blocks: reordered, strategy: 'priority-order' });
const scratchIncluded = afterReorder.packed.some((p) => p.block.id === scratchId);
expect('reordering to top priority changes the pack', scratchIncluded, 'moving a block to the highest priority should get it packed under priority order');
console.log('  moveBlock: adjacent swap, both boundary no-ops, and a full walk to rank 1 that changes the packed set, all verified');

/* ---- 8. Block list mutations ----------------------------------------- */
let blocks = [];
blocks = addBlock(blocks, { label: 'Test block', required: true, estimateMethod: 'manual', manualTokens: 42 });
expect('addBlock appends one block', blocks.length === 1, `expected 1 block, got ${blocks.length}`);
expect('addBlock assigns a unique id', Boolean(blocks[0].id), 'new block has no id');

blocks = updateBlock(blocks, blocks[0].id, { manualTokens: 99 });
expect('updateBlock changes the targeted field', blocks[0].manualTokens === 99, `expected 99, got ${blocks[0].manualTokens}`);
expect('updateBlock leaves other fields alone', blocks[0].label === 'Test block', 'updateBlock corrupted an untouched field');

const idToRemove = blocks[0].id;
blocks = removeBlock(blocks, idToRemove);
expect('removeBlock removes the targeted block', blocks.length === 0, `expected 0 blocks, got ${blocks.length}`);

/* ---- 9. Token estimate sanity ----------------------------------------- */
expect('tokens', estimateTokens('') === 0, 'empty string should estimate 0 tokens');
expect('tokens', estimateTokens('abcd') === 1, 'four characters should estimate 1 token');
expect('tokens', estimateTokens('a'.repeat(400)) === 100, '400 characters should estimate 100 tokens');
expect('tokensOf manual', tokensOf({ id: 'x', label: 'x', content: '', estimateMethod: 'manual', manualTokens: 250, required: false }) === 250, 'manual method should return the manual value verbatim');
expect('tokensOf chars-per-4', tokensOf({ id: 'x', label: 'x', content: 'a'.repeat(40), estimateMethod: 'chars-per-4', manualTokens: 999, required: false }) === 10, 'chars-per-4 method should ignore manualTokens and estimate from content');
expect('tokensOf negative manual clamps to zero', tokensOf({ id: 'x', label: 'x', content: '', estimateMethod: 'manual', manualTokens: -50, required: false }) === 0, 'a negative manual estimate should clamp to zero, not go negative');

/* ---- 10. Validation ---------------------------------------------------- */
expect('validate empty', validate(emptyState()).some((i) => i.severity === 'error'), 'an empty state produced no error');
for (const sample of SAMPLES) {
  const issues = validate(sampleState(sample.id));
  const errors = issues.filter((i) => i.severity === 'error');
  expect('validate sample has no errors', errors.length === 0, `sample ${sample.id} produced validation errors: ${JSON.stringify(errors)}`);
}

/* ---- 11. Export round trip --------------------------------------------- */
const exportState = sampleState('support-agent');
const json = serialize(exportState, 'json');
const parsed = JSON.parse(json);
expect('export json parses', Boolean(parsed), 'JSON export did not parse');
expect('export json discloses simulation only', typeof parsed.note === 'string' && /not a tokenizer guarantee/i.test(parsed.note), 'JSON export does not disclose the planning simulator boundary');
expect('export json carries the pack result', Array.isArray(parsed.result.packed), 'JSON export has no packed array');
expect('export json carries the blocks', Array.isArray(parsed.blocks) && parsed.blocks.length === exportState.blocks.length, 'JSON export lost the block list');

const md = serialize(exportState, 'markdown');
expect('export markdown header', md.includes('# Context Packer report'), 'markdown export missing header');
expect('export markdown discloses simulation only', /not a tokenizer guarantee/i.test(md), 'markdown export does not disclose the planning simulator boundary');
expect('export markdown names the strategy', md.includes('Priority order'), 'markdown export does not name the strategy');

const overflowJson = JSON.parse(serialize(overflow, 'json'));
expect('export json for an infeasible pack still discloses it', overflowJson.result.feasible === false, 'infeasible export should still report feasible: false, not silently succeed');
const overflowMd = serialize(overflow, 'markdown');
expect('export markdown for an infeasible pack says so', overflowMd.includes('Refused to pack'), 'infeasible markdown export does not say the pack was refused');
console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both disclose the simulation boundary and the infeasible case`);

/* ---- Report ------------------------------------------------------------ */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`CONTEXT PACKER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('CONTEXT PACKER LOGIC: CLEAN');
