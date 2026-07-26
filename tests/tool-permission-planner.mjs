/**
 * Permission Planner, logic gate.
 *
 * Run: bun tests/tool-permission-planner.mjs
 *
 * Proves the PRD acceptance criteria and the build brief's test list
 * that are properties of the engine rather than of the page:
 *   1. Destructive and externally visible actions cannot be marked low
 *      risk without a warning, even for a synthetic capability the
 *      shipped catalog does not contain.
 *   2. Wildcard access is clearly surfaced.
 *   3. Each of the three named dangerous combinations fires when both
 *      of its parts are present, and does NOT fire when only one is.
 *   4. Blast radius is deterministic: the same trait and config always
 *      produce the same result.
 *   5. Every recommendation carries a real reason.
 *   6. An irreversible, undetectable capability always demands
 *      confirmation, and stops demanding it once either the
 *      irreversibility or the missing confirmation is fixed.
 *   7. At least two realistic samples load and produce findings, one
 *      of them the required email and calendar agent.
 *   8. Export round trips and discloses that this is design guidance,
 *      not certification.
 */

import {
  CAPABILITIES,
  CAPABILITY_IDS,
  SAMPLES,
  computeBlastRadius,
  recommendationsFor,
  warningsFor,
  isWildcardScope,
  findCombos,
  analyze,
  sampleState,
  emptyState,
  defaultConfig,
  validate,
  serialize,
} from '../src/lib/tools/permission-planner.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

console.log('permission-planner logic gate');

/* ---- 1. Catalog shape --------------------------------------------- */
expect('capability count', CAPABILITY_IDS.length === 11, `expected 11 capabilities, got ${CAPABILITY_IDS.length}`);
for (const id of CAPABILITY_IDS) {
  const trait = CAPABILITIES[id];
  expect('trait shape', Boolean(trait?.label && trait?.worstOutcome && trait?.containment), `${id} is missing a required field`);
  expect('trait shape', typeof trait.destructive === 'boolean', `${id} destructive is not boolean`);
  expect('trait shape', typeof trait.externallyVisible === 'boolean', `${id} externallyVisible is not boolean`);
}
console.log(`  capabilities: ${CAPABILITY_IDS.length}`);

/* ---- 2. Destructive or externally visible cannot be low risk ------ */
// A synthetic trait, not one the catalog ships, proves the guard is a
// property of the engine and not a fact that happens to be true of
// the eleven shipped capabilities.
const syntheticDestructive = {
  id: 'read-files',
  label: 'Synthetic destructive capability',
  summary: 'test only',
  targetNoun: 'things',
  worstOutcome: 'test only',
  baselineReversibility: 'reversible',
  baselineDetectability: 'immediate',
  destructive: true,
  externallyVisible: false,
  containment: 'test only',
  supportsDryRun: false,
  canBeMadeReversible: false,
  reversibleApproach: '',
  auditRequirements: [],
};
const forcedBlast = computeBlastRadius(syntheticDestructive, defaultConfig());
expect(
  'forced from low',
  forcedBlast.severity !== 'low' && forcedBlast.forcedFromLow === true,
  `a destructive, otherwise low scoring capability computed severity "${forcedBlast.severity}" with forcedFromLow ${forcedBlast.forcedFromLow}`,
);
const forcedWarnings = warningsFor(syntheticDestructive, defaultConfig(), forcedBlast);
expect(
  'forced from low warning',
  forcedWarnings.some((w) => w.id.endsWith('forced-from-low')),
  'no warning explained why a destructive capability could not be low risk',
);
// The reverse: a fully reversible, immediately detectable, non
// destructive, non external capability should be allowed to be low,
// proving the guard discriminates rather than always firing.
const syntheticBenign = { ...syntheticDestructive, destructive: false, externallyVisible: false };
const benignBlast = computeBlastRadius(syntheticBenign, defaultConfig());
expect('guard discriminates', benignBlast.severity === 'low' && !benignBlast.forcedFromLow, `expected a benign synthetic capability to stay low, got "${benignBlast.severity}"`);
console.log(`  forced-from-low guard: destructive synthetic -> ${forcedBlast.severity}, benign synthetic -> ${benignBlast.severity}`);

/* ---- 3. Wildcard access is clearly surfaced ----------------------- */
expect('wildcard empty', isWildcardScope(''), 'an empty scope must read as wildcard');
expect('wildcard star', isWildcardScope('*'), '"*" must read as wildcard');
expect('wildcard word', isWildcardScope('  ALL  '), '"all" in any case must read as wildcard');
expect('wildcard scoped', !isWildcardScope('src/reports/** only'), 'a real path expression must not read as wildcard');

const wildcardConfig = { ...defaultConfig(), scope: '*' };
const wildcardBlast = computeBlastRadius(CAPABILITIES['read-files'], wildcardConfig);
const wildcardWarnings = warningsFor(CAPABILITIES['read-files'], wildcardConfig, wildcardBlast);
expect('wildcard warning fires', wildcardWarnings.some((w) => w.id.endsWith('wildcard')), 'a wildcard scope produced no wildcard warning');
const scopedConfig = { ...defaultConfig(), scope: 'src/reports/** only' };
const scopedWarnings = warningsFor(CAPABILITIES['read-files'], scopedConfig, computeBlastRadius(CAPABILITIES['read-files'], scopedConfig));
expect('wildcard warning discriminates', !scopedWarnings.some((w) => w.id.endsWith('wildcard')), 'a real allow list still produced a wildcard warning');
console.log('  wildcard access: surfaced when unscoped, silent when scoped');

/* ---- 4. Dangerous combinations, both parts vs one part only ------- */
function blastFor(id, config) {
  return computeBlastRadius(CAPABILITIES[id], config);
}

function selectedSet(ids) {
  return new Set(ids);
}

// Exfiltration: access-secrets + network-egress.
{
  const configs = Object.fromEntries(CAPABILITY_IDS.map((id) => [id, defaultConfig()]));
  const blast = { 'access-secrets': blastFor('access-secrets', configs['access-secrets']), 'network-egress': blastFor('network-egress', configs['network-egress']) };
  const both = findCombos(selectedSet(['access-secrets', 'network-egress']), configs, blast);
  const onlySecrets = findCombos(selectedSet(['access-secrets']), configs, blast);
  const onlyEgress = findCombos(selectedSet(['network-egress']), configs, blast);
  expect('exfiltration fires on both', both.some((c) => c.id === 'exfiltration'), 'secrets plus egress did not trip the exfiltration combo');
  expect('exfiltration silent on secrets alone', !onlySecrets.some((c) => c.id === 'exfiltration'), 'secrets alone tripped the exfiltration combo');
  expect('exfiltration silent on egress alone', !onlyEgress.some((c) => c.id === 'exfiltration'), 'egress alone tripped the exfiltration combo');
}

// Arbitrary code execution: run-shell + network-egress.
{
  const configs = Object.fromEntries(CAPABILITY_IDS.map((id) => [id, defaultConfig()]));
  const blast = { 'run-shell': blastFor('run-shell', configs['run-shell']), 'network-egress': blastFor('network-egress', configs['network-egress']) };
  const both = findCombos(selectedSet(['run-shell', 'network-egress']), configs, blast);
  const onlyShell = findCombos(selectedSet(['run-shell']), configs, blast);
  const onlyEgress = findCombos(selectedSet(['network-egress']), configs, blast);
  expect('arbitrary execution fires on both', both.some((c) => c.id === 'arbitrary-execution'), 'shell plus egress did not trip the arbitrary execution combo');
  expect('arbitrary execution silent on shell alone', !onlyShell.some((c) => c.id === 'arbitrary-execution'), 'shell alone tripped the arbitrary execution combo');
  expect('arbitrary execution silent on egress alone', !onlyEgress.some((c) => c.id === 'arbitrary-execution'), 'egress alone tripped the arbitrary execution combo');
}

// Data loss: write or delete, unconfirmed, and irreversible. All
// three parts must be present; dropping any one clears the combo.
{
  const noConfirmIrreversible = { ...defaultConfig() }; // requiresConfirmation false, reversibleOverride false -> irreversible
  const confirmedIrreversible = { ...defaultConfig(), requiresConfirmation: true };
  const noConfirmReversible = { ...defaultConfig(), reversibleOverride: true }; // delete can be made reversible

  const configsBad = { ...Object.fromEntries(CAPABILITY_IDS.map((id) => [id, defaultConfig()])), delete: noConfirmIrreversible };
  const blastBad = { delete: blastFor('delete', noConfirmIrreversible) };
  const bad = findCombos(selectedSet(['delete']), configsBad, blastBad);
  expect('data loss fires when unconfirmed and irreversible', bad.some((c) => c.id === 'data-loss'), 'an unconfirmed, irreversible delete did not trip the data loss combo');

  const configsConfirmed = { ...Object.fromEntries(CAPABILITY_IDS.map((id) => [id, defaultConfig()])), delete: confirmedIrreversible };
  const blastConfirmed = { delete: blastFor('delete', confirmedIrreversible) };
  const confirmedResult = findCombos(selectedSet(['delete']), configsConfirmed, blastConfirmed);
  expect('data loss silent when confirmed', !confirmedResult.some((c) => c.id === 'data-loss'), 'requiring confirmation should have cleared the data loss combo');

  const configsReversible = { ...Object.fromEntries(CAPABILITY_IDS.map((id) => [id, defaultConfig()])), delete: noConfirmReversible };
  const blastReversible = { delete: blastFor('delete', noConfirmReversible) };
  const reversibleResult = findCombos(selectedSet(['delete']), configsReversible, blastReversible);
  expect('data loss silent when reversible', !reversibleResult.some((c) => c.id === 'data-loss'), 'making the delete reversible should have cleared the data loss combo');
}
console.log('  dangerous combinations: exfiltration, arbitrary execution, and data loss all fire on both parts and clear on one');

/* ---- 5. Blast radius is deterministic ----------------------------- */
{
  const config = { ...defaultConfig(), reversibleOverride: true };
  const first = computeBlastRadius(CAPABILITIES['modify-production'], config);
  const second = computeBlastRadius(CAPABILITIES['modify-production'], config);
  expect('deterministic', JSON.stringify(first) === JSON.stringify(second), 'the same trait and config produced two different results');
}
// Spot check known severities against the fixed trait table, so a
// change to the scoring formula gets caught here rather than only in
// a UI screenshot nobody looked at closely.
const knownSeverities = {
  'call-internal-api': 'low',
  'read-files': 'medium',
  'act-on-behalf': 'medium',
  'write-files': 'high',
  'run-shell': 'high',
  'send-email': 'high',
  'spend-money': 'high',
  'access-secrets': 'high',
  delete: 'critical',
  'network-egress': 'critical',
  'modify-production': 'critical',
};
for (const [id, expected] of Object.entries(knownSeverities)) {
  const blast = computeBlastRadius(CAPABILITIES[id], defaultConfig());
  expect('known severity', blast.severity === expected, `${id} expected "${expected}", got "${blast.severity}"`);
}
console.log(`  blast radius: deterministic, and ${Object.keys(knownSeverities).length} known severities match the trait table`);

/* ---- 6. Every recommendation carries a reason --------------------- */
let recsChecked = 0;
for (const id of CAPABILITY_IDS) {
  const trait = CAPABILITIES[id];
  const config = defaultConfig(); // unscoped defaults trip most of the rules
  const blast = computeBlastRadius(trait, config);
  const recs = recommendationsFor(trait, config, blast);
  for (const r of recs) {
    expect('recommendation has action', Boolean(r.action && r.action.length > 10), `${id} produced a recommendation with no real action`);
    expect('recommendation has reason', Boolean(r.reason && r.reason.length > 20), `${id} produced a recommendation with no substantive reason`);
    recsChecked += 1;
  }
}
expect('recommendations exist', recsChecked > 0, 'no recommendation fired for any capability at default, unscoped config');
console.log(`  recommendations checked, all carrying a reason: ${recsChecked}`);

/* ---- 7. Irreversible and undetectable always demands confirmation - */
// delete is baseline irreversible and silent. Toggling confirmation
// on and off must flip the mandatory warning, and toggling reversible
// override on must also clear it, since a reversible action is no
// longer the case the rule protects against.
{
  const unconfirmed = defaultConfig();
  const unconfirmedBlast = computeBlastRadius(CAPABILITIES.delete, unconfirmed);
  const unconfirmedWarnings = warningsFor(CAPABILITIES.delete, unconfirmed, unconfirmedBlast);
  expect(
    'mandatory confirmation demanded',
    unconfirmedWarnings.some((w) => w.id.endsWith('mandatory-confirmation')),
    'an irreversible, silent capability with no confirmation did not demand one',
  );

  const confirmed = { ...defaultConfig(), requiresConfirmation: true };
  const confirmedBlast = computeBlastRadius(CAPABILITIES.delete, confirmed);
  const confirmedWarnings = warningsFor(CAPABILITIES.delete, confirmed, confirmedBlast);
  expect(
    'mandatory confirmation clears once required',
    !confirmedWarnings.some((w) => w.id.endsWith('mandatory-confirmation')),
    'requiring confirmation should have cleared the mandatory confirmation warning',
  );

  const madeReversible = { ...defaultConfig(), reversibleOverride: true };
  const reversibleBlast = computeBlastRadius(CAPABILITIES.delete, madeReversible);
  const reversibleWarnings = warningsFor(CAPABILITIES.delete, madeReversible, reversibleBlast);
  expect(
    'mandatory confirmation clears once reversible',
    !reversibleWarnings.some((w) => w.id.endsWith('mandatory-confirmation')),
    'making delete reversible should have cleared the mandatory confirmation warning even with no explicit confirmation',
  );
  expect('reversible override actually changes reversibility', reversibleBlast.reversibility !== 'irreversible', 'reversibleOverride had no effect on delete');
}
// access-secrets and network-egress are also baseline irreversible and
// silent, so the same property must hold there too.
for (const id of ['access-secrets', 'network-egress']) {
  const warnings = warningsFor(CAPABILITIES[id], defaultConfig(), computeBlastRadius(CAPABILITIES[id], defaultConfig()));
  expect('mandatory confirmation, other silent irreversible capabilities', warnings.some((w) => w.id.endsWith('mandatory-confirmation')), `${id} is irreversible and silent but did not demand confirmation`);
}
console.log('  mandatory confirmation rule: demanded when irreversible and silent, clears when confirmed or made reversible');

/* ---- 8. Samples load and produce findings ------------------------- */
expect('sample count', SAMPLES.length >= 2, `only ${SAMPLES.length} samples, need at least two`);
expect('email and calendar sample ships', SAMPLES.some((s) => s.id === 'email-calendar-assistant'), 'the required email and calendar agent sample is missing');

for (const sample of SAMPLES) {
  const state = sampleState(sample.id);
  const analysis = analyze(state);
  expect('sample produces findings', analysis.findings.length > 0, `sample ${sample.id} produced no findings`);
  expect('sample validates clean', validate(state).length === 0, `sample ${sample.id} failed validation: ${JSON.stringify(validate(state))}`);
}

const worstCase = analyze(sampleState('cleanup-agent-worst-case'));
expect('worst case trips all three combos', worstCase.combos.length === 3, `expected all three named combinations, got ${worstCase.combos.map((c) => c.id).join(', ')}`);

const emailSample = analyze(sampleState('email-calendar-assistant'));
expect('email sample has a wildcard finding', emailSample.findings.some((f) => f.wildcard), 'the email and calendar sample was supposed to demonstrate a wildcard scope');
expect('email sample triggers no combo', emailSample.combos.length === 0, 'the email and calendar sample should not trip a named combination on its own');

const refundSample = analyze(sampleState('support-refund-agent'));
expect('well scoped sample still states what remains possible', refundSample.findings.every((f) => f.whatRemainsPossible.length > 20), 'a well scoped sample must still be honest about what remains possible');
console.log(`  samples: ${SAMPLES.length} ship, all produce findings, worst case trips ${worstCase.combos.length} combos, email sample trips ${emailSample.combos.length}`);

/* ---- 9. Validation ------------------------------------------------- */
expect('validate empty', validate(emptyState()).some((i) => i.severity === 'error'), 'an empty state produced no error');

/* ---- 10. Export round trip ----------------------------------------- */
{
  const state = sampleState('cleanup-agent-worst-case');
  const json = serialize(state, 'json');
  const parsed = JSON.parse(json);
  expect('export json', parsed.mission === state.mission, 'JSON export lost the mission text');
  expect('export json', Array.isArray(parsed.findings) && parsed.findings.length > 0, 'JSON export has no findings');
  expect('export json', Array.isArray(parsed.dangerousCombinations) && parsed.dangerousCombinations.length === 3, 'JSON export lost the dangerous combinations');
  expect('export json discloses stance', /not legal or security certification/i.test(parsed.note), 'JSON export does not disclose the design guidance boundary');

  const md = serialize(state, 'markdown');
  expect('export markdown', md.includes('# Permission Planner report'), 'markdown export missing header');
  expect('export markdown', md.includes('| Capability | Severity |'), 'markdown export missing the permission matrix table');
  expect('export markdown discloses stance', /not legal or security certification/i.test(md), 'markdown export does not disclose the design guidance boundary');
  console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both disclose the design guidance boundary`);
}

/* ---- Report --------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`PERMISSION PLANNER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('PERMISSION PLANNER LOGIC: CLEAN');
