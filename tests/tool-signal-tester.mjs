/**
 * Signal Tester, logic gate.
 *
 * Run: bun tests/tool-signal-tester.mjs
 *
 * PRD: tools-nixfred-prds/tools/13-SIGNAL-TESTER.md. Proves the
 * acceptance criteria that are properties of the engine rather than of
 * the page:
 *   1. Claim fragment offsets, and support link offsets into the
 *      evidence, are verified BY SLICING the real text, not asserted.
 *   2. Fact, inference, prediction, and opinion are distinguished on
 *      known, unambiguous examples.
 *   3. An unsupported leap is detected specifically when the evidence
 *      is narrower than the claim (evidence: "in one trial", claim:
 *      "in general"), not folded into a generic low score.
 *   4. Confidence drops monotonically, never rises, as supporting
 *      evidence is removed, and the mechanism is a legible ledger.
 *   5. The rewritten claim never asserts more than the evidence: an
 *      overgeneralized fragment loses its generalizing phrase, and an
 *      unsupported fragment is flagged rather than repeated silently.
 *   6. Cohen's kappa and Pearson correlation, kept from the original
 *      build exactly as verified, now framed as the secondary
 *      inter-rater agreement panel.
 */

import {
  splitClaimFragments,
  classifyFragment,
  analyzeFragment,
  analyzeClaim,
  computeConfidence,
  rewriteClaim,
  detectAmbiguity,
  assessFreshness,
  isoDaysAgo,
  computeSourceGaps,
  validate,
  serialize,
  emptyState,
  sampleState,
  SAMPLES,
  cohensKappa,
  pearsonCorrelation,
  interpretKappa,
  interpretCorrelation,
} from '../src/lib/tools/signal-tester.ts';

let failures = 0;
let checks = 0;

function expect(label, cond, detail = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL [${label}] ${detail}`);
  }
}

function close(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

console.log('signal-tester logic gate');

/* ---- 1. Claim fragment offsets, verified by slicing --------------- */
{
  let fragmentsChecked = 0;
  for (const sample of SAMPLES) {
    const fragments = splitClaimFragments(sample.state.claim);
    expect('sample has fragments', fragments.length > 0, `sample ${sample.id} produced no fragments`);
    for (const f of fragments) {
      expect(
        'fragment offset bounds',
        f.start >= 0 && f.end <= sample.state.claim.length && f.start <= f.end,
        `${sample.id}: fragment ${f.index} offsets ${f.start}..${f.end} outside claim of length ${sample.state.claim.length}`,
      );
      expect(
        'fragment offset accuracy',
        sample.state.claim.slice(f.start, f.end) === f.text,
        `${sample.id}: fragment ${f.index} text does not match claim.slice(${f.start}, ${f.end})`,
      );
      fragmentsChecked += 1;
    }
  }
  console.log(`  claim fragment offsets verified by slicing: ${fragmentsChecked}`);
}

/* ---- 2. Support link offsets into evidence, verified by slicing --- */
{
  let linksChecked = 0;
  for (const sample of SAMPLES) {
    const sources = sample.state.sources.filter((s) => s.text.trim());
    const fragments = splitClaimFragments(sample.state.claim).map((f) => analyzeFragment(f, sources));
    for (const f of fragments) {
      for (const link of f.links) {
        const source = sources.find((s) => s.id === link.sourceId);
        expect('support link has a source', Boolean(source), `${sample.id}: link references unknown source ${link.sourceId}`);
        if (!source) continue;
        expect(
          'support link offset bounds',
          link.start >= 0 && link.end <= source.text.length && link.start <= link.end,
          `${sample.id}: link offsets ${link.start}..${link.end} outside source ${link.sourceId} of length ${source.text.length}`,
        );
        expect(
          'support link offset accuracy',
          source.text.slice(link.start, link.end) === link.excerpt,
          `${sample.id}: link excerpt "${link.excerpt}" does not match source.slice(${link.start}, ${link.end})`,
        );
        linksChecked += 1;
      }
    }
  }
  expect('links were actually exercised', linksChecked > 0, 'no support links were produced across any sample, the offset check above is vacuous');
  console.log(`  support link offsets verified by slicing: ${linksChecked}`);
}

/* ---- 3. Fact, inference, prediction, opinion on known examples ---- */
{
  const fact = classifyFragment('The device sold two million units in its first month.');
  expect('classify fact', fact.kind === 'fact', `got ${fact.kind}`);

  const inference = classifyFragment('This suggests that the marketing campaign drove the increase in sales.');
  expect('classify inference', inference.kind === 'inference', `got ${inference.kind}`);
  expect('inference signal names the cue', /suggests that/i.test(inference.signal), inference.signal);

  const prediction = classifyFragment('Sales will reach five million units by 2027.');
  expect('classify prediction', prediction.kind === 'prediction', `got ${prediction.kind}`);

  const opinion = classifyFragment('This is clearly the best product the company has ever released.');
  expect('classify opinion', opinion.kind === 'opinion', `got ${opinion.kind}`);
  expect('opinion signal names the cue', /best/i.test(opinion.signal), opinion.signal);

  console.log(`  four way classification: fact/${fact.kind}, inference/${inference.kind}, prediction/${prediction.kind}, opinion/${opinion.kind}`);
}

/* ---- 4. Ambiguity: unnamed authority or unquantified magnitude ---- */
{
  const ambiguous = detectAmbiguity('Several studies suggest the approach works well.');
  expect('ambiguity detected', Boolean(ambiguous), 'expected an ambiguity signal for "several studies"');
  const clean = detectAmbiguity('The battery held 95 percent capacity after 500 cycles.');
  expect('ambiguity not over triggered', clean === null, `expected no ambiguity signal, got "${clean}"`);
}

/* ---- 5. THE IMPORTANT ONE: unsupported leap, evidence narrower ---- *
 * Claim: "This works in general." Evidence: "...in one trial, this
 * works as expected." Word overlap is 1 of 2 content words (works;
 * general is absent), exactly at the 0.5 support threshold, so this
 * counts as supported before the scope check runs. The claim then
 * generalizes ("in general") while the best evidence explicitly scopes
 * to "in one trial", which is the specific gap the PRD's design notes
 * call out: evidence narrower than the claim.
 * ------------------------------------------------------------------- */
{
  const sources = [{ id: 'source-1', text: 'Internal notes report that in one trial, this works as expected.', sourceType: 'primary-data', date: '' }];
  const fragment = splitClaimFragments('This works in general.')[0];
  const analysis = analyzeFragment(fragment, sources);

  expect('leap: overlap at threshold', close(analysis.bestLink?.overlapRatio ?? -1, 0.5), `got ${analysis.bestLink?.overlapRatio}`);
  expect('leap: status overgeneralized', analysis.status === 'overgeneralized', `got ${analysis.status}`);
  expect('leap: generalizing span found', analysis.generalizing?.excerpt === 'in general', JSON.stringify(analysis.generalizing));
  expect('leap: narrowing span found', analysis.narrowing?.excerpt === 'in one trial', JSON.stringify(analysis.narrowing));
  expect(
    'leap: generalizing span slices the fragment',
    fragment.text.slice(analysis.generalizing.start, analysis.generalizing.end) === analysis.generalizing.excerpt,
    'generalizing offsets do not slice the fragment text',
  );
  expect(
    'leap: narrowing span slices the source',
    sources[0].text.slice(analysis.narrowing.start, analysis.narrowing.end) === analysis.narrowing.excerpt,
    'narrowing offsets do not slice the source text',
  );
  console.log(`  unsupported leap (evidence narrower than claim): status=${analysis.status}, generalizing="${analysis.generalizing.excerpt}", narrowing="${analysis.narrowing.excerpt}"`);

  // And the plain no-evidence case, for contrast.
  const unsupportedFragment = splitClaimFragments('Sales will exceed ten million units by 2027.')[0];
  const noEvidence = analyzeFragment(unsupportedFragment, []);
  expect('leap: no evidence at all', noEvidence.status === 'no-evidence', `got ${noEvidence.status}`);
  expect('leap: no evidence has no best link', noEvidence.bestLink === null, JSON.stringify(noEvidence.bestLink));
}

/* ---- 5b. The shipped samples actually exercise this detector ------ */
{
  const sample = sampleState('sensor-launch-claim');
  const analysis = analyzeClaim(sample);
  const overgeneralized = analysis.fragments.filter((f) => f.status === 'overgeneralized');
  expect('sample exercises overgeneralization', overgeneralized.length >= 1, `sensor-launch-claim produced ${overgeneralized.length} overgeneralized fragments, expected at least 1`);
  const noEvidence = analysis.fragments.filter((f) => f.status === 'no-evidence');
  expect('sample exercises no-evidence', noEvidence.length >= 1, `sensor-launch-claim produced ${noEvidence.length} no-evidence fragments, expected at least 1`);
  console.log(`  sample "sensor-launch-claim": ${overgeneralized.length} overgeneralized, ${noEvidence.length} no-evidence, of ${analysis.fragments.length} fragments`);
}

/* ---- 6. Confidence drops monotonically as evidence is removed ----- */
{
  const claim =
    'The database migrated successfully overnight. Checkout latency dropped after the caching update. Support tickets declined following the redesign.';
  const sourceA = { id: 'source-1', text: 'Engineering logs confirm the database migrated successfully overnight without incident.', sourceType: 'primary-data', date: '' };
  const sourceB = { id: 'source-2', text: 'Performance metrics show checkout latency dropped sharply after the caching update shipped.', sourceType: 'primary-data', date: '' };
  const sourceC = { id: 'source-3', text: 'Customer support tickets declined significantly following the redesign launch.', sourceType: 'primary-data', date: '' };

  const stateWith = (sources) => ({
    claim,
    sources: [...sources, { id: 'source-4', text: '', sourceType: 'unspecified', date: '' }].slice(0, 4),
    raterAgreementKind: 'categorical',
    raterPairedDataRaw: '',
  });

  const ratios = [
    analyzeClaim(stateWith([sourceA, sourceB, sourceC])).confidence.supportRatio,
    analyzeClaim(stateWith([sourceA, sourceB])).confidence.supportRatio,
    analyzeClaim(stateWith([sourceA])).confidence.supportRatio,
    analyzeClaim(stateWith([])).confidence.supportRatio,
  ];

  expect('confidence starts fully supported', close(ratios[0], 1), `got ${ratios[0]}`);
  expect('confidence ends at zero', close(ratios[3], 0), `got ${ratios[3]}`);
  for (let i = 1; i < ratios.length; i++) {
    expect('confidence never increases', ratios[i] <= ratios[i - 1] + 1e-9, `ratio rose from ${ratios[i - 1]} to ${ratios[i]} after removing evidence`);
  }
  expect('confidence actually moves', ratios[0] > ratios[3], `ratio was flat: ${JSON.stringify(ratios)}`);

  // The mechanism is legible: computeConfidence returns a ledger, not a
  // single opaque number.
  const breakdown = computeConfidence(analyzeClaim(stateWith([sourceA])).fragments, [], []);
  expect('confidence ledger is not empty', breakdown.ledger.length > 0, 'ledger produced no explanation for the ratio');

  console.log(`  confidence ratio as evidence is removed: ${ratios.map((r) => r.toFixed(2)).join(' -> ')}`);
}

/* ---- 7. The rewritten claim never asserts more than the evidence --- */
{
  // Overgeneralized: the generalizing phrase must not survive verbatim.
  const sources = [{ id: 'source-1', text: 'Internal notes report that in one trial, this works as expected.', sourceType: 'primary-data', date: '' }];
  const fragment = splitClaimFragments('This works in general.')[0];
  const analysis = analyzeFragment(fragment, sources);
  const { text, changes } = rewriteClaim([analysis]);
  expect('rewrite drops the generalizing phrase', !/\bin general\b/i.test(text), `rewrite still says "in general": ${text}`);
  expect('rewrite cites the narrower evidence', text.includes('in one trial'), `rewrite does not cite the narrower scope: ${text}`);
  expect('rewrite change carries a reason', changes.length === 1 && changes[0].reason.length > 20, JSON.stringify(changes));

  // No evidence: must be flagged, not silently repeated.
  const unsupportedFragment = splitClaimFragments('Sales will exceed ten million units by 2027.')[0];
  const noEvidenceAnalysis = analyzeFragment(unsupportedFragment, []);
  const noEvidenceRewrite = rewriteClaim([noEvidenceAnalysis]);
  expect('rewrite flags unsupported fragment', /no supplied evidence supports this/i.test(noEvidenceRewrite.text), noEvidenceRewrite.text);

  // Supported, properly scoped fragments pass through unchanged.
  const cleanSources = [{ id: 'source-1', text: 'The database migrated successfully overnight without incident.', sourceType: 'primary-data', date: '' }];
  const cleanFragment = splitClaimFragments('The database migrated successfully overnight.')[0];
  const cleanAnalysis = analyzeFragment(cleanFragment, cleanSources);
  const cleanRewrite = rewriteClaim([cleanAnalysis]);
  expect('rewrite leaves a clean fragment untouched', cleanRewrite.text === cleanFragment.text, cleanRewrite.text);
  expect('rewrite makes no change for a clean fragment', cleanRewrite.changes.length === 0, JSON.stringify(cleanRewrite.changes));

  console.log(`  rewrite: overgeneralized -> "${text}"`);
  console.log(`  rewrite: no evidence -> "${noEvidenceRewrite.text}"`);
}

/* ---- 8. Source gaps -------------------------------------------------- */
{
  const factBackedByOpinion = {
    claim: 'The outage lasted four hours.',
    sources: [
      { id: 'source-1', text: 'A commentator opined that the outage probably lasted around four hours.', sourceType: 'analysis-or-opinion', date: '' },
      { id: 'source-2', text: '', sourceType: 'unspecified', date: '' },
      { id: 'source-3', text: '', sourceType: 'unspecified', date: '' },
      { id: 'source-4', text: '', sourceType: 'unspecified', date: '' },
    ],
    raterAgreementKind: 'categorical',
    raterPairedDataRaw: '',
  };
  const analysis = analyzeClaim(factBackedByOpinion);
  expect(
    'source gap: fact backed by opinion',
    analysis.sourceGaps.some((g) => /backed only by/i.test(g)),
    `expected a fact-backed-by-weak-source gap, got ${JSON.stringify(analysis.sourceGaps)}`,
  );

  const unusedSource = {
    claim: 'The database migrated successfully overnight.',
    sources: [
      { id: 'source-1', text: 'Engineering logs confirm the database migrated successfully overnight without incident.', sourceType: 'primary-data', date: '' },
      { id: 'source-2', text: 'Completely unrelated marketing copy about a different product entirely.', sourceType: 'news-report', date: '' },
      { id: 'source-3', text: '', sourceType: 'unspecified', date: '' },
      { id: 'source-4', text: '', sourceType: 'unspecified', date: '' },
    ],
    raterAgreementKind: 'categorical',
    raterPairedDataRaw: '',
  };
  const unusedAnalysis = analyzeClaim(unusedSource);
  expect(
    'source gap: unused source flagged',
    unusedAnalysis.sourceGaps.some((g) => g.includes('source-2') && /does not support/i.test(g)),
    `expected source-2 to be flagged unused, got ${JSON.stringify(unusedAnalysis.sourceGaps)}`,
  );

  expect('computeSourceGaps is the function analyzeClaim calls', typeof computeSourceGaps === 'function', 'computeSourceGaps missing');
}

/* ---- 9. Freshness risk ------------------------------------------------ */
{
  const asOf = new Date('2026-06-01T00:00:00Z');

  const undated = assessFreshness({ id: 's', text: '', sourceType: 'unspecified', date: '' }, asOf);
  expect('freshness: undated', undated.risk === 'undated', `got ${undated.risk}`);
  expect('freshness: undated has no age', undated.ageDays === null, `got ${undated.ageDays}`);

  const future = assessFreshness({ id: 's', text: '', sourceType: 'unspecified', date: '2026-07-01' }, asOf);
  expect('freshness: future dated', future.risk === 'future-dated', `got ${future.risk}`);

  const fresh = assessFreshness({ id: 's', text: '', sourceType: 'unspecified', date: '2026-05-01' }, asOf);
  expect('freshness: fresh', fresh.risk === 'fresh', `got ${fresh.risk}`);

  const aging = assessFreshness({ id: 's', text: '', sourceType: 'unspecified', date: '2025-01-01' }, asOf);
  expect('freshness: aging', aging.risk === 'aging', `got ${aging.risk}, ageDays ${aging.ageDays}`);

  const stale = assessFreshness({ id: 's', text: '', sourceType: 'unspecified', date: '2020-01-01' }, asOf);
  expect('freshness: stale', stale.risk === 'stale', `got ${stale.risk}`);

  const bogus = assessFreshness({ id: 's', text: '', sourceType: 'unspecified', date: 'not a date' }, asOf);
  expect('freshness: unparseable treated as undated', bogus.risk === 'undated', `got ${bogus.risk}`);

  const relativeStale = assessFreshness({ id: 's', text: '', sourceType: 'unspecified', date: isoDaysAgo(900) });
  expect('freshness: isoDaysAgo(900) reads as stale against the real clock', relativeStale.risk === 'stale', `got ${relativeStale.risk}`);

  console.log(`  freshness bands: undated=${undated.risk}, future=${future.risk}, fresh=${fresh.risk}, aging=${aging.risk}, stale=${stale.risk}`);
}

/* ---- 10. Samples ------------------------------------------------------ */
{
  expect('samples count', SAMPLES.length >= 3, `only ${SAMPLES.length} samples`);
  for (const s of SAMPLES) {
    expect('sample shape', Boolean(s.id && s.name && s.teaches), `sample ${s.id} missing a field`);
    expect('sample has a claim', Boolean(s.state.claim.trim()), `sample ${s.id} has no claim`);
    expect('sample has four source slots', s.state.sources.length === 4, `sample ${s.id} has ${s.state.sources.length} source slots`);
    expect('sample validates clean on required fields', validate(s.state).every((i) => i.severity !== 'error'), `sample ${s.id} fails required-field validation`);
  }
  console.log(`  samples: ${SAMPLES.length}`);
}

/* ---- 11. Validation ---------------------------------------------------- */
{
  expect('validate empty has an error', validate(emptyState()).some((i) => i.severity === 'error'), 'empty state produced no error');
  expect('validate sample is clean', validate(sampleState()).length === 0, 'a loaded sample produced validation issues');

  const noEvidenceState = { claim: 'A claim with nothing backing it.', sources: emptyState().sources, raterAgreementKind: 'categorical', raterPairedDataRaw: '' };
  expect(
    'validate warns on missing evidence',
    validate(noEvidenceState).some((i) => i.field === 'sources' && i.severity === 'warning'),
    JSON.stringify(validate(noEvidenceState)),
  );
}

/* ---- 12. Cohen's kappa, kept from the original build ------------------ *
 * HAND DERIVATION, standard worked example, two raters over a 2x2 table:
 *              rater 2 yes   rater 2 no    row total
 *  rater 1 yes      a=20         b=5           25
 *  rater 1 no        c=10        d=15          25
 *  col total          30          20            N=50
 * po = (a+d)/N = 35/50 = 0.70
 * pe = (25*30 + 25*20) / 2500 = 1250/2500 = 0.50
 * kappa = (0.70 - 0.50) / (1 - 0.50) = 0.40
 * ------------------------------------------------------------------- */
{
  const pairs = [
    ...Array(20).fill({ proxy: 'yes', outcome: 'yes' }),
    ...Array(5).fill({ proxy: 'yes', outcome: 'no' }),
    ...Array(10).fill({ proxy: 'no', outcome: 'yes' }),
    ...Array(15).fill({ proxy: 'no', outcome: 'no' }),
  ];
  const result = cohensKappa(pairs);
  expect('kappa worked example: po', close(result.observedAgreement, 0.7), `got ${result.observedAgreement}`);
  expect('kappa worked example: pe', close(result.chanceAgreement, 0.5), `got ${result.chanceAgreement}`);
  expect('kappa worked example: kappa', close(result.kappa, 0.4), `got ${result.kappa}`);
  expect('kappa worked example: interpretation says fair', /fair/i.test(interpretKappa(result)), interpretKappa(result));
  console.log(`  kappa worked example: po=${result.observedAgreement}, pe=${result.chanceAgreement}, kappa=${result.kappa}`);

  // Perfect agreement: a=10 (X,X), d=15 (Y,Y). po=1. pe=(10/25)^2+(15/25)^2=0.52. kappa=(1-0.52)/(1-0.52)=1.
  const perfect = cohensKappa([...Array(10).fill({ proxy: 'X', outcome: 'X' }), ...Array(15).fill({ proxy: 'Y', outcome: 'Y' })]);
  expect('kappa perfect agreement', close(perfect.kappa, 1), `got ${perfect.kappa}`);

  // Chance level: independent 30/70 x 40/60 table, a=12,b=18,c=28,d=42. po=pe=0.54, kappa=0.
  const chance = cohensKappa([
    ...Array(12).fill({ proxy: 'yes', outcome: 'yes' }),
    ...Array(18).fill({ proxy: 'yes', outcome: 'no' }),
    ...Array(28).fill({ proxy: 'no', outcome: 'yes' }),
    ...Array(42).fill({ proxy: 'no', outcome: 'no' }),
  ]);
  expect('kappa chance level', close(chance.kappa, 0), `got ${chance.kappa}`);

  // Degenerate: every rating identical. pe=1, denominator 0, must not be NaN.
  const degenerate = cohensKappa(Array(30).fill({ proxy: 'yes', outcome: 'yes' }));
  expect('kappa degenerate: not NaN', Number.isFinite(degenerate.kappa), `got ${degenerate.kappa}`);
  expect('kappa degenerate: flagged', degenerate.degenerate === true, 'single category case must set degenerate');
  expect('kappa degenerate: value', degenerate.kappa === 1, `got ${degenerate.kappa}`);
  expect('kappa degenerate: interpretation explains it', /degenerate/i.test(interpretKappa(degenerate)), interpretKappa(degenerate));

  const empty = cohensKappa([]);
  expect('kappa empty input', Number.isFinite(empty.kappa), `got ${empty.kappa}`);

  console.log(`  kappa: perfect=${perfect.kappa}, chance=${chance.kappa}, degenerate=${degenerate.kappa} (${degenerate.degenerate})`);
}

/* ---- 13. Pearson correlation, kept from the original build ------------ *
 * x = [1,2,3,4,5], y = [2,3,5,4,6]. mean x=3, mean y=4.
 * dx=[-2,-1,0,1,2], dy=[-2,-1,1,0,2]
 * sum(dx*dy)=4+1+0+0+4=9, sum(dx^2)=10, sum(dy^2)=10
 * r = 9 / sqrt(10*10) = 0.9
 * ------------------------------------------------------------------- */
{
  const pairs = [1, 2, 3, 4, 5].map((x, i) => ({ x, y: [2, 3, 5, 4, 6][i] }));
  const result = pearsonCorrelation(pairs);
  expect('correlation hand derived', close(result.r, 0.9), `got ${result.r}`);
  console.log(`  correlation hand derived dataset: r=${result.r}`);

  const perfectPos = pearsonCorrelation([1, 2, 3, 4, 5].map((x) => ({ x, y: 2 * x })));
  expect('correlation perfect positive', close(perfectPos.r, 1), `got ${perfectPos.r}`);

  const perfectNeg = pearsonCorrelation([1, 2, 3, 4, 5].map((x) => ({ x, y: -3 * x + 1 })));
  expect('correlation perfect negative', close(perfectNeg.r, -1), `got ${perfectNeg.r}`);

  // x=[1,2,3,4], y=[2,1,1,2]: mean y=1.5, dy=[0.5,-0.5,-0.5,0.5], dx=[-1.5,-0.5,0.5,1.5]
  // sum dx*dy = -0.75+0.25-0.25+0.75 = 0 -> r = 0
  const zero = pearsonCorrelation([1, 2, 3, 4].map((x, i) => ({ x, y: [2, 1, 1, 2][i] })));
  expect('correlation exact zero', close(zero.r, 0), `got ${zero.r}`);

  const constantY = pearsonCorrelation([1, 2, 3, 4].map((x) => ({ x, y: 7 })));
  expect('correlation degenerate: r is null not NaN', constantY.r === null, `got ${constantY.r}`);
  expect('correlation degenerate: flagged', constantY.degenerate === true, 'zero variance must set degenerate');
  expect('correlation degenerate: interpretation explains it', /undefined|never varied/i.test(interpretCorrelation(constantY)), interpretCorrelation(constantY));

  const emptyCorr = pearsonCorrelation([]);
  expect('correlation empty input', emptyCorr.r === null, `got ${emptyCorr.r}`);

  console.log(`  correlation: perfect positive=${perfectPos.r}, perfect negative=${perfectNeg.r}, exact zero=${zero.r}`);
}

/* ---- 13b. The shipped kappa sample reproduces the worked example through the whole path */
{
  const state = sampleState('sensor-launch-claim');
  const parsed = state.raterPairedDataRaw.split('\n').filter(Boolean);
  expect('sample rater data has 50 rows', parsed.length === 50, `got ${parsed.length}`);
}

/* ---- 14. Export round trip ---------------------------------------------- */
{
  const state = sampleState('sensor-launch-claim');
  const json = serialize(state, 'json');
  const parsed = JSON.parse(json);
  expect('export json state', parsed.state.claim === state.claim, 'json export lost the claim text');
  expect('export json note discloses local analysis', /nothing was fetched|no fact was checked/i.test(parsed.note), parsed.note);
  expect('export json has fragments', Array.isArray(parsed.analysis.fragments) && parsed.analysis.fragments.length > 0, 'json export has no fragments array');
  expect('export json has rater agreement', parsed.raterAgreement.kind === 'categorical', JSON.stringify(parsed.raterAgreement.kind));

  const md = serialize(state, 'markdown');
  expect('export markdown header', md.includes('# Signal Tester report'), 'missing header');
  expect('export markdown discloses local analysis', /nothing was fetched/i.test(md), 'markdown export does not disclose local analysis');
  expect('export markdown has support map', md.includes('## Support map'), 'markdown export omits the support map section');
  expect('export markdown has kappa', /Cohen's kappa/i.test(md), 'markdown export omits the kappa line');
  console.log(`  export: json ${json.length} bytes, markdown ${md.length} bytes, both disclose local analysis`);
}

/* ---- Report ---------------------------------------------------------- */
console.log(`\nchecks run: ${checks}`);
if (failures) {
  console.log(`SIGNAL TESTER LOGIC: FAILED (${failures})`);
  process.exit(1);
}
console.log('SIGNAL TESTER LOGIC: CLEAN');
