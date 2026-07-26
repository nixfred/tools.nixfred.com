/**
 * Cross tool fact consistency gate.
 *
 * Run: bun tests/check-cross-tool-facts.mjs
 *
 * WHY THIS EXISTS. On 2026-07-26 the Token and Cost Planner priced Claude
 * Opus 5 at $5 and $25 per million tokens, sourced from the first party
 * model table. The Model Selector priced the same model at $15 and $75,
 * extrapolated from an older Opus tier and labeled a placeholder. Both
 * tools shipped, both were green, and both were on the same site telling
 * a visitor different things about the same model. One of them also
 * described its number as a published list price.
 *
 * Every existing gate passed. check-registry validates the registry,
 * check-copy validates house style, and each tool's own suite validates
 * that tool against its own brief. NOTHING checked whether two tools
 * agreed with each other, because no single tool was wrong on its own
 * terms.
 *
 * That is the gap this gate closes. A workbench whose instruments
 * disagree is worse than one instrument, because the visitor cannot tell
 * which reading to trust and has no way to find out.
 *
 * SCOPE: facts that appear in more than one tool. Add a check here
 * whenever a second tool starts carrying a fact the first one already
 * had. If a number only lives in one place, it does not belong here.
 */

import { PRICING_PROFILES } from '../src/lib/tools/token-planner.ts';
import { CATALOG as MODEL_CATALOG } from '../src/lib/tools/model-selector.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

console.log('cross tool fact consistency gate');

/* ---- Model pricing, Token Planner versus Model Selector ---------- */

// Both tools carry a pricing table. Where they name the same model, the
// numbers must match. Matching is by normalized id so a cosmetic naming
// difference does not silently skip the comparison.
const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const plannerById = new Map();
for (const p of PRICING_PROFILES) {
  if (p.id === 'custom') continue; // user supplied, nothing to agree with
  plannerById.set(normalize(p.id), p);
}

const selectorById = new Map();
for (const m of MODEL_CATALOG) {
  selectorById.set(normalize(m.id), m);
}

const shared = [...plannerById.keys()].filter((k) => selectorById.has(k));

expect(
  'overlap exists',
  shared.length >= 3,
  `only ${shared.length} models appear in BOTH tools. If the catalogs diverged this gate stops checking anything, which is the failure mode it exists to prevent.`,
);

for (const key of shared) {
  const planner = plannerById.get(key);
  const selector = selectorById.get(key);

  expect(
    'input price agrees',
    planner.inputPerMillion === selector.pricePerMillionInput,
    `${(planner.label || planner.name || key)}: token-planner says $${planner.inputPerMillion} per million input, model-selector says $${selector.pricePerMillionInput}. Two tools on one site cannot disagree about the same published number.`,
  );

  expect(
    'output price agrees',
    planner.outputPerMillion === selector.pricePerMillionOutput,
    `${(planner.label || planner.name || key)}: token-planner says $${planner.outputPerMillion} per million output, model-selector says $${selector.pricePerMillionOutput}.`,
  );
}

console.log(`  models carried by both tools: ${shared.length}`);
for (const key of shared) {
  const p = plannerById.get(key);
  console.log(
    `    ${p.label || p.name || key}: \$${p.inputPerMillion} in, $${p.outputPerMillion} out, agreed by both tools`,
  );
}

/* ---- Confidence labels must not overclaim -------------------------- */

// A row labeled "published" is asserting the number came from a provider
// price list. A row that is actually an estimate must not wear that
// label, because the label is what a visitor uses to decide how much to
// trust the figure.
for (const m of MODEL_CATALOG) {
  expect(
    'confidence label present',
    typeof m.priceConfidence === 'string' && m.priceConfidence.length > 0,
    `${m.name} has no priceConfidence label`,
  );
  expect(
    'source stated',
    typeof m.priceSource === 'string' && m.priceSource.length > 10,
    `${m.name} has no substantive priceSource`,
  );
  if (m.priceConfidence === 'published') {
    expect(
      'published rows cite a real source',
      !/placeholder|extrapolat|not confirmed|guess/i.test(m.priceSource),
      `${m.name} is labeled published but its source text still describes an extrapolation: "${m.priceSource}"`,
    );
  }
}

const labels = [...new Set(MODEL_CATALOG.map((m) => m.priceConfidence))].sort();
console.log(`  confidence labels in use: ${labels.join(', ')}`);

/* ---- Effective dates must be real and not in the future ------------ */

// A future effective date means someone typed a placeholder. Compare
// against a fixed reference rather than the wall clock so this gate is
// deterministic and does not start failing on its own one day.
const REFERENCE_DATE = '2026-07-26';
for (const m of MODEL_CATALOG) {
  expect(
    'effective date format',
    /^\d{4}-\d{2}-\d{2}$/.test(m.priceEffectiveDate || ''),
    `${m.name} has a malformed priceEffectiveDate: ${m.priceEffectiveDate}`,
  );
  expect(
    'effective date not in the future',
    (m.priceEffectiveDate || '') <= REFERENCE_DATE,
    `${m.name} claims an effective date of ${m.priceEffectiveDate}, after the ${REFERENCE_DATE} reference. A future date is a placeholder someone forgot to replace.`,
  );
}

/* ---- Report ------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`CROSS TOOL FACTS: FAILED (${failures})`);
  process.exit(1);
}
console.log('CROSS TOOL FACTS: CLEAN');
