/**
 * Signal Tester, analysis engine.
 *
 * PRD: tools-nixfred-prds/tools/13-SIGNAL-TESTER.md
 * User outcome, quoted directly from the PRD: "Evaluate whether an
 * AI-generated claim is supported, specific, attributable, and
 * decision-relevant."
 *
 * Workflow: paste a claim and its cited evidence, mark each source's
 * type and date, inspect a structured quality assessment: a support
 * map, unsupported leaps, ambiguity, source gaps, freshness risk, and a
 * rewritten evidence calibrated claim.
 *
 * HARD BOUNDARY FROM THE PRD: "This is not a general truth machine or
 * live fact-checker. It evaluates supplied evidence." Nothing here
 * fetches, searches, or checks a fact against the world. Every finding
 * is computed from the claim text and the evidence text the user typed
 * in, and the UI says so. "Supported" means the evidence supplied
 * literally backs the fragment, not that the fragment is true.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Claim fragments
 * ------------------------------------------------------------------ */

export type FragmentKind = 'fact' | 'inference' | 'prediction' | 'opinion';

export const FRAGMENT_KIND_LABELS: Record<FragmentKind, string> = {
  fact: 'Fact',
  inference: 'Inference',
  prediction: 'Prediction',
  opinion: 'Opinion',
};

/**
 * One sentence level piece of the claim, carrying real offsets into the
 * claim text. `text` is always exactly `claim.slice(start, end)`, the
 * same discipline prompt-lab.ts uses for its findings: a fragment's
 * coordinates are checked by slicing, not asserted.
 */
export interface ClaimFragment {
  index: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Splits on sentence ending punctuation while keeping real offsets into
 * the ORIGINAL claim string, the same shape prompt-lab.ts uses for its
 * segment findings. A plain `.split(...)` would throw the positions
 * away, which is exactly what criterion 1 ("claim fragments map to
 * evidence passages") rules out: the map has to point at real text.
 */
export function splitClaimFragments(claim: string): ClaimFragment[] {
  const fragments: ClaimFragment[] = [];
  const re = /[^.!?]+[.!?]*/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(claim)) !== null) {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = match.index + leading;
    const end = start + trimmed.length;
    fragments.push({ index, start, end, text: claim.slice(start, end) });
    index += 1;
  }
  return fragments;
}

/* ------------------------------------------------------------------ *
 * Fact, inference, prediction, opinion
 *
 * Deliberately conservative, pattern based classification, the same
 * ethos as prompt-lab.ts: a false finding trains the user to ignore the
 * panel. Each category is checked in order, most specific first, and
 * the matched phrase is always shown so the classification can be
 * checked, not just trusted.
 * ------------------------------------------------------------------ */

interface ClassifierPattern {
  re: RegExp;
  label: string;
}

const PREDICTION_PATTERNS: ClassifierPattern[] = [
  { re: /\bwill\b/i, label: 'the modal "will", asserting a future state' },
  { re: /\bis going to\b/i, label: '"is going to", asserting a future state' },
  { re: /\bis expected to\b/i, label: '"is expected to", a forecast' },
  { re: /\bis projected to\b/i, label: '"is projected to", a forecast' },
  { re: /\bis (forecast|forecasted) to\b/i, label: '"is forecast to", a forecast' },
  { re: /\bby 20\d{2}\b/i, label: 'a future year target' },
  { re: /\bis set to\b/i, label: '"is set to", asserting a future state' },
];

const OPINION_PATTERNS: ClassifierPattern[] = [
  { re: /\bi (think|believe|feel)\b/i, label: 'a first person judgment' },
  { re: /\barguably\b/i, label: '"arguably", a hedge marking a value judgment' },
  { re: /\bin (my|our) view\b/i, label: 'a stated personal viewpoint' },
  { re: /\bclearly the (best|worst|most|least)\b/i, label: 'a superlative value judgment' },
  { re: /\bthe (best|worst)\b/i, label: 'a superlative value judgment' },
  { re: /\bshould\b/i, label: '"should", a normative judgment' },
  { re: /\bought to\b/i, label: '"ought to", a normative judgment' },
  { re: /\bis (amazing|excellent|terrible|awful|disappointing|impressive)\b/i, label: 'an evaluative adjective' },
];

const INFERENCE_PATTERNS: ClassifierPattern[] = [
  { re: /\bsuggests? that\b/i, label: '"suggests that", a reasoned conclusion rather than a direct observation' },
  { re: /\bthis implies\b/i, label: '"this implies", a reasoned conclusion' },
  { re: /\bindicates? that\b/i, label: '"indicates that", a reasoned conclusion' },
  { re: /\bthis (shows|demonstrates) that\b/i, label: 'a reasoned conclusion drawn from something else' },
  { re: /\btherefore\b/i, label: '"therefore", a conclusion drawn from a premise' },
  { re: /\bas a result\b/i, label: '"as a result", a causal inference' },
  { re: /\bpoints to\b/i, label: '"points to", a reasoned conclusion' },
  { re: /\b(likely|probably) (because|due to)\b/i, label: 'a probabilistic causal inference' },
];

function firstMatch(text: string, patterns: ClassifierPattern[]): { label: string; excerpt: string } | null {
  for (const p of patterns) {
    const re = new RegExp(p.re.source, p.re.flags);
    const m = re.exec(text);
    if (m) return { label: p.label, excerpt: m[0] };
  }
  return null;
}

export function classifyFragment(text: string): { kind: FragmentKind; signal: string } {
  const prediction = firstMatch(text, PREDICTION_PATTERNS);
  if (prediction) return { kind: 'prediction', signal: `${prediction.label} ("${prediction.excerpt}")` };

  const opinion = firstMatch(text, OPINION_PATTERNS);
  if (opinion) return { kind: 'opinion', signal: `${opinion.label} ("${opinion.excerpt}")` };

  const inference = firstMatch(text, INFERENCE_PATTERNS);
  if (inference) return { kind: 'inference', signal: `${inference.label} ("${inference.excerpt}")` };

  return {
    kind: 'fact',
    signal: 'No prediction, opinion, or inference marker found; read as a direct, checkable assertion.',
  };
}

/* ------------------------------------------------------------------ *
 * Ambiguity
 *
 * Language in the CLAIM that appeals to an unnamed authority or an
 * unquantified magnitude, so it cannot be checked against a specific
 * source even when evidence exists. This is a property of the wording,
 * independent of whether a source happens to be attached.
 * ------------------------------------------------------------------ */

const AMBIGUITY_PATTERN =
  /\b(many experts|several studies|research shows|studies suggest|some believe|industry observers|widely regarded|significant(ly)?|substantial(ly)?|considerable|considerably)\b/i;

export function detectAmbiguity(text: string): string | null {
  const re = new RegExp(AMBIGUITY_PATTERN.source, AMBIGUITY_PATTERN.flags);
  const m = re.exec(text);
  if (!m) return null;
  return `Invokes an unnamed authority or an unquantified magnitude ("${m[0]}") that cannot be checked against a specific source.`;
}

/* ------------------------------------------------------------------ *
 * Evidence sources
 * ------------------------------------------------------------------ */

export type SourceType =
  | 'unspecified'
  | 'primary-data'
  | 'official-record'
  | 'news-report'
  | 'analysis-or-opinion'
  | 'unverified-or-social';

export const SOURCE_TYPE_OPTIONS: Array<{ value: SourceType; label: string }> = [
  { value: 'unspecified', label: 'Not specified' },
  { value: 'primary-data', label: 'Primary data: a dataset, log, or direct measurement' },
  { value: 'official-record', label: 'Official record: a filing, changelog, or vendor statement' },
  { value: 'news-report', label: 'News report: independent journalism' },
  { value: 'analysis-or-opinion', label: 'Analysis or opinion: commentary or an editorial' },
  { value: 'unverified-or-social', label: 'Unverified or social: a forum post or a single social post' },
];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = SOURCE_TYPE_OPTIONS.reduce(
  (acc, o) => {
    acc[o.value] = o.label;
    return acc;
  },
  {} as Record<SourceType, string>,
);

/** Source types too weak to carry a claim classified as fact on their own. */
const WEAK_SOURCE_TYPES: SourceType[] = ['unspecified', 'analysis-or-opinion', 'unverified-or-social'];

export interface EvidenceSource {
  id: string;
  text: string;
  sourceType: SourceType;
  /** ISO date, YYYY-MM-DD. Empty string means undated. */
  date: string;
}

/* ------------------------------------------------------------------ *
 * Support mapping
 *
 * The core of the tool. Support is measured by literal word overlap,
 * stated plainly because the UI shows this note next to every result:
 * a word match, not a meaning match. It will not catch a paraphrase and
 * it will not catch a negation, which is exactly the kind of honesty
 * prompt-lab.ts applies to its own token estimate.
 * ------------------------------------------------------------------ */

export const SUPPORT_THRESHOLD = 0.5;

export const SUPPORT_METHOD =
  `Support is measured by literal word overlap: the share of a fragment's distinctive words ` +
  `(length 4 or more, common words excluded) that appear as whole words anywhere in a source's text. ` +
  `At or above ${Math.round(SUPPORT_THRESHOLD * 100)} percent overlap counts as supported. This is a word ` +
  `match, not a meaning match. It will not catch a paraphrase, and it will not catch a negation, so read ` +
  `the excerpt rather than trusting the ratio alone.`;

const STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'will', 'into', 'also',
  'some', 'other', 'than', 'then', 'been', 'were', 'being', 'they', 'their', 'them',
  'about', 'after', 'before', 'over', 'under', 'such', 'only', 'more', 'most', 'each',
  'both', 'same', 'very', 'just', 'while', 'when', 'where', 'which', 'what', 'because',
  'through', 'during', 'between', 'among', 'within', 'without', 'against', 'upon',
  'said', 'says', 'say', 'told', 'according',
]);

function contentWords(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length >= 4 && !STOPWORDS.has(raw)) seen.add(raw);
  }
  return Array.from(seen);
}

export interface SupportLink {
  fragmentIndex: number;
  sourceId: string;
  /** Offsets into the SOURCE's text. excerpt is always source.text.slice(start, end). */
  start: number;
  end: number;
  excerpt: string;
  matchedWords: string[];
  overlapRatio: number;
}

function findSupportLink(fragment: ClaimFragment, source: EvidenceSource): SupportLink | null {
  const words = contentWords(fragment.text);
  if (words.length === 0) return null;

  const positions: Array<{ word: string; start: number; end: number }> = [];
  for (const word of words) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    const m = re.exec(source.text);
    if (m) positions.push({ word, start: m.index, end: m.index + m[0].length });
  }
  if (positions.length === 0) return null;

  positions.sort((a, b) => a.start - b.start);
  const start = positions[0].start;
  const end = positions[positions.length - 1].end;

  return {
    fragmentIndex: fragment.index,
    sourceId: source.id,
    start,
    end,
    excerpt: source.text.slice(start, end),
    matchedWords: positions.map((p) => p.word),
    overlapRatio: positions.length / words.length,
  };
}

/* ------------------------------------------------------------------ *
 * Unsupported leaps
 *
 * The sharpest failure mode named in the PRD's design notes: the
 * evidence says "in one trial", the claim says "in general". That gap
 * is detected specifically, not folded into a generic low score.
 * ------------------------------------------------------------------ */

const GENERALIZING_PATTERN =
  /\b(in general|always|universally|every|all (supported versions|users|customers|cases)|across the board|as a rule|typically|generally|invariably|without exception|no matter what)\b/i;

const NARROWING_PATTERN =
  /\b(only in version|only for|limited to|in this release only|does not apply to|in one trial|in a small (sample|study|trial)|among (the )?(surveyed|sampled|interviewed)|preliminary|small sample|limited sample|anecdotal|in a single|a handful of)\b/i;

export interface TextSpan {
  start: number;
  end: number;
  excerpt: string;
}

function findSpan(text: string, pattern: RegExp): TextSpan | null {
  const re = new RegExp(pattern.source, pattern.flags);
  const m = re.exec(text);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length, excerpt: m[0] };
}

export type SupportStatus = 'supported' | 'overgeneralized' | 'weak-evidence' | 'no-evidence';

export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  supported: 'Supported',
  overgeneralized: 'Overgeneralized',
  'weak-evidence': 'Weak evidence',
  'no-evidence': 'No evidence',
};

export interface FragmentAnalysis {
  fragment: ClaimFragment;
  kind: FragmentKind;
  kindSignal: string;
  /** Every source with any overlap at all, best first. */
  links: SupportLink[];
  bestLink: SupportLink | null;
  status: SupportStatus;
  /** Offsets into fragment.text. Present whenever the fragment itself overgeneralizes, regardless of status. */
  generalizing: TextSpan | null;
  /** Offsets into the best source's text. Present only when status is 'overgeneralized'. */
  narrowing: (TextSpan & { sourceId: string }) | null;
  ambiguous: boolean;
  ambiguitySignal: string | null;
}

export function analyzeFragment(fragment: ClaimFragment, sources: EvidenceSource[]): FragmentAnalysis {
  const { kind, signal: kindSignal } = classifyFragment(fragment.text);

  const links = sources
    .map((s) => findSupportLink(fragment, s))
    .filter((l): l is SupportLink => l !== null)
    .sort((a, b) => b.overlapRatio - a.overlapRatio);
  const bestLink = links[0] ?? null;

  const generalizing = findSpan(fragment.text, GENERALIZING_PATTERN);
  let status: SupportStatus;
  let narrowing: FragmentAnalysis['narrowing'] = null;

  if (!bestLink || bestLink.overlapRatio <= 0) {
    status = 'no-evidence';
  } else if (bestLink.overlapRatio < SUPPORT_THRESHOLD) {
    status = 'weak-evidence';
  } else {
    const source = sources.find((s) => s.id === bestLink.sourceId);
    const foundNarrowing = generalizing && source ? findSpan(source.text, NARROWING_PATTERN) : null;
    if (generalizing && foundNarrowing) {
      status = 'overgeneralized';
      narrowing = { sourceId: bestLink.sourceId, ...foundNarrowing };
    } else {
      status = 'supported';
    }
  }

  const ambiguitySignal = detectAmbiguity(fragment.text);

  return {
    fragment,
    kind,
    kindSignal,
    links,
    bestLink,
    status,
    generalizing,
    narrowing,
    ambiguous: Boolean(ambiguitySignal),
    ambiguitySignal,
  };
}

/* ------------------------------------------------------------------ *
 * Freshness risk
 *
 * An undated source is its own risk category, not a neutral middle
 * ground: it cannot be checked for recency at all. Bands are a
 * generic, stated heuristic, the same honesty prompt-lab.ts applies to
 * its token estimate.
 * ------------------------------------------------------------------ */

export type FreshnessRisk = 'undated' | 'future-dated' | 'fresh' | 'aging' | 'stale';

const FRESHNESS_FRESH_DAYS = 365;
const FRESHNESS_AGING_DAYS = 730;

export const FRESHNESS_METHOD =
  `Freshness bands are a generic heuristic, not a citation standard: fresh up to ${FRESHNESS_FRESH_DAYS} days ` +
  `old, aging up to ${FRESHNESS_AGING_DAYS} days, stale beyond that. Some domains go stale far faster than ` +
  `this; treat the bands as a starting point to override for your own field.`;

export interface FreshnessAssessment {
  sourceId: string;
  risk: FreshnessRisk;
  ageDays: number | null;
  note: string;
}

/** `asOf` is injectable so results are deterministic and testable; it defaults to the real clock at call time. */
export function assessFreshness(source: EvidenceSource, asOf: Date = new Date()): FreshnessAssessment {
  if (!source.date.trim()) {
    return {
      sourceId: source.id,
      risk: 'undated',
      ageDays: null,
      note: 'No date was given for this source. An undated source cannot be checked for freshness at all, which is its own risk, not a neutral middle ground.',
    };
  }

  const parsed = new Date(source.date);
  if (Number.isNaN(parsed.getTime())) {
    return {
      sourceId: source.id,
      risk: 'undated',
      ageDays: null,
      note: `The date "${source.date}" could not be read. Treated the same as undated.`,
    };
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const ageDays = Math.round((asOf.getTime() - parsed.getTime()) / msPerDay);

  if (ageDays < 0) {
    const days = Math.abs(ageDays);
    return {
      sourceId: source.id,
      risk: 'future-dated',
      ageDays,
      note: `This source is dated ${days} day${days === 1 ? '' : 's'} in the future. Treat this as a data problem, not evidence of freshness.`,
    };
  }
  if (ageDays <= FRESHNESS_FRESH_DAYS) {
    return { sourceId: source.id, risk: 'fresh', ageDays, note: `${ageDays} days old, within the ${FRESHNESS_FRESH_DAYS} day fresh window.` };
  }
  if (ageDays <= FRESHNESS_AGING_DAYS) {
    return {
      sourceId: source.id,
      risk: 'aging',
      ageDays,
      note: `${ageDays} days old, past the ${FRESHNESS_FRESH_DAYS} day fresh window but within ${FRESHNESS_AGING_DAYS} days.`,
    };
  }
  return {
    sourceId: source.id,
    risk: 'stale',
    ageDays,
    note: `${ageDays} days old, past the ${FRESHNESS_AGING_DAYS} day window most fields would call stale.`,
  };
}

/** Builds an ISO date string relative to today, so shipped samples stay accurate without hand maintenance. */
export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Source gaps
 * ------------------------------------------------------------------ */

export function computeSourceGaps(fragments: FragmentAnalysis[], sources: EvidenceSource[]): string[] {
  const gaps: string[] = [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const usedIds = new Set<string>();

  for (const f of fragments) {
    if (!f.bestLink || f.bestLink.overlapRatio <= 0) continue;
    usedIds.add(f.bestLink.sourceId);

    if (f.status === 'supported' || f.status === 'overgeneralized') {
      const source = sourceById.get(f.bestLink.sourceId);
      if (!source) continue;
      if (source.sourceType === 'unspecified') {
        gaps.push(`Fragment "${f.fragment.text}" relies on a source with no stated source type, so its reliability cannot be weighed.`);
      }
      if (f.kind === 'fact' && WEAK_SOURCE_TYPES.includes(source.sourceType)) {
        gaps.push(
          `Fragment "${f.fragment.text}" is stated as fact but is backed only by a ${SOURCE_TYPE_LABELS[source.sourceType].toLowerCase()} source, a weaker type than a factual claim needs.`,
        );
      }
    }
  }

  for (const source of sources) {
    if (!usedIds.has(source.id)) {
      gaps.push(
        `Source "${source.id}" was supplied but does not support any claim fragment above the weak evidence threshold. Either it is unnecessary or the claim is missing something it could support.`,
      );
    }
  }

  return gaps;
}

/* ------------------------------------------------------------------ *
 * Confidence
 *
 * "Missing evidence reduces confidence visibly", per the PRD. The
 * mechanism is the ledger: every number below is a plain count, and the
 * headline ratio is nothing but supportedCount / totalFragments. There
 * is no hidden weighting to distrust.
 * ------------------------------------------------------------------ */

export interface ConfidenceBreakdown {
  totalFragments: number;
  supportedCount: number;
  overgeneralizedCount: number;
  weakEvidenceCount: number;
  noEvidenceCount: number;
  supportRatio: number;
  sourceGapCount: number;
  freshnessRiskCount: number;
  ledger: string[];
}

export function computeConfidence(
  fragments: FragmentAnalysis[],
  freshness: FreshnessAssessment[],
  sourceGaps: string[],
): ConfidenceBreakdown {
  const totalFragments = fragments.length;
  const supportedCount = fragments.filter((f) => f.status === 'supported').length;
  const overgeneralizedCount = fragments.filter((f) => f.status === 'overgeneralized').length;
  const weakEvidenceCount = fragments.filter((f) => f.status === 'weak-evidence').length;
  const noEvidenceCount = fragments.filter((f) => f.status === 'no-evidence').length;
  const supportRatio = totalFragments === 0 ? 0 : supportedCount / totalFragments;
  const freshnessRiskCount = freshness.filter((f) => f.risk !== 'fresh').length;

  const ledger: string[] = [];
  ledger.push(
    totalFragments === 0
      ? 'No claim fragments to assess yet.'
      : `${supportedCount} of ${totalFragments} fragment${totalFragments === 1 ? '' : 's'} (${Math.round(supportRatio * 100)} percent) are supported by evidence at or above the word overlap threshold.`,
  );
  if (overgeneralizedCount > 0) {
    ledger.push(`${overgeneralizedCount} fragment${overgeneralizedCount === 1 ? '' : 's'} overgeneralize a narrower piece of evidence.`);
  }
  if (weakEvidenceCount > 0) {
    ledger.push(`${weakEvidenceCount} fragment${weakEvidenceCount === 1 ? '' : 's'} have only weak evidence overlap.`);
  }
  if (noEvidenceCount > 0) {
    ledger.push(`${noEvidenceCount} fragment${noEvidenceCount === 1 ? '' : 's'} have no supporting evidence at all.`);
  }
  if (sourceGaps.length > 0) {
    ledger.push(`${sourceGaps.length} source gap${sourceGaps.length === 1 ? '' : 's'} found, listed below.`);
  }
  if (freshnessRiskCount > 0) {
    ledger.push(`${freshnessRiskCount} of ${freshness.length} source${freshness.length === 1 ? '' : 's'} carry freshness risk.`);
  }

  return {
    totalFragments,
    supportedCount,
    overgeneralizedCount,
    weakEvidenceCount,
    noEvidenceCount,
    supportRatio,
    sourceGapCount: sourceGaps.length,
    freshnessRiskCount,
    ledger,
  };
}

/* ------------------------------------------------------------------ *
 * Rewritten evidence calibrated claim
 *
 * The same discipline as prompt-lab.ts's improvePrompt: a rule based
 * rewrite, every change carries a stated reason, and nothing is
 * invented. A fragment the evidence does not support gets flagged, not
 * silently kept; a fragment that overgeneralizes gets narrowed to the
 * scope the evidence actually showed.
 * ------------------------------------------------------------------ */

export interface Change {
  fragmentIndex: number;
  before: string;
  after: string;
  reason: string;
}

export interface Rewrite {
  text: string;
  changes: Change[];
}

export function rewriteClaim(fragments: FragmentAnalysis[]): Rewrite {
  const changes: Change[] = [];
  const parts: string[] = [];

  for (const f of fragments) {
    const original = f.fragment.text;
    let next = original;

    if (f.status === 'no-evidence') {
      next = `${original} [No supplied evidence supports this.]`;
      changes.push({
        fragmentIndex: f.fragment.index,
        before: original,
        after: next,
        reason: 'No source overlaps this fragment at all, so the calibrated claim marks it unsupported rather than silently repeating it.',
      });
    } else if (f.status === 'weak-evidence') {
      next = `${original} [Only weak evidence overlap found; treat as unverified.]`;
      changes.push({
        fragmentIndex: f.fragment.index,
        before: original,
        after: next,
        reason: 'The best matching source shares some wording with this fragment but not enough to call it supported.',
      });
    } else if (f.status === 'overgeneralized' && f.generalizing && f.narrowing) {
      const g = f.generalizing;
      const replacement = `in the narrower scope the evidence covers ("${f.narrowing.excerpt}")`;
      next = original.slice(0, g.start) + replacement + original.slice(g.end);
      changes.push({
        fragmentIndex: f.fragment.index,
        before: original,
        after: next,
        reason: `The claim generalized with "${g.excerpt}" but the best matching evidence is narrower ("${f.narrowing.excerpt}"), so the calibrated claim is scoped down to match what was actually shown.`,
      });
    } else if (f.ambiguous) {
      next = `${original} [Name the specific source behind this.]`;
      changes.push({
        fragmentIndex: f.fragment.index,
        before: original,
        after: next,
        reason: 'This fragment appeals to an unnamed authority or an unquantified magnitude, which cannot be checked against a specific source.',
      });
    }

    parts.push(next);
  }

  return { text: parts.join(' '), changes };
}

/* ------------------------------------------------------------------ *
 * Claim state and analysis
 * ------------------------------------------------------------------ */

export type RaterAgreementKind = 'categorical' | 'continuous';

export const RATER_AGREEMENT_KIND_OPTIONS: Array<{ value: RaterAgreementKind; label: string }> = [
  { value: 'categorical', label: 'Categorical labels, for example supported/unsupported' },
  { value: 'continuous', label: 'Continuous numbers, for example a 1 to 10 confidence score' },
];

export interface SignalState {
  claim: string;
  /** Always exactly four slots, source-1 through source-4. Blank text means the slot is unused. */
  sources: EvidenceSource[];
  raterAgreementKind: RaterAgreementKind;
  raterPairedDataRaw: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function activeSources(state: SignalState): EvidenceSource[] {
  return state.sources.filter((s) => s.text.trim().length > 0);
}

export interface ClaimAnalysis {
  fragments: FragmentAnalysis[];
  freshness: FreshnessAssessment[];
  sourceGaps: string[];
  confidence: ConfidenceBreakdown;
  rewrite: Rewrite;
}

export function analyzeClaim(state: SignalState, asOf: Date = new Date()): ClaimAnalysis {
  const sources = activeSources(state);
  const fragments = splitClaimFragments(state.claim).map((f) => analyzeFragment(f, sources));
  const freshness = sources.map((s) => assessFreshness(s, asOf));
  const sourceGaps = computeSourceGaps(fragments, sources);
  const confidence = computeConfidence(fragments, freshness, sourceGaps);
  const rewrite = rewriteClaim(fragments);
  return { fragments, freshness, sourceGaps, confidence, rewrite };
}

/* ------------------------------------------------------------------ *
 * Inter-rater agreement, a secondary panel
 *
 * Where a user has two people independently judging whether each
 * fragment is supported, agreement statistics are a legitimate check on
 * the JUDGES, distinct from the primary claim assessment above. Cohen's
 * kappa and Pearson correlation are unchanged from their original
 * verification: only the framing moved, from measuring a proxy metric
 * to measuring whether two annotators agree on claim support.
 * ------------------------------------------------------------------ */

export interface PairedRow {
  proxyValue: string;
  outcomeValue: string;
}

export interface ParsedPairedData {
  rows: PairedRow[];
  skipped: number;
}

/** One pair per line: "rater A value, rater B value". # starts a comment line. */
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

/** Builds "a, b" raw text from counts rather than typing hundreds of literal lines. */
export function buildPairedRaw(counts: Array<[string, string, number]>): string {
  const lines: string[] = [];
  for (const [proxyValue, outcomeValue, n] of counts) {
    for (let i = 0; i < n; i++) lines.push(`${proxyValue}, ${outcomeValue}`);
  }
  return lines.join('\n');
}

export interface KappaResult {
  kappa: number;
  observedAgreement: number;
  chanceAgreement: number;
  n: number;
  categories: string[];
  confusionMatrix: number[][];
  degenerate: boolean;
}

/**
 * IMPORTANT ON LABELS: kappa only means agreement when both raters use
 * the SAME set of category labels, the same way two human raters must
 * both use "supported" and "unsupported" rather than one saying
 * "yes/no" and the other "strong/weak". A caller passing mismatched
 * vocabularies gets a real, honestly low kappa rather than a crash.
 */
export function cohensKappa(pairs: Array<{ proxy: string; outcome: string }>): KappaResult {
  const n = pairs.length;
  if (n === 0) {
    return { kappa: 0, observedAgreement: 0, chanceAgreement: 0, n: 0, categories: [], confusionMatrix: [], degenerate: true };
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
  // Whenever pe is 1, po is provably 1 too, so the safe fallback is 1,
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
      'in the sample, not a demonstrated ability to distinguish agreement from chance.'
    );
  }
  const band = KAPPA_BANDS.find((b) => result.kappa <= b.max) ?? KAPPA_BANDS[KAPPA_BANDS.length - 1];
  return `${band.label} agreement (Landis and Koch scale), corrected for the agreement expected by chance alone`;
}

export interface CorrelationResult {
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
    return { r: null, n, degenerate: true };
  }

  return { r: numerator / Math.sqrt(sumSqX * sumSqY), n, degenerate: false };
}

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

export type RaterAgreementResult =
  | { kind: 'none'; reason: string }
  | { kind: 'categorical'; n: number; skipped: number; kappa: KappaResult; interpretation: string }
  | { kind: 'continuous'; n: number; skipped: number; correlation: CorrelationResult; interpretation: string };

export function computeRaterAgreement(state: SignalState): RaterAgreementResult {
  const parsed = parsePairedRows(state.raterPairedDataRaw);

  if (parsed.rows.length === 0) {
    return {
      kind: 'none',
      reason: parsed.skipped > 0
        ? `${parsed.skipped} line${parsed.skipped === 1 ? '' : 's'} could not be read as "rater A value, rater B value". No usable paired data yet.`
        : 'No paired rater data supplied. This panel is optional; the claim assessment above does not need it.',
    };
  }

  if (state.raterAgreementKind === 'categorical') {
    if (parsed.rows.length < 2) {
      return { kind: 'none', reason: 'At least two paired rows are needed to compute a kappa.' };
    }
    const kappa = cohensKappa(parsed.rows.map((r) => ({ proxy: r.proxyValue, outcome: r.outcomeValue })));
    return { kind: 'categorical', n: parsed.rows.length, skipped: parsed.skipped, kappa, interpretation: interpretKappa(kappa) };
  }

  const numeric = parseNumericPairs(parsed.rows);
  if (numeric.pairs.length < 2) {
    return { kind: 'none', reason: 'At least two numeric paired rows are needed to compute a correlation.' };
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
 * Samples
 *
 * Four samples. Each ships a claim, up to four evidence sources, and
 * teaches a different piece of the tool: a clean overgeneralization
 * leap, a version scoped narrowing with an undated source, an ambiguity
 * flag alongside a properly scoped fact, and a fully supported baseline
 * with a future dated anomaly. Two of the four also carry rater
 * agreement data, keeping that panel proven end to end.
 * ------------------------------------------------------------------ */

function padSources(sources: EvidenceSource[]): EvidenceSource[] {
  const out = [...sources];
  while (out.length < 4) out.push({ id: `source-${out.length + 1}`, text: '', sourceType: 'unspecified', date: '' });
  return out.slice(0, 4);
}

export interface Sample {
  id: string;
  name: string;
  teaches: string;
  state: SignalState;
}

export const SAMPLES: Sample[] = [
  {
    id: 'sensor-launch-claim',
    name: 'Sensor launch claim',
    teaches:
      'A clean, well supported fact next to an overgeneralization: the evidence covers only a regional survey, but the claim generalizes to the whole market. Two fragments, a prediction and an opinion, have no evidence at all.',
    state: {
      claim:
        'The new sensor sold two million units in its first month. This suggests strong regional demand in general. ' +
        'Sales will exceed ten million units by 2027. This is clearly the best launch in the company history.',
      sources: padSources([
        {
          id: 'source-1',
          text: 'Internal sales records show the sensor sold 2,000,000 units in its first month across retail channels.',
          sourceType: 'primary-data',
          date: isoDaysAgo(20),
        },
        {
          id: 'source-2',
          text:
            'Internal analysts said the data suggests strong regional demand, but only among surveyed buyers in the ' +
            'northeast, not a general national trend.',
          sourceType: 'analysis-or-opinion',
          date: isoDaysAgo(25),
        },
      ]),
      raterAgreementKind: 'categorical',
      // The classic worked example, reframed: two annotators judged whether each of 50 claim
      // fragments from a broader review batch were supported. Kappa 0.4, fair agreement, verified
      // by hand in the logic gate.
      raterPairedDataRaw: buildPairedRaw([
        ['supported', 'supported', 20],
        ['supported', 'unsupported', 5],
        ['unsupported', 'supported', 10],
        ['unsupported', 'unsupported', 15],
      ]),
    },
  },
  {
    id: 'patch-version-claim',
    name: 'Security patch claim',
    teaches:
      'The changelog is the only source and it is undated, its own freshness risk category. The claim generalizes to all supported versions while the changelog names two specific versions, an overgeneralization leap.',
    state: {
      claim:
        'The patch fixes the authentication bypass in all supported versions. This indicates that every known attack path is closed.',
      sources: padSources([
        {
          id: 'source-1',
          text:
            'The official changelog fixes the authentication bypass only in version 4.2 and 4.3; other supported ' +
            'versions remain vulnerable pending a later release.',
          sourceType: 'official-record',
          date: '',
        },
      ]),
      raterAgreementKind: 'categorical',
      raterPairedDataRaw: '',
    },
  },
  {
    id: 'battery-longevity-claim',
    name: 'Battery longevity claim',
    teaches:
      'An ambiguous "significantly longer" next to a fact that already scopes itself honestly to a single lab trial, so it is properly supported rather than flagged as a leap. The source is stale, over two years old.',
    state: {
      claim:
        'The new battery lasts significantly longer than the previous model. In our testing, it retained 95 percent ' +
        'capacity after 500 charge cycles in a single lab trial. This will change how people use the device daily.',
      sources: padSources([
        {
          id: 'source-1',
          text: 'Battery tests were conducted in a single lab trial and showed 95 percent capacity retention after 500 cycles.',
          sourceType: 'primary-data',
          date: isoDaysAgo(900),
        },
      ]),
      raterAgreementKind: 'continuous',
      // Two annotators each gave a 1 to 10 confidence score per fragment across a broader batch.
      raterPairedDataRaw: buildPairedRaw([
        ['6', '5', 1],
        ['7', '6', 1],
        ['4', '4', 1],
        ['8', '9', 1],
        ['5', '7', 1],
        ['9', '8', 1],
      ]),
    },
  },
  {
    id: 'onboarding-flow-claim',
    name: 'Onboarding flow claim',
    teaches:
      'A fully supported baseline: this tool is not only a doom machine. It still only confirms the claim matches the evidence supplied, not that the evidence is true. A second source is dated in the future, a data problem worth catching.',
    state: {
      claim:
        'The new onboarding flow reduced signup time from six minutes to two minutes in our A/B test. Completion rates rose from 61 percent to 84 percent among the test group.',
      sources: padSources([
        {
          id: 'source-1',
          text:
            'The A/B test report shows signup time fell from six minutes to two minutes and completion rates rose ' +
            'from 61 percent to 84 percent among the test group.',
          sourceType: 'primary-data',
          date: isoDaysAgo(10),
        },
        {
          id: 'source-2',
          text: 'A follow up report confirms the onboarding improvement held into the next quarter.',
          sourceType: 'official-record',
          date: isoDaysAgo(-30),
        },
      ]),
      raterAgreementKind: 'categorical',
      raterPairedDataRaw: '',
    },
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

export function emptyState(): SignalState {
  return {
    claim: '',
    sources: padSources([]),
    raterAgreementKind: 'categorical',
    raterPairedDataRaw: '',
  };
}

export function sampleState(id: string = SAMPLES[0].id): SignalState {
  const sample = getSample(id) ?? SAMPLES[0];
  return {
    claim: sample.state.claim,
    sources: sample.state.sources.map((s) => ({ ...s })),
    raterAgreementKind: sample.state.raterAgreementKind,
    raterPairedDataRaw: sample.state.raterPairedDataRaw,
  };
}

export function reset(): SignalState {
  return emptyState();
}

export function validate(state: SignalState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!state.claim.trim()) {
    issues.push({ field: 'claim', message: 'Paste the claim you want to check before running an assessment.', severity: 'error' });
  }

  const active = activeSources(state);
  if (state.claim.trim() && active.length === 0) {
    issues.push({
      field: 'sources',
      message: 'No evidence entered yet. Every fragment will show as unsupported until at least one source is added.',
      severity: 'warning',
    });
  }

  for (const s of active) {
    if (s.date.trim() && Number.isNaN(new Date(s.date).getTime())) {
      issues.push({
        field: `${s.id}.date`,
        message: `The date "${s.date}" for ${s.id} could not be read. Use YYYY-MM-DD or leave it blank.`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: SignalState, format: ExportFormat): string {
  const analysis = analyzeClaim(state);
  const rater = computeRaterAgreement(state);

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Signal Tester',
        note: 'Local static analysis. Nothing was fetched and no fact was checked against the world. This report only says whether the claim matches the evidence supplied.',
        state,
        analysis,
        raterAgreement: rater,
      },
      null,
      2,
    );
  }

  const list = (items: string[]) => (items.length ? items.map((item) => `1. ${item}`).join('\n') : '1. None recorded.');

  const fragmentLines = analysis.fragments.map((f) => {
    const evidence = f.bestLink
      ? `best evidence: "${f.bestLink.excerpt}" from ${f.bestLink.sourceId}, overlap ${(f.bestLink.overlapRatio * 100).toFixed(0)} percent`
      : 'no evidence overlap found';
    return `1. [${SUPPORT_STATUS_LABELS[f.status]}] (${FRAGMENT_KIND_LABELS[f.kind]}) "${f.fragment.text}". ${evidence}.`;
  });

  const sourceLines = activeSources(state).map((s, i) => {
    const fresh = analysis.freshness[i];
    return `1. ${s.id} (${SOURCE_TYPE_LABELS[s.sourceType]}, ${s.date || 'undated'}): ${fresh.note}`;
  });

  const raterLines: string[] = [];
  if (rater.kind === 'categorical') {
    raterLines.push(
      `Categorical agreement over ${rater.n} paired cases (${rater.skipped} skipped).`,
      `Raw agreement: ${(rater.kappa.observedAgreement * 100).toFixed(1)} percent.`,
      `Cohen's kappa: ${rater.kappa.kappa.toFixed(3)}, ${rater.interpretation}.`,
    );
  } else if (rater.kind === 'continuous') {
    raterLines.push(
      `Continuous correlation over ${rater.n} paired cases (${rater.skipped} skipped).`,
      `Pearson r: ${rater.correlation.r === null ? 'undefined' : rater.correlation.r.toFixed(3)}, ${rater.interpretation}.`,
    );
  } else {
    raterLines.push(`No rater agreement computed. ${rater.reason}`);
  }

  const reportLines = [
    '# Signal Tester report',
    '',
    'Local static analysis. Nothing was fetched and no fact was checked against the world. This report only says whether the claim matches the evidence supplied.',
    '',
    `Claim: ${state.claim || '(not stated)'}`,
    '',
    '## Support map',
    '',
    ...(fragmentLines.length ? fragmentLines : ['1. No claim fragments yet.']),
    '',
    '## Sources',
    '',
    ...(sourceLines.length ? sourceLines : ['1. No evidence supplied.']),
    '',
    '## Source gaps',
    '',
    list(analysis.sourceGaps),
    '',
    '## Confidence',
    '',
    ...analysis.confidence.ledger.map((l) => `1. ${l}`),
    '',
    '## Rewritten evidence calibrated claim',
    '',
    analysis.rewrite.text || '(nothing to rewrite yet)',
    '',
    ...analysis.rewrite.changes.map((c) => `1. ${c.reason}`),
    '',
    '## Rater agreement, secondary panel',
    '',
    ...raterLines,
    '',
  ];

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
