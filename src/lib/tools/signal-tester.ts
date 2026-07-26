/**
 * Signal Tester, analysis engine.
 *
 * PRD: tools-nixfred-prds/tools/13-SIGNAL-TESTER.md
 * User outcome: check whether your evaluation signal measures the thing
 * you care about, or something adjacent to it.
 *
 * THE IDEA THIS TOOL TESTS: construct validity. A proxy (what you can
 * cheaply measure) is only useful to the extent it tracks an outcome
 * (what you actually care about). Most AI evaluation quietly fails in
 * the gap between the two. This tool does not close that gap. It makes
 * the gap visible: it asks the two questions that define it, ships a
 * catalog of known ways a proxy gets gamed once someone optimizes it on
 * purpose, and computes real agreement statistics when paired data is
 * supplied.
 *
 * HARD BOUNDARY: this tool never certifies a proxy as valid. Validity
 * is relative to a use, not a property a number can award. Every
 * assessment states what the evidence supports and what it does not,
 * and a documented failure mode is never dropped from that list just
 * because a statistic looks good. Nothing here fetches, scores against
 * a live model, or checks a fact. It is local, deterministic analysis
 * over whatever the user typed in.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Core state
 * ------------------------------------------------------------------ */

export type ProxyKind = 'categorical' | 'continuous';

export const PROXY_KIND_OPTIONS: Array<{ value: ProxyKind; label: string }> = [
  { value: 'categorical', label: 'Categorical labels, for example yes/no or pass/fail' },
  { value: 'continuous', label: 'Continuous numbers, for example a score or a percentage' },
];

/**
 * The two questions that are the core of this whole tool. Everything
 * else, the catalog, the statistics, exists to help answer these with
 * something more concrete than a shrug.
 */
export const GAP_QUESTIONS = {
  proxySucceedsOutcomeFails:
    'Can the proxy be satisfied while the outcome still fails? Give a concrete case.',
  outcomeHoldsProxyFails:
    'Can the outcome hold while the proxy still fails to show it? Give a concrete case.',
} as const;

export interface SignalState {
  /** The outcome the user actually cares about, in plain words. */
  outcome: string;
  /** What is actually being measured instead. */
  proxy: string;
  /** Whether paired data, when supplied, is read as labels or numbers. */
  proxyKind: ProxyKind;
  /** Answer to GAP_QUESTIONS.proxySucceedsOutcomeFails. */
  proxySucceedsOutcomeFails: string;
  /** Answer to GAP_QUESTIONS.outcomeHoldsProxyFails. */
  outcomeHoldsProxyFails: string;
  /** Ids into GAMEABILITY_CATALOG the user has confirmed apply here. */
  selectedFailureModes: string[];
  /** A gameable path the catalog does not already name. */
  customFailureMode: string;
  /**
   * Paired evidence, one row per line: "proxy value, outcome value".
   * Optional. Blank lines and lines starting with # are ignored.
   */
  pairedDataRaw: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

/* ------------------------------------------------------------------ *
 * Gameability catalog
 *
 * Goodhart's law made concrete. For each entry: the proxy, the outcome
 * it stands in for, exactly what an optimizer does to satisfy the proxy
 * without the outcome, and why that move is available at all. Every
 * field is required, checked by the logic gate, because a catalog entry
 * with an empty explanation teaches nothing.
 * ------------------------------------------------------------------ */

export interface GameabilityEntry {
  id: string;
  label: string;
  /** The proxy, stated as what actually gets measured. */
  proxy: string;
  /** The outcome the proxy is standing in for. */
  outcome: string;
  /** What a system optimized purely for the proxy would do. */
  gameMove: string;
  /** Why the proxy admits that move without the outcome objecting. */
  whyItFails: string;
  /** Regex source used to detect this pattern in a user's own wording. */
  detectPattern: string;
}

export const GAMEABILITY_CATALOG: GameabilityEntry[] = [
  {
    id: 'response-length',
    label: 'Response length as a proxy for quality',
    proxy: 'Longer responses score higher.',
    outcome: 'The response actually helps the reader.',
    gameMove:
      'Pad the answer with restated context, hedges, and filler until it reaches the length that scores well, without adding one new correct fact.',
    whyItFails:
      'Length measures effort spent writing, not correctness or usefulness. A system rewarded for length learns to write more, not to help more.',
    detectPattern: '\\b(length|word count|character count|number of words|longer response)\\b',
  },
  {
    id: 'thumbs-up-rate',
    label: 'User thumbs up as a proxy for correctness',
    proxy: 'The user clicked thumbs up.',
    outcome: 'The answer was factually correct.',
    gameMove:
      'Produce a confident, agreeable answer the user wants to hear, whether or not it is true. A confident wrong answer gets upvoted as often as a correct one when the user cannot check the fact themselves.',
    whyItFails:
      'Thumbs up measures the user immediate trust and satisfaction, not the truth of the claim. The two only agree when the user is equipped to verify the answer, which is rarely true for the questions worth asking.',
    detectPattern: '\\b(thumbs up|thumbs down|upvote|downvote|user rating|star rating|like button)\\b',
  },
  {
    id: 'exact-match',
    label: 'Exact match as a proxy for semantic correctness',
    proxy: 'The output string matches the reference string exactly.',
    outcome: 'The output means the same thing as the reference.',
    gameMove:
      'Output a correct paraphrase, a synonym, an equivalent unit, or a differently formatted but equivalent value, all penalized as wrong by exact match despite being correct.',
    whyItFails:
      'Natural language and structured values both admit many correct surface forms. Exact match only agrees with meaning when exactly one wording counts as right.',
    detectPattern: '\\b(exact match|string match|exact string|literal match)\\b',
  },
  {
    id: 'latency',
    label: 'Latency as a proxy for satisfaction',
    proxy: 'The response arrived quickly.',
    outcome: 'The user was satisfied with the interaction.',
    gameMove:
      'Return a fast, low effort, or truncated answer, or stream an immediate filler acknowledgement while the real work is skipped or degraded, so the clock looks good regardless of whether the request was actually served.',
    whyItFails:
      'Speed is one input to satisfaction, not a stand in for it. A fast wrong answer scores well on latency and poorly on the outcome it is supposed to predict.',
    detectPattern: '\\b(latency|response time|time to first token|how fast|speed of the reply)\\b',
  },
  {
    id: 'refusal-rate',
    label: 'Refusal rate as a proxy for safety',
    proxy: 'The system refuses to answer.',
    outcome: 'The system avoids causing harm.',
    gameMove:
      'Refuse broadly, including safe and legitimate requests, so the refusal count looks protective without any judgment about which requests were actually risky.',
    whyItFails:
      'Refusing everything drives refusal rate up and harm down at the cost of every request the system exists to serve. Safety is about refusing the right requests, not refusing often.',
    detectPattern: '\\b(refusal|refuse|decline to answer|declined to respond)\\b',
  },
  {
    id: 'test-pass-rate',
    label: 'Test pass rate as a proxy for working software',
    proxy: 'The test suite passes.',
    outcome: 'The software works correctly for its users.',
    gameMove:
      'Write the code to satisfy the specific assertions in the test suite, including the exact cases the tests check, without handling the inputs the tests never imagined.',
    whyItFails:
      'A test suite only samples the input space. Passing every test the author thought to write says nothing about the inputs the author did not think of, which is most of them in any real system.',
    detectPattern: '\\b(test pass|tests pass|passing tests|ci green|unit tests? passing)\\b',
  },
];

/**
 * Scans free text for wording that resembles a cataloged failure mode.
 * Deliberately advisory: a keyword match is a prompt to go read the
 * catalog entry and decide, not a verdict. Confirming a failure mode
 * for the validity assessment is a separate, explicit user action
 * (SignalState.selectedFailureModes), the same way prompt-lab keeps its
 * detectors conservative because a false finding trains the user to
 * ignore the panel.
 */
export function detectGameabilityMatches(outcome: string, proxy: string): string[] {
  const text = `${outcome} ${proxy}`;
  if (!text.trim()) return [];
  return GAMEABILITY_CATALOG.filter((entry) => new RegExp(entry.detectPattern, 'i').test(text)).map(
    (entry) => entry.id,
  );
}

/* ------------------------------------------------------------------ *
 * Paired data parsing
 * ------------------------------------------------------------------ */

export interface PairedRow {
  proxyValue: string;
  outcomeValue: string;
}

export interface ParsedPairedData {
  rows: PairedRow[];
  /** Lines that were not blank or a comment but could not be split into a pair. */
  skipped: number;
}

/**
 * One pair per line: "proxy value, outcome value". A line starting with
 * # is a comment. Everything after the first comma belongs to the
 * outcome value, so an outcome value may itself contain a comma.
 */
export function parsePairedRows(raw: string): ParsedPairedData {
  const rows: PairedRow[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const commaAt = trimmed.indexOf(',');
    if (commaAt === -1) {
      skipped += 1;
      continue;
    }
    const proxyValue = trimmed.slice(0, commaAt).trim();
    const outcomeValue = trimmed.slice(commaAt + 1).trim();
    if (!proxyValue || !outcomeValue) {
      skipped += 1;
      continue;
    }
    rows.push({ proxyValue, outcomeValue });
  }
  return { rows, skipped };
}

export interface ParsedNumericPairs {
  pairs: Array<{ x: number; y: number }>;
  skipped: number;
}

/** Reads parsed rows as numbers. A row either side cannot parse is dropped, not zeroed. */
export function parseNumericPairs(rows: PairedRow[]): ParsedNumericPairs {
  const pairs: Array<{ x: number; y: number }> = [];
  let skipped = 0;
  for (const row of rows) {
    const x = Number(row.proxyValue);
    const y = Number(row.outcomeValue);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      pairs.push({ x, y });
    } else {
      skipped += 1;
    }
  }
  return { pairs, skipped };
}

/**
 * Builds the "proxy value, outcome value" raw text a sample ships, from
 * counts rather than hundreds of typed literal lines. Exported because
 * the logic gate reconstructs the same tables independently to verify
 * that the shipped samples were assembled correctly.
 */
export function buildPairedRaw(counts: Array<[string, string, number]>): string {
  const lines: string[] = [];
  for (const [proxyValue, outcomeValue, n] of counts) {
    for (let i = 0; i < n; i++) lines.push(`${proxyValue}, ${outcomeValue}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Cohen's kappa
 *
 * Generalized to any number of categories; the familiar 2x2 case is
 * just k=2. Verified against the standard worked example in
 * tests/tool-signal-tester.mjs: a=20, b=5, c=10, d=15 gives kappa 0.4.
 * ------------------------------------------------------------------ */

export interface KappaResult {
  kappa: number;
  /** Raw percent agreement, po. What a naive check would report. */
  observedAgreement: number;
  /** Agreement expected from the marginal distributions alone, pe. */
  chanceAgreement: number;
  n: number;
  categories: string[];
  /** Rows are proxy categories, columns are outcome categories, in `categories` order. */
  confusionMatrix: number[][];
  /**
   * True when chance agreement is 1 and the denominator, 1 minus pe, is
   * zero, meaning every rating on both sides fell into a single
   * category. Naive implementations divide by zero here; this one
   * reports kappa 1 with the degenerate flag set, because po must also
   * be 1 whenever pe is 1, but that number reflects an absence of
   * variation, not a demonstrated ability to separate signal from
   * chance. Read the interpretation string, not the raw number, when
   * this is true.
   */
  degenerate: boolean;
}

/**
 * IMPORTANT ON LABELS: kappa only means agreement when the proxy and
 * the outcome are rated on the SAME set of category labels, the same
 * way two human raters must both use "yes" and "no" rather than one
 * saying "yes/no" and the other "high/low". If the two sides never use
 * an identical string, the diagonal of the confusion matrix is empty by
 * construction and kappa reports 0 regardless of how well the proxy
 * actually tracks the outcome. The UI hint on the paired data field
 * says this; a caller passing mismatched vocabularies gets a real,
 * honestly low kappa rather than a crash, which is itself informative
 * but is almost certainly not the comparison the user meant to run.
 */
export function cohensKappa(pairs: Array<{ proxy: string; outcome: string }>): KappaResult {
  const n = pairs.length;
  if (n === 0) {
    return {
      kappa: 0,
      observedAgreement: 0,
      chanceAgreement: 0,
      n: 0,
      categories: [],
      confusionMatrix: [],
      degenerate: true,
    };
  }

  const categories = Array.from(new Set(pairs.flatMap((p) => [p.proxy, p.outcome]))).sort();
  const index = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const matrix: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const p of pairs) {
    matrix[index.get(p.proxy)!][index.get(p.outcome)!] += 1;
  }

  let agree = 0;
  for (let i = 0; i < k; i++) agree += matrix[i][i];
  const observedAgreement = agree / n;

  const rowTotals = matrix.map((row) => row.reduce((s, v) => s + v, 0));
  const colTotals = categories.map((_, j) => matrix.reduce((s, row) => s + row[j], 0));
  let chanceAgreement = 0;
  for (let i = 0; i < k; i++) chanceAgreement += (rowTotals[i] / n) * (colTotals[i] / n);

  const denom = 1 - chanceAgreement;
  const degenerate = Math.abs(denom) < 1e-9;
  // Whenever pe is 1, po is provably 1 too: pe = 1 forces every row and
  // column total but one to be zero, which forces every off diagonal
  // cell to be zero, which forces po = 1. So the safe fallback is 1,
  // never a division that produces NaN.
  const kappa = degenerate ? 1 : (observedAgreement - chanceAgreement) / denom;

  return { kappa, observedAgreement, chanceAgreement, n, categories, confusionMatrix: matrix, degenerate };
}

const KAPPA_BANDS: Array<{ max: number; label: string }> = [
  { max: 0, label: 'poor, at or below the agreement expected by chance' },
  { max: 0.2, label: 'slight' },
  { max: 0.4, label: 'fair' },
  { max: 0.6, label: 'moderate' },
  { max: 0.8, label: 'substantial' },
  { max: 1.0001, label: 'almost perfect' },
];

/** Landis and Koch (1977) banding. A widely used rule of thumb, not a law. */
export function interpretKappa(result: KappaResult): string {
  if (result.n === 0) return 'No paired cases to compare.';
  if (result.degenerate) {
    return (
      'Degenerate: every case landed in the same single category on both sides, so no disagreement ' +
      'was even possible. Kappa reports 1.0 by convention, but that reflects an absence of variation ' +
      'in your sample, not a demonstrated ability to track the outcome. Add cases that could plausibly ' +
      'land in more than one category.'
    );
  }
  const band = KAPPA_BANDS.find((b) => result.kappa <= b.max) ?? KAPPA_BANDS[KAPPA_BANDS.length - 1];
  return `${band.label} agreement (Landis and Koch scale), corrected for the agreement expected by chance alone`;
}

/* ------------------------------------------------------------------ *
 * Pearson correlation
 * ------------------------------------------------------------------ */

export interface CorrelationResult {
  /** null when either variable has zero variance, since r is then undefined, not zero. */
  r: number | null;
  n: number;
  degenerate: boolean;
}

export function pearsonCorrelation(pairs: Array<{ x: number; y: number }>): CorrelationResult {
  const n = pairs.length;
  if (n === 0) return { r: null, n: 0, degenerate: true };

  const meanX = pairs.reduce((s, p) => s + p.x, 0) / n;
  const meanY = pairs.reduce((s, p) => s + p.y, 0) / n;

  let numerator = 0;
  let sumSqX = 0;
  let sumSqY = 0;
  for (const p of pairs) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    numerator += dx * dy;
    sumSqX += dx * dx;
    sumSqY += dy * dy;
  }

  if (sumSqX === 0 || sumSqY === 0) {
    // A constant has no variance to correlate with anything. Reporting
    // 0 here would read as "no relationship" when the honest answer is
    // "not computable from this data".
    return { r: null, n, degenerate: true };
  }

  return { r: numerator / Math.sqrt(sumSqX * sumSqY), n, degenerate: false };
}

/** Cohen's (1988) rough banding for the strength of a linear relationship. */
export function interpretCorrelation(result: CorrelationResult): string {
  if (result.degenerate || result.r === null) {
    return (
      'Undefined: one of the two variables never varied across the rows supplied, so correlation ' +
      'cannot be computed. A constant carries no information about how it moves with anything else.'
    );
  }
  const abs = Math.abs(result.r);
  const strength =
    abs < 0.1 ? 'negligible' : abs < 0.3 ? 'weak' : abs < 0.5 ? 'moderate' : abs < 0.7 ? 'strong' : 'very strong';
  if (abs < 0.05) {
    return `${strength} linear relationship, too close to zero for direction to mean anything`;
  }
  const direction = result.r > 0 ? 'positive' : 'negative';
  return `${strength} ${direction} linear relationship (rule of thumb banding, not a significance test)`;
}

/* ------------------------------------------------------------------ *
 * Statistics dispatch
 * ------------------------------------------------------------------ */

export type StatisticsResult =
  | { kind: 'none'; reason: string }
  | { kind: 'categorical'; n: number; skipped: number; kappa: KappaResult; interpretation: string }
  | { kind: 'continuous'; n: number; skipped: number; correlation: CorrelationResult; interpretation: string };

export function computeStatistics(state: SignalState): StatisticsResult {
  const parsed = parsePairedRows(state.pairedDataRaw);

  if (parsed.rows.length === 0) {
    return {
      kind: 'none',
      reason: parsed.skipped > 0
        ? `${parsed.skipped} line${parsed.skipped === 1 ? '' : 's'} could not be read as "proxy value, outcome value". No usable paired data yet.`
        : 'No paired data supplied yet. Add rows to compute real agreement statistics instead of describing them.',
    };
  }

  if (state.proxyKind === 'categorical') {
    if (parsed.rows.length < 2) {
      return { kind: 'none', reason: 'At least two paired rows are needed to compute a kappa.' };
    }
    const kappa = cohensKappa(parsed.rows.map((r) => ({ proxy: r.proxyValue, outcome: r.outcomeValue })));
    return {
      kind: 'categorical',
      n: parsed.rows.length,
      skipped: parsed.skipped,
      kappa,
      interpretation: interpretKappa(kappa),
    };
  }

  const numeric = parseNumericPairs(parsed.rows);
  if (numeric.pairs.length < 2) {
    return {
      kind: 'none',
      reason: 'At least two numeric paired rows are needed to compute a correlation. Check that both values on each row parse as numbers.',
    };
  }
  const correlation = pearsonCorrelation(numeric.pairs);
  return {
    kind: 'continuous',
    n: numeric.pairs.length,
    skipped: parsed.skipped + numeric.skipped,
    correlation,
    interpretation: interpretCorrelation(correlation),
  };
}

/* ------------------------------------------------------------------ *
 * Validity assessment
 *
 * The synthesis the PRD calls for: what the proxy supports concluding,
 * what it does not, and the specific cases to add that would catch the
 * gap. Never a certification. A documented failure mode always stays
 * in doesNotSupport, no matter how the statistics look.
 * ------------------------------------------------------------------ */

export interface GapStatus {
  proxySucceedsOutcomeFailsAnswered: boolean;
  outcomeHoldsProxyFailsAnswered: boolean;
}

export interface ValidityAssessment {
  supports: string[];
  doesNotSupport: string[];
  casesToAdd: string[];
  /** One line. Never a certification of validity. */
  headline: string;
}

function buildAssessment(
  state: SignalState,
  gap: GapStatus,
  confirmedFailureModeIds: string[],
  stats: StatisticsResult,
): ValidityAssessment {
  const outcomeLabel = state.outcome.trim() || 'the outcome you care about';
  const proxyLabel = state.proxy.trim() || 'the proxy you are measuring';

  const supports: string[] = [];
  const doesNotSupport: string[] = [];
  const casesToAdd: string[] = [];

  if (stats.kind === 'categorical') {
    const pct = Math.round(stats.kappa.observedAgreement * 100);
    supports.push(
      `On the ${stats.n} paired case${stats.n === 1 ? '' : 's'} supplied, ${proxyLabel} and ${outcomeLabel} ` +
        `show ${stats.interpretation}, kappa ${stats.kappa.kappa.toFixed(2)}. Raw agreement alone was ${pct} ` +
        `percent, which overstates the case because it does not correct for the agreement chance would produce ` +
        `on its own.`,
    );
    doesNotSupport.push(
      'Agreement measured on this sample does not extend to cases unlike the ones supplied, and it says ' +
        'nothing about the specific cases where the two disagree.',
    );
  } else if (stats.kind === 'continuous') {
    if (stats.correlation.degenerate || stats.correlation.r === null) {
      doesNotSupport.push(
        `Correlation could not be computed: one of ${proxyLabel} or ${outcomeLabel} never varied across the ` +
          `rows supplied. Add cases where the value actually moves.`,
      );
    } else {
      supports.push(
        `On the ${stats.n} paired case${stats.n === 1 ? '' : 's'} supplied, ${proxyLabel} and ${outcomeLabel} ` +
          `show a ${stats.interpretation}, r equals ${stats.correlation.r.toFixed(2)}.`,
      );
      doesNotSupport.push(
        'Correlation describes association across this sample, not causation, and a real correlation can ' +
          'still hide the specific divergent cases that matter most.',
      );
    }
  } else {
    doesNotSupport.push(
      `No paired data has been supplied, so nothing here measures how often ${proxyLabel} actually tracks ` +
        `${outcomeLabel} in practice. ${stats.reason}`,
    );
  }

  if (!gap.proxySucceedsOutcomeFailsAnswered && !gap.outcomeHoldsProxyFailsAnswered) {
    doesNotSupport.push(
      'Neither gap question has been answered, so the proxy has not been tested against the failure mode ' +
        'that matters most: looking fine while the outcome fails, or the reverse.',
    );
    casesToAdd.push(`A case where ${proxyLabel} looks good but ${outcomeLabel} did not actually happen.`);
    casesToAdd.push(`A case where ${outcomeLabel} happened but ${proxyLabel} looks bad or is absent.`);
  } else {
    if (gap.proxySucceedsOutcomeFailsAnswered) {
      doesNotSupport.push(
        `A case is on record where ${proxyLabel} can be satisfied while ${outcomeLabel} still fails: ` +
          `"${state.proxySucceedsOutcomeFails.trim()}". Any use of this proxy inherits that blind spot.`,
      );
      casesToAdd.push('Add that exact case to the evaluation set, so a future change that exploits it gets caught.');
    } else {
      casesToAdd.push(
        `A case where ${proxyLabel} looks good but ${outcomeLabel} did not happen. Failing to construct one is ` +
          `a data point worth writing down, not proof that none exists.`,
      );
    }
    if (gap.outcomeHoldsProxyFailsAnswered) {
      doesNotSupport.push(
        `A case is on record where ${outcomeLabel} holds while ${proxyLabel} fails to reflect it: ` +
          `"${state.outcomeHoldsProxyFails.trim()}". The proxy undercounts success shaped like that.`,
      );
      casesToAdd.push('Add that case too, on the other side of the confusion matrix.');
    } else {
      casesToAdd.push(`A case where ${outcomeLabel} happened but ${proxyLabel} looks bad or is absent.`);
    }
  }

  for (const id of confirmedFailureModeIds) {
    const entry = GAMEABILITY_CATALOG.find((e) => e.id === id);
    if (!entry) continue;
    doesNotSupport.push(`Confirmed known failure mode: ${entry.label}. ${entry.whyItFails}`);
    casesToAdd.push(`A case shaped like "${entry.gameMove}" so the evaluation would catch it if it happened.`);
  }

  if (state.customFailureMode.trim()) {
    doesNotSupport.push(`An additional gameable path was flagged: "${state.customFailureMode.trim()}".`);
    casesToAdd.push('Write a concrete case for that path and add it to the evaluation set.');
  }

  if (supports.length === 0) {
    supports.push(
      'Nothing yet. Answer the gap questions above or add paired data to give this proxy something concrete to stand on.',
    );
  }

  const hasDocumentedGap =
    confirmedFailureModeIds.length > 0 ||
    gap.proxySucceedsOutcomeFailsAnswered ||
    gap.outcomeHoldsProxyFailsAnswered ||
    Boolean(state.customFailureMode.trim());

  let headline: string;
  if (hasDocumentedGap) {
    headline = `Do not treat ${proxyLabel} as interchangeable with ${outcomeLabel}. At least one concrete gap is documented above, and it does not go away because the statistics look good.`;
  } else if (stats.kind !== 'none') {
    headline = `${proxyLabel} shows a measured relationship to ${outcomeLabel} on the data given. That is evidence for this sample, not a certification, and no gap has been tested for yet.`;
  } else {
    headline = `Not enough is in yet to say anything about whether ${proxyLabel} tracks ${outcomeLabel}. That absence is itself the finding.`;
  }

  return { supports, doesNotSupport, casesToAdd, headline };
}

export interface SignalAnalysis {
  gap: GapStatus;
  /** Catalog ids whose wording pattern appears in the outcome or proxy text. Advisory only. */
  detectedFailureModeIds: string[];
  statistics: StatisticsResult;
  assessment: ValidityAssessment;
}

export function analyzeSignal(state: SignalState): SignalAnalysis {
  const gap: GapStatus = {
    proxySucceedsOutcomeFailsAnswered: Boolean(state.proxySucceedsOutcomeFails.trim()),
    outcomeHoldsProxyFailsAnswered: Boolean(state.outcomeHoldsProxyFails.trim()),
  };
  const detectedFailureModeIds = detectGameabilityMatches(state.outcome, state.proxy);
  const statistics = computeStatistics(state);
  const assessment = buildAssessment(state, gap, state.selectedFailureModes, statistics);
  return { gap, detectedFailureModeIds, statistics, assessment };
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * Four samples, each teaching a different piece of the tool: the
 * textbook kappa worked example, a continuous correlation, a proxy
 * whose gap is visible with zero statistics, and a case with strong
 * looking agreement that still cannot be called valid because a
 * documented failure mode remains in play.
 * ------------------------------------------------------------------ */

export interface Sample {
  id: string;
  name: string;
  teaches: string;
  state: SignalState;
}

export const SAMPLES: Sample[] = [
  {
    id: 'thumbs-up-fact-check',
    name: 'Thumbs up rate for a support bot',
    teaches:
      'The textbook worked example. Raw agreement reads like a pass at 70 percent, but corrected for chance the kappa is only 0.4, fair agreement, because both raters lean toward the same answer most of the time regardless of the actual case.',
    state: {
      outcome: 'The answer was independently fact checked as correct.',
      proxy: 'The user clicked thumbs up on the answer.',
      proxyKind: 'categorical',
      proxySucceedsOutcomeFails:
        'A confident, well written, wrong answer about a topic the user cannot check themselves gets a thumbs up anyway.',
      outcomeHoldsProxyFails:
        'A correct but blunt answer that contradicts what the user hoped to hear gets a thumbs down even though it was right.',
      selectedFailureModes: ['thumbs-up-rate'],
      customFailureMode: '',
      // Cohen's kappa needs both sides on the SAME label set, so "yes"
      // means the proxy read positive (thumbs up) or the outcome held
      // (fact checked correct), and "no" means the negative reading on
      // whichever side it appears. This is the textbook a=20, b=5,
      // c=10, d=15 table: kappa 0.4, verified by hand in the logic gate.
      pairedDataRaw: buildPairedRaw([
        ['yes', 'yes', 20],
        ['yes', 'no', 5],
        ['no', 'yes', 10],
        ['no', 'no', 15],
      ]),
    },
  },
  {
    id: 'test-pass-rate-stability',
    name: 'Test pass rate for release stability',
    teaches:
      'A continuous proxy and a continuous outcome, related by correlation rather than kappa. A strong positive correlation is still association across six releases, not proof the next release will hold.',
    state: {
      outcome: 'Incident free days in the two weeks after release, out of 14.',
      proxy: 'Automated test pass rate before merge, as a percentage.',
      proxyKind: 'continuous',
      proxySucceedsOutcomeFails:
        'A release hits 100 percent pass rate because the suite never exercises the third party payment webhook, which then fails in production for a week.',
      outcomeHoldsProxyFails:
        'A release ships with two known, accepted test failures in a rarely used export feature and still runs incident free for the full two weeks.',
      selectedFailureModes: ['test-pass-rate'],
      customFailureMode: '',
      pairedDataRaw: buildPairedRaw([
        ['62', '3', 1],
        ['74', '6', 1],
        ['81', '7', 1],
        ['88', '10', 1],
        ['93', '9', 1],
        ['97', '13', 1],
      ]),
    },
  },
  {
    id: 'response-length-helpfulness',
    name: 'Reply length for support triage',
    teaches:
      'A gap that is visible with zero statistics. Two sentences of concrete counterexample are enough to show the proxy and the outcome can come apart; no paired data has been entered at all here.',
    state: {
      outcome: "The reply actually resolved the Customer's problem without a follow up message.",
      proxy: 'Reply length in words.',
      proxyKind: 'continuous',
      proxySucceedsOutcomeFails:
        'A long reply that restates the Customer policy three times and never names the actual fix scores high on length and resolves nothing.',
      outcomeHoldsProxyFails:
        'A five word reply, "refunded, confirmation email sent", fully resolves the ticket and scores near zero on length.',
      selectedFailureModes: ['response-length'],
      customFailureMode: '',
      pairedDataRaw: '',
    },
  },
  {
    id: 'exact-match-extraction',
    name: 'Exact match for invoice field extraction',
    teaches:
      'Strong looking agreement, kappa near 0.8, that still cannot be called valid because a documented failure mode, paraphrase and reformatting, remains unaddressed. High agreement on a sample is not a certification.',
    state: {
      outcome: 'The extracted field is semantically correct.',
      proxy: 'The extracted field matches the reference string exactly.',
      proxyKind: 'categorical',
      proxySucceedsOutcomeFails:
        'Every field in a batch happens to already be in canonical form, so exact match and semantic correctness agree by coincidence, not because the extractor understands meaning.',
      outcomeHoldsProxyFails:
        'The reference date is "2026-01-05" and the extractor returns "January 5, 2026", which is the same date and marked wrong by exact match.',
      selectedFailureModes: ['exact-match'],
      customFailureMode: '',
      // Same shared label set as the sample above: "yes" means the
      // proxy read positive (exact string match) or the outcome held
      // (semantically correct), "no" means the negative reading.
      pairedDataRaw: buildPairedRaw([
        ['yes', 'yes', 40],
        ['yes', 'no', 2],
        ['no', 'yes', 8],
        ['no', 'no', 50],
      ]),
    },
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

function emptyDraft(): SignalState {
  return {
    outcome: '',
    proxy: '',
    proxyKind: 'categorical',
    proxySucceedsOutcomeFails: '',
    outcomeHoldsProxyFails: '',
    selectedFailureModes: [],
    customFailureMode: '',
    pairedDataRaw: '',
  };
}

export function emptyState(): SignalState {
  return emptyDraft();
}

export function sampleState(id: string = SAMPLES[0].id): SignalState {
  const sample = getSample(id) ?? SAMPLES[0];
  return {
    ...sample.state,
    selectedFailureModes: [...sample.state.selectedFailureModes],
  };
}

export function reset(): SignalState {
  return emptyState();
}

export function validate(state: SignalState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!state.outcome.trim()) {
    issues.push({
      field: 'outcome',
      message: 'State the outcome you actually care about before running an assessment.',
      severity: 'error',
    });
  }
  if (!state.proxy.trim()) {
    issues.push({
      field: 'proxy',
      message: 'State the proxy you are actually measuring before running an assessment.',
      severity: 'error',
    });
  }
  if (!state.proxySucceedsOutcomeFails.trim() && !state.outcomeHoldsProxyFails.trim()) {
    issues.push({
      field: 'gap',
      message:
        'Neither gap question is answered yet. The assessment will say so, but answering both is how this tool earns its keep.',
      severity: 'warning',
    });
  }
  const parsed = parsePairedRows(state.pairedDataRaw);
  if (state.pairedDataRaw.trim() && parsed.rows.length === 0) {
    issues.push({
      field: 'pairedDataRaw',
      message: 'No row in the paired data could be read. Use one "proxy value, outcome value" pair per line.',
      severity: 'warning',
    });
  }

  return issues;
}

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: SignalState, format: ExportFormat): string {
  const analysis = analyzeSignal(state);

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Signal Tester',
        note: 'Local static analysis. No model was scored and no fact was checked. This report never certifies a proxy as valid.',
        state,
        analysis,
      },
      null,
      2,
    );
  }

  const list = (items: string[]) =>
    items.length ? items.map((item) => `1. ${item}`).join('\n') : '1. None recorded.';

  const statsLines: string[] = [];
  if (analysis.statistics.kind === 'categorical') {
    const k = analysis.statistics.kappa;
    statsLines.push(
      `Categorical agreement over ${analysis.statistics.n} paired cases (${analysis.statistics.skipped} skipped).`,
      `Raw agreement: ${(k.observedAgreement * 100).toFixed(1)} percent.`,
      `Chance agreement: ${(k.chanceAgreement * 100).toFixed(1)} percent.`,
      `Cohen's kappa: ${k.kappa.toFixed(3)}, ${analysis.statistics.interpretation}.`,
    );
  } else if (analysis.statistics.kind === 'continuous') {
    const c = analysis.statistics.correlation;
    statsLines.push(
      `Continuous correlation over ${analysis.statistics.n} paired cases (${analysis.statistics.skipped} skipped).`,
      `Pearson r: ${c.r === null ? 'undefined' : c.r.toFixed(3)}, ${analysis.statistics.interpretation}.`,
    );
  } else {
    statsLines.push(`No statistics computed. ${analysis.statistics.reason}`);
  }

  const reportLines = [
    '# Signal Tester report',
    '',
    'Local static analysis. No model was scored and no fact was checked. This report never certifies a proxy as valid.',
    '',
    `Outcome: ${state.outcome || '(not stated)'}`,
    `Proxy: ${state.proxy || '(not stated)'}`,
    `Proxy kind: ${state.proxyKind}`,
    '',
    '## Gap interrogation',
    '',
    `Can the proxy be satisfied while the outcome fails? ${state.proxySucceedsOutcomeFails || '(not answered)'}`,
    `Can the outcome hold while the proxy fails? ${state.outcomeHoldsProxyFails || '(not answered)'}`,
    '',
    '## Confirmed failure modes',
    '',
    state.selectedFailureModes.length
      ? state.selectedFailureModes
          .map((id) => `1. ${GAMEABILITY_CATALOG.find((e) => e.id === id)?.label ?? id}`)
          .join('\n')
      : '1. None confirmed.',
    state.customFailureMode ? `1. Custom: ${state.customFailureMode}` : '',
    '',
    '## Statistics',
    '',
    ...statsLines,
    '',
    '## Validity assessment',
    '',
    `Headline: ${analysis.assessment.headline}`,
    '',
    'Supports:',
    list(analysis.assessment.supports),
    '',
    'Does not support:',
    list(analysis.assessment.doesNotSupport),
    '',
    'Cases to add:',
    list(analysis.assessment.casesToAdd),
    '',
  ];

  // Collapse consecutive blank lines a skipped optional section (an
  // empty custom failure mode, most often) would otherwise leave
  // behind. Array.prototype.at keeps this readable without an index
  // arithmetic expression sitting next to a quoted empty string.
  const collapsed: string[] = [];
  for (const line of reportLines) {
    if (line === '' && collapsed.at(-1) === '') continue;
    collapsed.push(line);
  }
  return collapsed.join('\n');
}

export function filename(_state: SignalState, format: ExportFormat): string {
  return format === 'json' ? 'signal-tester-report' : 'signal-tester-report';
}
