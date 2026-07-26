/**
 * Permission Planner, logic gate.
 *
 * Run: bun tests/tool-permission-planner.mjs
 *
 * Proves the PRD acceptance criteria and the build brief's test list
 * that are properties of the engine rather than of the page:
 *   1. THE SHARPEST RULE. Marking a destructive action low risk
 *      produces a warning, and so does marking an externally visible
 *      one, and in both cases the declared label survives unchanged:
 *      the tool neither silently accepts nor silently overrules it.
 *   2. Wildcard access is clearly surfaced, and an enumerated scope
 *      does not trip the same warning.
 *   3. Each of the three named dangerous combinations fires when both
 *      of its parts are present, and does NOT fire when only one is,
 *      now proven against the grant list rather than a fixed record.
 *   4. Blast radius (the assessed severity) is deterministic and does
 *      not move when a user changes the declared risk.
 *   5. Every recommendation carries a real reason.
 *   6. An irreversible, undetectable grant always demands confirmation.
 *   7. The required email and calendar sample triggers every category
 *      of finding: a low declared risk, a wildcard, a mandatory
 *      confirmation demand, a low-risk warning on a destructive grant,
 *      and a declared-versus-assessed mismatch.
 *   8. Both export forms round trip and disclose the design-guidance
 *      stance.
 */

import {
  CAPABILITIES,
  CAPABILITY_IDS,
  SAMPLES,
  computeBlastRadius,
  baselineSeverity,
  recommendationsFor,
  warningsFor,
  isWildcardScope,
  findCombos,
  analyze,
  sampleState,
  emptyState,
  defaultGrant,
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
expect('capability count', CAPABILITY_IDS.length === 11, `expected 11 actions, got ${CAPABILITY_IDS.length}`);
for (const id of CAPABILITY_IDS) {
  const trait = CAPABILITIES[id];
  expect('trait shape', Boolean(trait?.action && trait?.worstOutcome && trait?.containment), `${id} is missing a required field`);
  expect('trait shape', typeof trait.destructive === 'boolean', `${id} destructive is not boolean`);
  expect('trait shape', typeof trait.externallyVisible === 'boolean', `${id} externallyVisible is not boolean`);
}
console.log(`  actions: ${CAPABILITY_IDS.length}`);

/* ---- 2. THE SHARPEST RULE: low risk on destructive or external ---- */
// delete is destructive. Declaring it low risk must warn, and the
// declared label must survive exactly as given, neither silently
// accepted nor silently changed.
{
  const grant = { ...defaultGrant('g1', 'delete', 'Some files'), risk: 'low', requiresConfirmation: true, reversibleOverride: true };
  const blast = computeBlastRadius(CAPABILITIES.delete, grant);
  const warnings = warningsFor(CAPABILITIES.delete, grant, blast);
  expect('destructive low risk warns', warnings.some((w) => w.id.endsWith('declared-low-risk')), 'declaring a destructive action low risk produced no warning');
  expect('declared label untouched', grant.risk === 'low', 'the declared risk field was mutated, it must stand as declared');
}
// send-email is externally visible but not destructive. Declaring it
// low risk must also warn, proving the rule covers "or", not only "and".
{
  const grant = { ...defaultGrant('g2', 'send-email', 'Email'), risk: 'low', requiresConfirmation: true };
  const blast = computeBlastRadius(CAPABILITIES['send-email'], grant);
  const warnings = warningsFor(CAPABILITIES['send-email'], grant, blast);
  expect('externally visible low risk warns', warnings.some((w) => w.id.endsWith('declared-low-risk')), 'declaring an externally visible action low risk produced no warning');
}
// call-internal-api is neither destructive nor externally visible.
// Declaring it low risk must NOT warn, proving the rule discriminates
// rather than firing on every low label.
{
  const grant = { ...defaultGrant('g3', 'call-internal-api', 'Read-only endpoint'), risk: 'low' };
  const blast = computeBlastRadius(CAPABILITIES['call-internal-api'], grant);
  const warnings = warningsFor(CAPABILITIES['call-internal-api'], grant, blast);
  expect('neutral action low risk does not warn', !warnings.some((w) => w.id.endsWith('low-risk')), 'a neither destructive nor externally visible action still tripped the low risk warning');
}
// Declaring it medium, high, or critical instead must never warn either,
// since the rule is specifically about the low label.
{
  for (const risk of ['medium', 'high', 'critical']) {
    const grant = { ...defaultGrant('g4', 'delete', 'Some files'), risk };
    const blast = computeBlastRadius(CAPABILITIES.delete, grant);
    const warnings = warningsFor(CAPABILITIES.delete, grant, blast);
    expect('only low triggers the rule', !warnings.some((w) => w.id.endsWith('declared-low-risk')), `declaring delete "${risk}" risk incorrectly tripped the low risk warning`);
  }
}
console.log('  low risk rule: fires on destructive, fires on externally visible, silent on neither, silent above low, label never mutated');

/* ---- 3. Wildcard access is clearly surfaced ----------------------- */
expect('wildcard empty', isWildcardScope(''), 'an empty scope must read as wildcard');
expect('wildcard star', isWildcardScope('*'), '"*" must read as wildcard');
expect('wildcard word', isWildcardScope('  ALL  '), '"all" in any case must read as wildcard');
expect('wildcard scoped', !isWildcardScope('src/reports/** only'), 'a real path expression must not read as wildcard');

{
  const wildcardGrant = { ...defaultGrant('g5', 'read-files', 'Files'), scope: '*' };
  const wildcardBlast = computeBlastRadius(CAPABILITIES['read-files'], wildcardGrant);
  const wildcardWarnings = warningsFor(CAPABILITIES['read-files'], wildcardGrant, wildcardBlast);
  expect('wildcard warning fires', wildcardWarnings.some((w) => w.id.endsWith('wildcard')), 'a wildcard scope produced no wildcard warning');

  const scopedGrant = { ...defaultGrant('g6', 'read-files', 'Files'), scope: 'src/reports/** only' };
  const scopedBlast = computeBlastRadius(CAPABILITIES['read-files'], scopedGrant);
  const scopedWarnings = warningsFor(CAPABILITIES['read-files'], scopedGrant, scopedBlast);
  expect('wildcard warning discriminates', !scopedWarnings.some((w) => w.id.endsWith('wildcard')), 'a real allow list still produced a wildcard warning, so it is not surfaced distinctly from an enumerated scope');
}
console.log('  wildcard access: surfaced when unscoped, silent when a real allow list is enumerated');

/* ---- 4. Dangerous combinations, both parts vs one part only ------- */
// Exfiltration: access-secrets + network-egress, now proven against a
// grant list rather than a fixed record, and against different
// resources sharing the same action.
{
  const secrets = defaultGrant('s1', 'access-secrets', 'API key');
  const egress = defaultGrant('e1', 'network-egress', 'Webhook');
  const both = findCombos([secrets, egress]);
  const onlySecrets = findCombos([secrets]);
  const onlyEgress = findCombos([egress]);
  expect('exfiltration fires on both', both.some((c) => c.id === 'exfiltration'), 'secrets plus egress did not trip the exfiltration combo');
  expect('exfiltration silent on secrets alone', !onlySecrets.some((c) => c.id === 'exfiltration'), 'secrets alone tripped the exfiltration combo');
  expect('exfiltration silent on egress alone', !onlyEgress.some((c) => c.id === 'exfiltration'), 'egress alone tripped the exfiltration combo');
  expect('exfiltration names its grants', both.find((c) => c.id === 'exfiltration').triggeringGrants.length === 2, 'the exfiltration finding did not name the specific grants responsible');
}

// Arbitrary code execution: run-shell + network-egress.
{
  const shell = defaultGrant('sh1', 'run-shell', 'Host');
  const egress = defaultGrant('e2', 'network-egress', 'Webhook');
  const both = findCombos([shell, egress]);
  const onlyShell = findCombos([shell]);
  const onlyEgress = findCombos([egress]);
  expect('arbitrary execution fires on both', both.some((c) => c.id === 'arbitrary-execution'), 'shell plus egress did not trip the arbitrary execution combo');
  expect('arbitrary execution silent on shell alone', !onlyShell.some((c) => c.id === 'arbitrary-execution'), 'shell alone tripped the arbitrary execution combo');
  expect('arbitrary execution silent on egress alone', !onlyEgress.some((c) => c.id === 'arbitrary-execution'), 'egress alone tripped the arbitrary execution combo');
}

// Data loss: an unconfirmed, irreversible write or delete. Dropping
// either the missing confirmation or the irreversibility must clear it.
{
  const bad = defaultGrant('d1', 'delete', 'Project files'); // unconfirmed, irreversible by default
  expect('data loss fires when unconfirmed and irreversible', findCombos([bad]).some((c) => c.id === 'data-loss'), 'an unconfirmed, irreversible delete did not trip the data loss combo');

  const confirmed = { ...defaultGrant('d2', 'delete', 'Project files'), requiresConfirmation: true };
  expect('data loss silent when confirmed', !findCombos([confirmed]).some((c) => c.id === 'data-loss'), 'requiring confirmation should have cleared the data loss combo');

  const reversible = { ...defaultGrant('d3', 'delete', 'Project files'), reversibleOverride: true };
  expect('data loss silent when reversible', !findCombos([reversible]).some((c) => c.id === 'data-loss'), 'making the delete reversible should have cleared the data loss combo');

  // Two different resources under the same action: only the offending
  // one should be named.
  const safe = { ...defaultGrant('d4', 'delete', 'Trash-bound files'), reversibleOverride: true };
  const mixed = findCombos([bad, safe]).find((c) => c.id === 'data-loss');
  expect('data loss names only the offending grant', mixed.triggeringGrants.length === 1 && mixed.triggeringGrants[0].grantId === 'd1', 'the data loss finding should name only the unconfirmed, irreversible grant, not the safely configured one');
}
console.log('  dangerous combinations: exfiltration, arbitrary execution, and data loss all fire on both parts, clear on one, and name the specific grants responsible');

/* ---- 5. Blast radius is deterministic, independent of declared risk */
{
  const grant = { ...defaultGrant('m1', 'modify-production', 'Prod'), reversibleOverride: true };
  const first = computeBlastRadius(CAPABILITIES['modify-production'], grant);
  const second = computeBlastRadius(CAPABILITIES['modify-production'], grant);
  expect('deterministic', JSON.stringify(first) === JSON.stringify(second), 'the same trait and grant produced two different results');

  const sameGrantDifferentDeclared = { ...grant, risk: 'low' };
  const thirdAssessment = computeBlastRadius(CAPABILITIES['modify-production'], sameGrantDifferentDeclared);
  expect('assessed severity ignores declared risk', thirdAssessment.severity === first.severity, 'changing the declared risk moved the assessed severity, which must stay an objective computation');
}
// Spot check known baseline severities against the fixed trait table.
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
  expect('known baseline severity', baselineSeverity(CAPABILITIES[id]) === expected, `${id} expected "${expected}", got "${baselineSeverity(CAPABILITIES[id])}"`);
}
console.log(`  blast radius: deterministic, immune to the declared label, and ${Object.keys(knownSeverities).length} known baseline severities match the trait table`);

/* ---- 6. Every recommendation carries a reason ---------------------- */
let recsChecked = 0;
for (const id of CAPABILITY_IDS) {
  const trait = CAPABILITIES[id];
  const grant = defaultGrant(`rec-${id}`, id, `Test resource for ${id}`);
  const blast = computeBlastRadius(trait, grant);
  const recs = recommendationsFor(trait, grant, blast);
  for (const r of recs) {
    expect('recommendation has action', Boolean(r.action && r.action.length > 10), `${id} produced a recommendation with no real action`);
    expect('recommendation has reason', Boolean(r.reason && r.reason.length > 20), `${id} produced a recommendation with no substantive reason`);
    recsChecked += 1;
  }
}
expect('recommendations exist', recsChecked > 0, 'no recommendation fired for any action at default, unscoped config');
// Approval and escalation rules are first class: a high risk grant
// missing either one must be told so, and stating both must clear it.
{
  const highRiskGrant = { ...defaultGrant('r1', 'spend-money', 'Vendor payouts'), risk: 'high' };
  const recs = recommendationsFor(CAPABILITIES['spend-money'], highRiskGrant, computeBlastRadius(CAPABILITIES['spend-money'], highRiskGrant));
  expect('missing approval rule flagged', recs.some((r) => /approves/i.test(r.action)), 'a high risk grant with no approval rule was not flagged');
  expect('missing escalation rule flagged', recs.some((r) => /escalation/i.test(r.action)), 'a high risk grant with no escalation rule was not flagged');

  const filledGrant = { ...highRiskGrant, approvalRule: 'Finance approves.', escalationRule: 'Escalate to finance on-call.' };
  const filledRecs = recommendationsFor(CAPABILITIES['spend-money'], filledGrant, computeBlastRadius(CAPABILITIES['spend-money'], filledGrant));
  expect('approval rule clears once stated', !filledRecs.some((r) => /approves/i.test(r.action)), 'stating an approval rule should have cleared the recommendation');
  expect('escalation rule clears once stated', !filledRecs.some((r) => /escalation/i.test(r.action)), 'stating an escalation rule should have cleared the recommendation');
}
// High sensitivity data paired with full autonomy must be flagged.
{
  const autonomousSensitive = { ...defaultGrant('r2', 'read-files', 'Medical records'), dataSensitivity: 'high', autonomyLevel: 'acts-autonomously' };
  const recs = recommendationsFor(CAPABILITIES['read-files'], autonomousSensitive, computeBlastRadius(CAPABILITIES['read-files'], autonomousSensitive));
  expect('high sensitivity plus full autonomy flagged', recs.some((r) => /autonomy/i.test(r.action)), 'high data sensitivity combined with full autonomy was not flagged');
}
console.log(`  recommendations checked, all carrying a reason: ${recsChecked}, plus approval, escalation, and autonomy rules verified first class`);

/* ---- 7. Irreversible and undetectable always demands confirmation - */
{
  const unconfirmed = defaultGrant('c1', 'delete', 'Backups');
  const unconfirmedWarnings = warningsFor(CAPABILITIES.delete, unconfirmed, computeBlastRadius(CAPABILITIES.delete, unconfirmed));
  expect('mandatory confirmation demanded', unconfirmedWarnings.some((w) => w.id.endsWith('mandatory-confirmation')), 'an irreversible, silent grant with no confirmation did not demand one');

  const confirmed = { ...defaultGrant('c2', 'delete', 'Backups'), requiresConfirmation: true };
  const confirmedWarnings = warningsFor(CAPABILITIES.delete, confirmed, computeBlastRadius(CAPABILITIES.delete, confirmed));
  expect('mandatory confirmation clears once required', !confirmedWarnings.some((w) => w.id.endsWith('mandatory-confirmation')), 'requiring confirmation should have cleared the mandatory confirmation warning');

  const madeReversible = { ...defaultGrant('c3', 'delete', 'Backups'), reversibleOverride: true };
  const reversibleBlast = computeBlastRadius(CAPABILITIES.delete, madeReversible);
  const reversibleWarnings = warningsFor(CAPABILITIES.delete, madeReversible, reversibleBlast);
  expect('mandatory confirmation clears once reversible', !reversibleWarnings.some((w) => w.id.endsWith('mandatory-confirmation')), 'making delete reversible should have cleared the mandatory confirmation warning even with no explicit confirmation');
  expect('reversible override actually changes reversibility', reversibleBlast.reversibility !== 'irreversible', 'reversibleOverride had no effect on delete');
}
for (const id of ['access-secrets', 'network-egress']) {
  const grant = defaultGrant(`c-${id}`, id, 'Test resource');
  const warnings = warningsFor(CAPABILITIES[id], grant, computeBlastRadius(CAPABILITIES[id], grant));
  expect('mandatory confirmation, other silent irreversible actions', warnings.some((w) => w.id.endsWith('mandatory-confirmation')), `${id} is irreversible and silent but did not demand confirmation`);
}
console.log('  mandatory confirmation rule: demanded when irreversible and silent, clears when confirmed or made reversible');

/* ---- 8. Samples load and produce findings -------------------------- */
expect('sample count', SAMPLES.length >= 2, `only ${SAMPLES.length} samples, need at least two`);
expect('email and calendar sample ships', SAMPLES.some((s) => s.id === 'email-calendar-assistant'), 'the required email and calendar agent sample is missing');

for (const sample of SAMPLES) {
  const state = sampleState(sample.id);
  const analysis = analyze(state);
  expect('sample produces findings', analysis.findings.length > 0, `sample ${sample.id} produced no findings`);
}

const worstCase = analyze(sampleState('cleanup-agent-worst-case'));
expect('worst case trips all three combos', worstCase.combos.length === 3, `expected all three named combinations, got ${worstCase.combos.map((c) => c.id).join(', ')}`);

// The email and calendar sample is specified to demonstrate every rule
// in the tool at once: reading the calendar is low risk, reading the
// inbox is sensitive and unscoped, sending mail is inherently
// irreversible and externally visible, and deleting an event is
// destructive but made recoverable, declared low risk anyway to prove
// the low-risk warning fires on a real, sympathetic mistake.
const emailAnalysis = analyze(sampleState('email-calendar-assistant'));
const byResource = (name) => emailAnalysis.findings.find((f) => f.grant.resource === name);

expect('calendar read declared low risk', byResource('Calendar events')?.grant.risk === 'low', 'the calendar read grant should be declared low risk');
expect('calendar read carries no low-risk warning', !byResource('Calendar events').warnings.some((w) => w.id.endsWith('low-risk')), 'reading the calendar is neither destructive nor externally visible and must not trip the low risk warning');

expect('inbox read is high sensitivity', byResource('Email inbox')?.grant.dataSensitivity === 'high', 'the inbox read grant should be declared high data sensitivity, unlike the calendar read');
expect('inbox read is wildcard', byResource('Email inbox')?.wildcard === true, 'the inbox read grant was supposed to demonstrate a wildcard scope');

const sendGrant = byResource('Email');
expect('send email is inherently irreversible', sendGrant?.blast.reversibility === 'irreversible', 'sending email should assess as irreversible regardless of configuration');
expect('send email is inherently externally visible', sendGrant?.blast.externallyVisible === true, 'sending email should assess as externally visible');

const deleteGrant = byResource('Calendar event');
expect('calendar delete is destructive', deleteGrant?.blast.destructive === true, 'deleting a calendar event should assess as destructive regardless of recoverability');
expect('calendar delete declared low risk on purpose', deleteGrant?.grant.risk === 'low', 'the calendar delete grant should be declared low risk to demonstrate the low risk warning on a destructive action');
expect('calendar delete trips the low risk warning', deleteGrant?.warnings.some((w) => w.id.endsWith('declared-low-risk')), 'a destructive delete declared low risk must trip the low risk warning even though it was made recoverable');

const secretGrant = byResource('Mailbox OAuth token');
expect('mailbox secret trips mandatory confirmation', secretGrant?.warnings.some((w) => w.id.endsWith('mandatory-confirmation')), 'the mailbox secret grant should be irreversible, silent, and unconfirmed');

expect('email sample triggers no named combo', emailAnalysis.combos.length === 0, 'the email and calendar sample should not trip a named dangerous combination on its own');
expect('email sample has a risk mismatch', emailAnalysis.riskMismatchCount > 0, 'the email and calendar sample should show at least one grant where declared risk differs from assessed severity');
console.log(
  `  email and calendar sample: low risk calendar read, sensitive wildcard inbox read, inherently irreversible and external send, destructive-but-recoverable delete that still warns on a low declaration, mandatory confirmation on the mailbox secret, zero named combos, ${emailAnalysis.riskMismatchCount} declared/assessed mismatch(es)`,
);

/* ---- 9. Validation --------------------------------------------------- */
expect('validate empty', validate(emptyState()).some((i) => i.severity === 'error'), 'an empty state produced no error');
for (const sample of SAMPLES) {
  expect('validate sample', validate(sampleState(sample.id)).every((i) => i.severity !== 'error'), `sample ${sample.id} failed validation with an error`);
}
{
  const state = { mission: 'Test', grants: [{ ...defaultGrant('v1', 'read-files', '') }], scenarioId: '' };
  expect('validate flags unnamed resource', validate(state).some((i) => i.field.includes('resource')), 'a grant with no resource named should produce a validation warning');
}

/* ---- 10. Export round trip -------------------------------------------- */
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
  expect('export markdown', md.includes('| Action | Resource | Declared risk |'), 'markdown export missing the resource by action permission matrix table');
  expect('export markdown discloses stance', /not legal or security certification/i.test(md), 'markdown export does not disclose the design guidance boundary');

  // Both forms round trip for the email and calendar sample too, since
  // that is the one required to demonstrate every rule at once.
  const emailState = sampleState('email-calendar-assistant');
  const emailJson = JSON.parse(serialize(emailState, 'json'));
  const emailMd = serialize(emailState, 'markdown');
  expect('email sample json round trips', emailJson.findings.length === emailState.grants.length, 'JSON export lost grants from the email and calendar sample');
  expect('email sample markdown round trips', emailMd.includes('Email inbox') && emailMd.includes('Calendar events'), 'markdown export lost resources from the email and calendar sample');

  console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both forms round trip for the worst case and the email and calendar sample`);
}

/* ---- Report --------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`PERMISSION PLANNER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('PERMISSION PLANNER LOGIC: CLEAN');
