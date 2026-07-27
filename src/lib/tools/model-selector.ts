/**
 * Model Selector, scoring engine.
 *
 * PRD: tools-nixfred-prds/tools/05-MODEL-SELECTOR.md
 * User outcome: turn workload requirements into a defensible model
 * selection shortlist.
 *
 * HONESTY BOUNDARIES FROM THE PRD AND 00-PRODUCT-VISION.md, enforced by
 * the shape of this file rather than left as a promise:
 *
 * 1. This catalog ships NO capability, latency, or throughput rating of
 *    its own. Those three axes used to carry an invented editorial tier
 *    (capabilityTier, latencyClass, throughputTier) that ranked every
 *    candidate by default as though a guess were a fact. That default
 *    ranking on invented tiers was the exact defect this file was
 *    rewritten to remove, and it is not coming back under a different
 *    name. A candidate is scored on capability, latency, or throughput
 *    only once a rating for that axis is supplied through userRatings,
 *    by a person working from their own evals or experience, the only
 *    signal this tool trusts for those three axes. Absent a rating, the
 *    axis is reported as unmodeled, named plainly in the why text, in
 *    unmodeledAxes, and in the export. Never silently dropped and never
 *    presented as though the ranking were complete without it. See
 *    scoreCapability, scoreLatency, scoreThroughput, unmodeledAxes, and
 *    ratedFields.
 * 2. Only OBJECTIVE, published facts are allowed to eliminate a
 *    candidate outright. That is why the five hard constraints below
 *    are context window size, vision support, tool use support,
 *    hosting availability, and published or estimated price against a
 *    stated ceiling, and why capability, latency, and throughput never
 *    appear in evaluateHardConstraints, whether unrated or rated by a
 *    user. A rating is still a judgment, even a real one supplied by a
 *    person, and a judgment is never allowed to silently kill a
 *    candidate the way an objective fact can.
 * 3. Nothing here computes a single "best model." rankCandidates
 *    returns a ranking that is a pure function of the stated
 *    requirements, weights, and whatever ratings were supplied, and
 *    computeSensitivity always names what would have to change for the
 *    runner up to win instead.
 *
 * Pure functions only. No DOM, no globals, no I/O, no network. The
 * catalog is static versioned data with a source and a date on every
 * price, and nothing softer than that.
 */

/* ------------------------------------------------------------------ *
 * Requirement vocabularies
 * ------------------------------------------------------------------ */

export const TASK_TYPES = [
  'general-chat',
  'coding',
  'reasoning-and-analysis',
  'extraction-and-structured-output',
  'long-document-summarization',
  'agentic-tool-use',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  'general-chat': 'General chat and assistance',
  coding: 'Writing or reviewing code',
  'reasoning-and-analysis': 'Multi step reasoning or analysis',
  'extraction-and-structured-output': 'Extraction into structured output',
  'long-document-summarization': 'Long document summarization',
  'agentic-tool-use': 'Autonomous multi step tool use',
};

/**
 * Shared by a workload's stated accuracy bar and a candidate's user
 * supplied capability rating. This tool ships no value on this scale
 * for any catalog entry. See ModelUserRating.
 */
export const CAPABILITY_TIERS = ['basic', 'solid', 'high', 'frontier'] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export const CAPABILITY_TIER_LABELS: Record<CapabilityTier, string> = {
  basic: 'Basic, simple well defined tasks',
  solid: 'Solid, everyday production tasks',
  high: 'High, demanding tasks with real stakes',
  frontier: 'Frontier, the hardest tasks available today',
};

const CAPABILITY_RANK: Record<CapabilityTier, number> = {
  basic: 0,
  solid: 1,
  high: 2,
  frontier: 3,
};

/** The scale a user picks a latency rating from. No catalog entry ships one. */
export const LATENCY_CLASSES = ['fast', 'standard', 'slow'] as const;
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

/**
 * Representative time to a usable response, in milliseconds, for each
 * point on the latency rating scale. A coarse label meaning, stated
 * here so the UI can render the number next to the label rather than
 * hiding it. Still just a label meaning, not a measurement of any
 * particular candidate, which is why it only applies once a person
 * rates a candidate on this scale.
 */
export const LATENCY_CLASS_MS: Record<LatencyClass, number> = {
  fast: 900,
  standard: 2200,
  slow: 5000,
};

export const LATENCY_CLASS_LABELS: Record<LatencyClass, string> = {
  fast: 'Fast, typically under a second to a first useful token',
  standard: 'Standard, typically a couple of seconds',
  slow: 'Slow, typically several seconds, often extended reasoning',
};

/** The scale a user picks a throughput rating from. No catalog entry ships one. */
export const THROUGHPUT_TIERS = ['limited', 'standard', 'scale'] as const;
export type ThroughputTier = (typeof THROUGHPUT_TIERS)[number];

export const THROUGHPUT_TIER_LABELS: Record<ThroughputTier, string> = {
  limited: 'Limited, tight rate limits, not built for high volume',
  standard: 'Standard, adequate for typical production volume',
  scale: 'Scale, built or hostable for high sustained volume',
};

const THROUGHPUT_RANK: Record<ThroughputTier, number> = {
  limited: 0,
  standard: 1,
  scale: 2,
};

export const THROUGHPUT_NEEDS = ['low', 'medium', 'high'] as const;
export type ThroughputNeed = (typeof THROUGHPUT_NEEDS)[number];

export const THROUGHPUT_NEED_LABELS: Record<ThroughputNeed, string> = {
  low: 'Low, occasional or single user requests',
  medium: 'Medium, a steady stream across a team or a small product',
  high: 'High, sustained volume across many concurrent users',
};

const THROUGHPUT_NEED_RANK: Record<ThroughputNeed, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** What a model's vendor makes available. Objective and published. */
export const HOSTING_MODES = ['vendor-api', 'private-cloud', 'self-hosted'] as const;
export type HostingMode = (typeof HOSTING_MODES)[number];

/** What the workload requires. "any" accepts a plain vendor API call. */
export const HOSTING_REQUIREMENTS = ['any', 'private-cloud', 'self-hosted'] as const;
export type HostingRequirement = (typeof HOSTING_REQUIREMENTS)[number];

export const HOSTING_REQUIREMENT_LABELS: Record<HostingRequirement, string> = {
  any: 'No constraint, a plain vendor API call is fine',
  'private-cloud':
    'Must run inside a private cloud deployment, for example a cloud marketplace or a dedicated enterprise tenant',
  'self-hosted': 'Must be self hostable entirely on your own infrastructure',
};

/**
 * Short descriptive phrase for a hosting requirement, used inside a
 * hard check sentence where the imperative labels above read awkwardly
 * ("available as must run inside..."). The "any" case is never read,
 * since callers only reach this once hostingRequirement is not "any".
 */
function hostingDescription(requirement: HostingRequirement): string {
  if (requirement === 'private-cloud') return 'a private cloud deployment';
  if (requirement === 'self-hosted') return 'a self hosted deployment on your own infrastructure';
  return 'no hosting constraint';
}

export const DATA_SENSITIVITIES = ['public', 'internal', 'confidential', 'regulated'] as const;
export type DataSensitivity = (typeof DATA_SENSITIVITIES)[number];

export const DATA_SENSITIVITY_LABELS: Record<DataSensitivity, string> = {
  public: 'Public, no confidentiality concern',
  internal: 'Internal, ordinary business confidentiality',
  confidential: 'Confidential, meaningful harm if disclosed',
  regulated: 'Regulated, subject to a specific compliance regime',
};

export const PRICE_CONFIDENCES = ['published', 'estimate', 'placeholder'] as const;
export type PriceConfidence = (typeof PRICE_CONFIDENCES)[number];

export const PRICE_CONFIDENCE_LABELS: Record<PriceConfidence, string> = {
  published: 'Published vendor list price',
  estimate: 'Estimate, not an official vendor price',
  placeholder: 'Placeholder, unconfirmed, do not treat as a quote',
};

/* ------------------------------------------------------------------ *
 * The catalog
 *
 * PRD boundary: "The model catalog is versioned data with sources and
 * dates." Every field on ModelEntry below is a published spec, a well
 * documented fact, or a dated price with a named source. Nothing softer
 * than that lives here. capabilityTier, latencyClass, and
 * throughputTier used to ship on this catalog as this tool's own
 * editorial priors, ranked by default as though they were measured.
 * They do not anymore. See ModelUserRating for where a capability,
 * latency, or throughput signal comes from now: a person, not this
 * catalog.
 * ------------------------------------------------------------------ */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  /** Published spec. Used in a hard constraint. */
  contextWindowTokens: number;
  /** Published spec. Used in a hard constraint. */
  supportsVision: boolean;
  /** Published spec. Used in a hard constraint. */
  supportsToolUse: boolean;
  /** Published or well documented availability. Used in a hard constraint. */
  hosting: HostingMode[];
  /** Dollars per million input tokens. */
  pricePerMillionInput: number;
  /** Dollars per million output tokens. */
  pricePerMillionOutput: number;
  priceConfidence: PriceConfidence;
  /** Where the price came from, or why it is a placeholder. */
  priceSource: string;
  /** ISO date the price was true, or the date a placeholder was drafted. */
  priceEffectiveDate: string;
  /** Any other caveat worth stating plainly. */
  notes?: string;
}

export const CATALOG: ModelEntry[] = [
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'Anthropic',
    contextWindowTokens: 200000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    pricePerMillionInput: 5,
    pricePerMillionOutput: 25,
    priceConfidence: 'published',
    priceSource:
      'Anthropic published list price, first party model table cached 2026-06-24.',
    priceEffectiveDate: '2026-06-24',
    notes:
      'Corrected 2026-07-26. This row previously carried an extrapolated placeholder of $15 and $75, which was three times the real price and disagreed with the Token and Cost Planner on the same model. Both tools now read the same published figures.',
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'Anthropic',
    contextWindowTokens: 200000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    pricePerMillionInput: 3,
    pricePerMillionOutput: 15,
    priceConfidence: 'published',
    priceSource:
      'Anthropic published list price, first party model table cached 2026-06-24.',
    priceEffectiveDate: '2026-06-24',
    notes:
      'Introductory pricing of $2 and $10 per million tokens runs through 2026-08-31. The figures here are the standard rates that apply after it, so a near term estimate using this row is conservative rather than optimistic.',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    contextWindowTokens: 200000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    pricePerMillionInput: 1,
    pricePerMillionOutput: 5,
    priceConfidence: 'published',
    priceSource:
      'Anthropic published list price, first party model table cached 2026-06-24.',
    priceEffectiveDate: '2026-06-24',
    notes:
      'Context window is 200000 tokens, smaller than the 1M window on the Claude 5 family. That is a hard constraint, not a preference, so it eliminates this candidate outright on long context workloads.',
  },
  {
    id: 'gpt-4o',
    name: 'GPT 4o',
    provider: 'OpenAI',
    contextWindowTokens: 128000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    pricePerMillionInput: 2.5,
    pricePerMillionOutput: 10,
    priceConfidence: 'published',
    priceSource: 'OpenAI published API list price at the date below.',
    priceEffectiveDate: '2024-05-13',
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT 4o mini',
    provider: 'OpenAI',
    contextWindowTokens: 128000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    pricePerMillionInput: 0.15,
    pricePerMillionOutput: 0.6,
    priceConfidence: 'published',
    priceSource: 'OpenAI published API list price at the date below.',
    priceEffectiveDate: '2024-07-18',
  },
  {
    id: 'gpt-4-1',
    name: 'GPT 4.1',
    provider: 'OpenAI',
    contextWindowTokens: 1000000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    pricePerMillionInput: 2,
    pricePerMillionOutput: 8,
    priceConfidence: 'published',
    priceSource: 'OpenAI published API list price at the date below.',
    priceEffectiveDate: '2025-04-14',
  },
  {
    id: 'llama-3-3-70b',
    name: 'Llama 3.3 70B',
    provider: 'Meta, open weights',
    contextWindowTokens: 128000,
    supportsVision: false,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud', 'self-hosted'],
    pricePerMillionInput: 0.6,
    pricePerMillionOutput: 0.6,
    priceConfidence: 'estimate',
    priceSource:
      'Approximate typical hosted inference price from a third party provider. Meta does not charge for the model weights, and self hosted cost depends entirely on your own infrastructure.',
    priceEffectiveDate: '2024-12-06',
    notes: 'Text only. Does not accept image input.',
  },
  {
    id: 'deepseek-v3',
    name: 'DeepSeek V3',
    provider: 'DeepSeek, open weights',
    contextWindowTokens: 64000,
    supportsVision: false,
    supportsToolUse: true,
    hosting: ['vendor-api', 'self-hosted'],
    pricePerMillionInput: 0.27,
    pricePerMillionOutput: 1.1,
    priceConfidence: 'published',
    priceSource: 'DeepSeek published API list price at the date below, standard rate.',
    priceEffectiveDate: '2024-12-26',
    notes: 'Text only.',
  },
];

/**
 * Above this many days old, a price gets flagged as stale. Ninety days,
 * about one quarter, because major model vendors commonly change list
 * pricing or ship a new flagship on roughly that cadence. Past this
 * threshold a comparison risks missing a change that would have altered
 * the outcome, which is exactly the risk this tool actively warns
 * about, not just an old timestamp.
 */
export const STALE_THRESHOLD_DAYS = 90;

/**
 * The consequence, stated plainly, that makes staleness worth an active
 * warning rather than a printed date left for the reader to do the
 * arithmetic on. Reused by the page and by the export, so the two
 * surfaces never drift apart on what the risk actually is.
 */
export const STALE_RISK_STATEMENT =
  'A stale catalog risks more than an out of date price. A model that would have changed this ranking may have shipped, or an existing price may have moved, since the oldest entry below was checked, and a catalog this old cannot know about either one. Treat the ranking above as provisional until the stale entries are confirmed.';

function daysBetween(dateStr: string, reference: Date): number {
  const then = new Date(`${dateStr}T00:00:00Z`).getTime();
  return Math.floor((reference.getTime() - then) / (1000 * 60 * 60 * 24));
}

/** Days since a single model's price was last checked, given a reference date. */
export function daysSincePriceDate(model: ModelEntry, reference: Date = new Date()): number {
  return daysBetween(model.priceEffectiveDate, reference);
}

/** Whether a single model's price is past the staleness threshold. */
export function isModelStale(model: ModelEntry, reference: Date = new Date()): boolean {
  return daysSincePriceDate(model, reference) > STALE_THRESHOLD_DAYS;
}

export interface StaleModel {
  model: ModelEntry;
  days: number;
}

export interface CatalogStaleness {
  total: number;
  staleCount: number;
  thresholdDays: number;
  oldest: ModelEntry;
  oldestDays: number;
  /** Every candidate past the threshold, oldest first. Empty when none are stale. */
  staleModels: StaleModel[];
}

/**
 * Pure given a reference date, so it is testable without the system
 * clock, and so the page can compute this against the actual date in
 * the visitor's browser at load time rather than baking in a build
 * time answer that quietly goes wrong the longer a static build sits
 * unpublished.
 */
export function catalogStaleness(reference: Date = new Date()): CatalogStaleness {
  const withAge = CATALOG.map((model) => ({
    model,
    days: daysSincePriceDate(model, reference),
  }));
  const staleModels = withAge
    .filter((w) => w.days > STALE_THRESHOLD_DAYS)
    .sort((a, b) => b.days - a.days);
  const oldest = withAge.reduce((a, b) => (b.days > a.days ? b : a));
  return {
    total: CATALOG.length,
    staleCount: staleModels.length,
    thresholdDays: STALE_THRESHOLD_DAYS,
    oldest: oldest.model,
    oldestDays: oldest.days,
    staleModels,
  };
}

/* ------------------------------------------------------------------ *
 * Requirements, weights, and the editable assumptions
 * ------------------------------------------------------------------ */

export interface WorkloadRequirements {
  taskType: TaskType;
  accuracyBar: CapabilityTier;
  contextNeededTokens: number;
  /** Null means no stated ceiling, batch or async work. */
  latencyCeilingMs: number | null;
  /** Null means no stated ceiling. */
  costCeilingPerMTok: number | null;
  needsVision: boolean;
  needsToolUse: boolean;
  hostingRequirement: HostingRequirement;
  dataSensitivity: DataSensitivity;
  throughputNeed: ThroughputNeed;
}

export type AxisKey = 'capability' | 'cost' | 'latency' | 'throughput';
export const AXIS_KEYS: AxisKey[] = ['capability', 'cost', 'latency', 'throughput'];

export const AXIS_LABELS: Record<AxisKey, string> = {
  capability: 'Capability fit',
  cost: 'Cost efficiency',
  latency: 'Latency fit',
  throughput: 'Throughput fit',
};

/** The one axis this catalog carries data for on its own, no rating required. */
export const OBJECTIVE_AXES: AxisKey[] = ['cost'];

/**
 * The three axes with no catalog default. Each is modeled for a
 * candidate only once a rating for it is supplied through
 * ModelUserRating. See the honesty boundary at the top of this file.
 */
export const USER_RATED_AXES: AxisKey[] = ['capability', 'latency', 'throughput'];

export interface Weights {
  capability: number;
  cost: number;
  latency: number;
  throughput: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  capability: 40,
  cost: 25,
  latency: 20,
  throughput: 15,
};

/** Assumed split of tokens between input and output for blended cost. */
export interface TokenBlend {
  inputShare: number;
  outputShare: number;
}

export const DEFAULT_TOKEN_BLEND: TokenBlend = { inputShare: 0.75, outputShare: 0.25 };

export const RATED_FIELDS = ['capability', 'latency', 'throughput'] as const;
export type RatedField = (typeof RATED_FIELDS)[number];

/**
 * A user supplied rating for one candidate, on one or more of the axes
 * this catalog ships no data for. Every field starts absent, meaning
 * unrated, never defaulted to a value this tool invented. Absence is
 * the honest default, not a gap to paper over.
 */
export interface ModelUserRating {
  capability?: CapabilityTier;
  latency?: LatencyClass;
  throughput?: ThroughputTier;
}
export type UserRatings = Record<string, ModelUserRating>;

export interface SelectorState {
  requirements: WorkloadRequirements;
  weights: Weights;
  tokenBlend: TokenBlend;
  userRatings: UserRatings;
}

/**
 * Which axes a candidate carries a user supplied rating for, in a
 * stable order. Empty when the user has not rated this candidate at
 * all, which is also the shipped default for every candidate in the
 * catalog. This is the fact that makes a row "rated by you" rather than
 * "no rating supplied," a distinction the PRD requires to survive into
 * the export, not just show up as a badge on screen.
 */
export function ratedFields(modelId: string, userRatings: UserRatings): RatedField[] {
  const rating = userRatings[modelId];
  if (!rating) return [];
  return RATED_FIELDS.filter((field) => rating[field] !== undefined);
}

export function blendedCost(model: ModelEntry, tokenBlend: TokenBlend): number {
  return (
    model.pricePerMillionInput * tokenBlend.inputShare +
    model.pricePerMillionOutput * tokenBlend.outputShare
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  const suffix = rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/* ------------------------------------------------------------------ *
 * Hard constraints
 *
 * Every check here reads a published or well documented fact. None of
 * them reads a capability, latency, or throughput rating, shipped or
 * user supplied, on purpose, per the honesty boundary stated at the
 * top of this file.
 * ------------------------------------------------------------------ */

export type HardCheckKey = 'context' | 'vision' | 'tool-use' | 'hosting' | 'cost-ceiling';

export interface HardCheck {
  key: HardCheckKey;
  label: string;
  passed: boolean;
  message: string;
}

export function evaluateHardConstraints(
  model: ModelEntry,
  requirements: WorkloadRequirements,
  tokenBlend: TokenBlend,
): HardCheck[] {
  const contextOk = model.contextWindowTokens >= requirements.contextNeededTokens;
  const visionOk = !requirements.needsVision || model.supportsVision;
  const toolUseOk = !requirements.needsToolUse || model.supportsToolUse;
  const hostingOk =
    requirements.hostingRequirement === 'any' ||
    model.hosting.includes(requirements.hostingRequirement);
  const blended = blendedCost(model, tokenBlend);
  const costOk =
    requirements.costCeilingPerMTok == null || blended <= requirements.costCeilingPerMTok;

  return [
    {
      key: 'context',
      label: 'Context window',
      passed: contextOk,
      message: contextOk
        ? `Context window of ${fmtInt(model.contextWindowTokens)} tokens covers the ${fmtInt(requirements.contextNeededTokens)} tokens this workload needs.`
        : `Context window of ${fmtInt(model.contextWindowTokens)} tokens is smaller than the ${fmtInt(requirements.contextNeededTokens)} tokens this workload needs.`,
    },
    {
      key: 'vision',
      label: 'Vision input',
      passed: visionOk,
      message: !requirements.needsVision
        ? 'This workload does not require vision input.'
        : model.supportsVision
          ? 'Supports vision input, as this workload requires.'
          : 'Does not support vision input, which this workload requires.',
    },
    {
      key: 'tool-use',
      label: 'Tool or function calling',
      passed: toolUseOk,
      message: !requirements.needsToolUse
        ? 'This workload does not require tool or function calling.'
        : model.supportsToolUse
          ? 'Supports tool or function calling, as this workload requires.'
          : 'Does not support tool or function calling, which this workload requires.',
    },
    {
      key: 'hosting',
      label: 'Hosting and privacy',
      passed: hostingOk,
      message:
        requirements.hostingRequirement === 'any'
          ? 'This workload states no hosting or deployment constraint.'
          : hostingOk
            ? `Available as ${hostingDescription(requirements.hostingRequirement)}, as this workload requires.`
            : `Not available as ${hostingDescription(requirements.hostingRequirement)}, which this workload requires.`,
    },
    {
      key: 'cost-ceiling',
      label: 'Cost ceiling',
      passed: costOk,
      message:
        requirements.costCeilingPerMTok == null
          ? 'This workload states no cost ceiling.'
          : costOk
            ? `Blended cost of $${blended.toFixed(2)} per million tokens is at or under the stated $${requirements.costCeilingPerMTok.toFixed(2)} ceiling.`
            : `Blended cost of $${blended.toFixed(2)} per million tokens exceeds the stated $${requirements.costCeilingPerMTok.toFixed(2)} ceiling.`,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Soft, weighted axes
 *
 * Every score here comes with a "why" that never resolves to an empty
 * string. cost is always modeled, computed straight from published
 * catalog prices. capability, latency, and throughput are modeled only
 * when the state carries a user rating for that candidate on that axis,
 * and each says so plainly, both when modeled ("your rating of...") and
 * when not ("not modeled for this candidate... supply one").
 * ------------------------------------------------------------------ */

export interface AxisScore {
  axis: AxisKey;
  label: string;
  /** False when this candidate carries no rating for this axis. */
  modeled: boolean;
  /** Null exactly when modeled is false. */
  score: number | null;
  why: string;
}

function scoreCapability(
  model: ModelEntry,
  requirements: WorkloadRequirements,
  rating: CapabilityTier | undefined,
): AxisScore {
  if (rating === undefined) {
    return {
      axis: 'capability',
      label: AXIS_LABELS.capability,
      modeled: false,
      score: null,
      why: `Capability is not modeled for ${model.name}. This tool ships no capability rating of its own, invented or otherwise. Rate this candidate from your own evals or experience using the control on this row to bring capability into the ranking.`,
    };
  }

  const modelRank = CAPABILITY_RANK[rating];
  const requiredRank = CAPABILITY_RANK[requirements.accuracyBar];
  const gap = modelRank - requiredRank;
  const rawScore = gap >= 0 ? Math.min(100, 85 + gap * 5) : Math.max(0, 85 + gap * 35);
  const score = Math.round(rawScore);

  const gapWord =
    gap === 0
      ? 'meets'
      : gap > 0
        ? `exceeds by ${gap} tier${gap > 1 ? 's' : ''}`
        : `falls short by ${Math.abs(gap)} tier${Math.abs(gap) > 1 ? 's' : ''}`;

  return {
    axis: 'capability',
    label: AXIS_LABELS.capability,
    modeled: true,
    score,
    why: `Your capability rating of "${rating}" for ${model.name} ${gapWord} the stated "${requirements.accuracyBar}" bar. This rating is what you supplied, not a catalog default.`,
  };
}

function scoreCost(
  model: ModelEntry,
  tokenBlend: TokenBlend,
  allBlendedCosts: number[],
): AxisScore {
  const blended = blendedCost(model, tokenBlend);
  const min = Math.min(...allBlendedCosts);
  const max = Math.max(...allBlendedCosts);
  const score =
    max === min ? 100 : Math.round(100 - ((blended - min) / (max - min)) * 100);
  const cheaperCount = allBlendedCosts.filter((c) => c < blended).length;

  return {
    axis: 'cost',
    label: AXIS_LABELS.cost,
    modeled: true,
    score,
    why: `Blended cost estimate is $${blended.toFixed(2)} per million tokens, assuming ${Math.round(tokenBlend.inputShare * 100)} percent input and ${Math.round(tokenBlend.outputShare * 100)} percent output tokens. That is the ${ordinal(cheaperCount + 1)} cheapest of the ${allBlendedCosts.length} candidates in this catalog. Change the token blend assumption to match real traffic.`,
  };
}

function scoreLatency(
  model: ModelEntry,
  requirements: WorkloadRequirements,
  rating: LatencyClass | undefined,
): AxisScore {
  if (rating === undefined) {
    return {
      axis: 'latency',
      label: AXIS_LABELS.latency,
      modeled: false,
      score: null,
      why: `Latency is not modeled for ${model.name}. This tool ships no measured or vendor published latency figure. Rate this candidate from your own testing using the control on this row to bring latency into the ranking.`,
    };
  }

  const ms = LATENCY_CLASS_MS[rating];
  const ceiling = requirements.latencyCeilingMs;
  let score: number;
  let fitNote: string;

  if (ceiling == null) {
    const values = Object.values(LATENCY_CLASS_MS);
    const min = Math.min(...values);
    const max = Math.max(...values);
    score = Math.round(100 - ((ms - min) / (max - min)) * 100);
    fitNote = 'No latency ceiling was stated, so this rewards general responsiveness only.';
  } else if (ms <= ceiling) {
    const margin = (ceiling - ms) / ceiling;
    score = Math.round(clamp(70 + margin * 30, 70, 100));
    fitNote = `That sits within the stated ${fmtInt(ceiling)} millisecond ceiling with room to spare.`;
  } else {
    const overshoot = (ms - ceiling) / ceiling;
    score = Math.round(clamp(70 - overshoot * 100, 0, 70));
    fitNote = `That exceeds the stated ${fmtInt(ceiling)} millisecond ceiling.`;
  }

  return {
    axis: 'latency',
    label: AXIS_LABELS.latency,
    modeled: true,
    score,
    why: `Your latency rating of "${rating}" for ${model.name}, about ${fmtInt(ms)} milliseconds typical. ${fitNote} This rating is what you supplied, not a catalog default.`,
  };
}

function scoreThroughput(
  model: ModelEntry,
  requirements: WorkloadRequirements,
  rating: ThroughputTier | undefined,
): AxisScore {
  if (rating === undefined) {
    return {
      axis: 'throughput',
      label: AXIS_LABELS.throughput,
      modeled: false,
      score: null,
      why: `Throughput is not modeled for ${model.name}. This tool ships no rate limit or provisioned capacity rating of its own. Rate this candidate from your own testing using the control on this row to bring throughput into the ranking.`,
    };
  }

  const modelRank = THROUGHPUT_RANK[rating];
  const neededRank = THROUGHPUT_NEED_RANK[requirements.throughputNeed];
  const shortfall = neededRank - modelRank;
  const score = shortfall <= 0 ? 100 : shortfall === 1 ? 40 : 0;

  return {
    axis: 'throughput',
    label: AXIS_LABELS.throughput,
    modeled: true,
    score,
    why: `Your throughput rating of "${rating}" for ${model.name}, against the stated "${requirements.throughputNeed}" need. This rating is what you supplied, not a catalog default.`,
  };
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

export interface RankedCandidate {
  model: ModelEntry;
  hardChecks: HardCheck[];
  axisScores: AxisScore[];
  weightedScore: number;
  rank: number;
  /** Empty when no axis of this candidate carries a user supplied rating. */
  ratedFields: RatedField[];
}

export interface EliminatedCandidate {
  model: ModelEntry;
  hardChecks: HardCheck[];
  failedChecks: HardCheck[];
  ratedFields: RatedField[];
}

export interface SelectionResult {
  ranked: RankedCandidate[];
  eliminated: EliminatedCandidate[];
}

/**
 * A weighted average restricted to the axes actually modeled for this
 * candidate. cost is always modeled, so the denominator is never zero
 * across an empty set in practice, but the fallback below still covers
 * the case where every modeled axis happens to carry a zero weight. An
 * axis with no rating contributes nothing to either the numerator or
 * the denominator, which is the mechanism behind "ranking runs on the
 * objective axes only" when nothing has been rated: it is not that
 * unrated axes score zero, it is that they are excluded from the
 * average entirely, exactly as an unknown fact should be.
 */
export function computeWeightedScore(axisScores: AxisScore[], weights: Weights): number {
  const modeled = axisScores.filter((a) => a.modeled && a.score != null);
  const totalWeight = modeled.reduce((sum, a) => sum + weights[a.axis], 0);
  if (totalWeight <= 0) {
    return modeled.length
      ? modeled.reduce((sum, a) => sum + (a.score ?? 0), 0) / modeled.length
      : 0;
  }
  const sum = modeled.reduce((acc, a) => acc + (a.score ?? 0) * weights[a.axis], 0);
  return sum / totalWeight;
}

export function rankCandidates(state: SelectorState): SelectionResult {
  const allBlendedCosts = CATALOG.map((m) => blendedCost(m, state.tokenBlend));

  const ranked: RankedCandidate[] = [];
  const eliminated: EliminatedCandidate[] = [];

  for (const model of CATALOG) {
    const rating = state.userRatings[model.id];
    const fields = ratedFields(model.id, state.userRatings);
    const hardChecks = evaluateHardConstraints(model, state.requirements, state.tokenBlend);
    const failedChecks = hardChecks.filter((c) => !c.passed);

    if (failedChecks.length > 0) {
      eliminated.push({ model, hardChecks, failedChecks, ratedFields: fields });
      continue;
    }

    const axisScores: AxisScore[] = [
      scoreCapability(model, state.requirements, rating?.capability),
      scoreCost(model, state.tokenBlend, allBlendedCosts),
      scoreLatency(model, state.requirements, rating?.latency),
      scoreThroughput(model, state.requirements, rating?.throughput),
    ];
    const weightedScore = computeWeightedScore(axisScores, state.weights);
    ranked.push({ model, hardChecks, axisScores, weightedScore, rank: 0, ratedFields: fields });
  }

  ranked.sort((a, b) => b.weightedScore - a.weightedScore || a.model.name.localeCompare(b.model.name));
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });

  return { ranked, eliminated };
}

/**
 * Which of the three user rated axes carry no rating for ANY surviving
 * candidate in this result. Stated at the level of the whole ranking,
 * not just inside each candidate's own axis text, so the tool can say
 * plainly up front that a run used fewer than four axes rather than
 * leaving that fact to be discovered one row at a time. Empty once at
 * least one surviving candidate is rated on an axis.
 */
export function unmodeledAxes(result: SelectionResult): AxisKey[] {
  return USER_RATED_AXES.filter((axis) =>
    result.ranked.every((r) => {
      const a = r.axisScores.find((x) => x.axis === axis);
      return !a || !a.modeled;
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Tradeoffs: the runner up and what would have to change
 *
 * PRD requirement, restated in the brief for this tool: never present
 * a recommendation as objectively correct. Show what follows from the
 * stated weights, and show what would have to change for the runner up
 * to win.
 * ------------------------------------------------------------------ */

export interface SensitivityResult {
  possible: boolean;
  axis?: AxisKey;
  currentWeight?: number;
  requiredWeight?: number;
  message: string;
}

export function computeSensitivity(
  winner: RankedCandidate | undefined,
  runnerUp: RankedCandidate | undefined,
  weights: Weights,
): SensitivityResult {
  if (!winner) {
    return { possible: false, message: 'No candidate survived the stated hard constraints, so there is nothing to compare.' };
  }
  if (!runnerUp) {
    return {
      possible: false,
      message: `Only ${winner.model.name} survived the stated hard constraints, so there is no runner up to compare it against.`,
    };
  }

  // Restricted to axes BOTH candidates carry a modeled score for.
  // Raising the weight on an axis neither has a rating for, or only one
  // of them has a rating for, is not a lever either candidate's actual
  // score can respond to. cost is always in this set. When the two
  // candidates carry different rated axes beyond cost, this is an
  // approximation: it answers what would flip the ranking using only
  // what both of them have data for, which is not exactly the
  // derivative of computeWeightedScore, since that function normalizes
  // each candidate over its own modeled set rather than a shared one.
  const sharedAxes = AXIS_KEYS.filter((axis) => {
    const w = winner.axisScores.find((a) => a.axis === axis);
    const r = runnerUp.axisScores.find((a) => a.axis === axis);
    return Boolean(w?.modeled && r?.modeled);
  });

  let best: { axis: AxisKey; requiredWeight: number } | null = null;

  for (const axis of sharedAxes) {
    const winnerScore = winner.axisScores.find((a) => a.axis === axis)!.score!;
    const runnerScore = runnerUp.axisScores.find((a) => a.axis === axis)!.score!;
    if (runnerScore <= winnerScore) continue;

    let runnerRest = 0;
    let winnerRest = 0;
    for (const other of sharedAxes) {
      if (other === axis) continue;
      const w = weights[other];
      runnerRest += w * runnerUp.axisScores.find((a) => a.axis === other)!.score!;
      winnerRest += w * winner.axisScores.find((a) => a.axis === other)!.score!;
    }
    const denom = runnerScore - winnerScore;
    const requiredWeight = Math.max(0, (winnerRest - runnerRest) / denom);

    if (!best || requiredWeight < best.requiredWeight) {
      best = { axis, requiredWeight };
    }
  }

  if (!best) {
    return {
      possible: false,
      message: `${runnerUp.model.name} trails ${winner.model.name} on every axis both candidates have a rating for, so no single weight change flips this ranking. Rate another axis for one of them, or move multiple weights together.`,
    };
  }

  const currentWeight = weights[best.axis];
  return {
    possible: true,
    axis: best.axis,
    currentWeight,
    requiredWeight: best.requiredWeight,
    message: `${runnerUp.model.name} would outrank ${winner.model.name} if ${AXIS_LABELS[best.axis].toLowerCase()} were weighted at ${Math.round(best.requiredWeight)} or higher, up from the current ${currentWeight}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Unanswered questions and a recommended evaluation plan
 *
 * PRD Outputs: "Ranked candidates, disqualifiers, tradeoffs, unanswered
 * questions, and a recommended evaluation plan." The first three come
 * from rankCandidates and computeSensitivity above. These two close
 * the list, and both are pure functions of state and result so they
 * are as testable as everything else here.
 * ------------------------------------------------------------------ */

export function unansweredQuestions(state: SelectorState, result: SelectionResult): string[] {
  const questions: string[] = [];
  const { requirements } = state;

  const unmodeled = unmodeledAxes(result);
  if (unmodeled.length > 0 && result.ranked.length > 0) {
    questions.push(
      `${unmodeled.map((a) => AXIS_LABELS[a]).join(', ')} carry no rating for any surviving candidate, so this ranking runs on the remaining axes alone. Rate the candidates you are seriously considering, from your own evals or experience, to bring ${unmodeled.length > 1 ? 'those axes' : 'that axis'} into the ranking.`,
    );
  }
  if (requirements.dataSensitivity === 'regulated' && requirements.hostingRequirement === 'any') {
    questions.push(
      'Data sensitivity is marked regulated but no private cloud or self hosted requirement was stated. Confirm the vendor agreement and data processing terms cover this before proceeding.',
    );
  }
  if (requirements.throughputNeed === 'high') {
    questions.push(
      'Throughput need is marked high. State an actual expected request or token volume per day so a real rate limit and cost projection can be checked against it, since this tool only scores a throughput rating you supplied, coarse by nature.',
    );
  }
  if (requirements.costCeilingPerMTok == null) {
    questions.push(
      'No cost ceiling was stated. Every candidate passes the cost hard constraint by default in that case, and cost only affects the weighted ranking.',
    );
  }
  if (requirements.latencyCeilingMs == null) {
    questions.push(
      'No latency ceiling was stated. Latency is scored only as a soft preference for speed in that case, and only for candidates you have rated.',
    );
  }
  if (result.eliminated.length === CATALOG.length) {
    questions.push(
      'Every candidate in this catalog was eliminated by a hard constraint. Loosen the tightest one, most likely context size, cost ceiling, or the hosting requirement, and run this again.',
    );
  }
  if (result.ranked.length > 0) {
    questions.push(
      'Confirm whether this shortlist has been tested against real examples from this workload, since every score above comes from stated constraints, catalog prices, and whatever you rated, not from a live run.',
    );
  }

  return questions;
}

export function evaluationPlan(state: SelectorState, result: SelectionResult): string[] {
  if (result.ranked.length === 0) {
    return [
      'No candidate survived the stated hard constraints. Relax the tightest one and run this again before planning an evaluation.',
    ];
  }

  const top = result.ranked[0];
  const runnerUp = result.ranked[1];
  const plan: string[] = [];

  plan.push(
    `Collect 10 to 20 real examples from this workload and run them through ${top.model.name}${runnerUp ? ` and ${runnerUp.model.name}` : ''} directly, not through this tool.`,
  );
  if (unmodeledAxes(result).length > 0) {
    plan.push(
      'Rate capability, latency, or throughput for the candidates you are seriously considering, from your own evals or experience, before leaning on this ranking beyond cost. This tool ships none of those ratings itself.',
    );
  }
  plan.push('Score those outputs against a concrete pass or fail rule defined in advance, not general impressions.');
  plan.push(
    `Confirm current published pricing for ${top.model.name} directly with the vendor. This catalog dates that price to ${top.model.priceEffectiveDate} and marks it as ${PRICE_CONFIDENCE_LABELS[top.model.priceConfidence].toLowerCase()}.`,
  );
  if (state.requirements.hostingRequirement !== 'any') {
    plan.push(
      'Confirm the specific hosting or deployment option directly with the vendor before committing, since availability changes faster than this catalog is updated.',
    );
  }
  if (state.requirements.throughputNeed !== 'low') {
    plan.push(
      'Load test at the expected peak volume before committing, since published rate limits and any throughput rating you supplied are both coarse.',
    );
  }
  plan.push('Repeat this comparison when the catalog date is old or when a new model generation ships.');

  return plan;
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * Each sample bundles a workload with ILLUSTRATIVE user ratings, not
 * catalog data. They stand in for a person's own evals or experience,
 * entered exactly the way a visitor would enter them through the per
 * candidate rating controls on the page, so a sample demonstrates the
 * complete, honest workflow rather than a ranking that only ever runs
 * on cost. Loading Reset instead of a sample ships zero ratings, per
 * the honesty boundary at the top of this file.
 * ------------------------------------------------------------------ */

export interface Sample {
  id: string;
  name: string;
  teaches: string;
  requirements: WorkloadRequirements;
  weights: Weights;
  tokenBlend: TokenBlend;
  /** Illustrative, not shipped catalog data. See the comment above. */
  userRatings?: UserRatings;
}

/**
 * One illustrative rating set, reused across the sample workloads
 * below so all three demonstrate the same worked example. Not catalog
 * data. A visitor comparing real candidates should replace every one
 * of these with a number from their own evals or experience.
 */
const ILLUSTRATIVE_SAMPLE_RATINGS: UserRatings = {
  'claude-opus-5': { capability: 'frontier', latency: 'slow', throughput: 'limited' },
  'claude-sonnet-5': { capability: 'high', latency: 'standard', throughput: 'standard' },
  'claude-haiku-4-5': { capability: 'solid', latency: 'fast', throughput: 'scale' },
  'gpt-4o': { capability: 'high', latency: 'standard', throughput: 'standard' },
  'gpt-4o-mini': { capability: 'solid', latency: 'fast', throughput: 'scale' },
  'gpt-4-1': { capability: 'high', latency: 'standard', throughput: 'standard' },
  'llama-3-3-70b': { capability: 'solid', latency: 'standard', throughput: 'scale' },
  'deepseek-v3': { capability: 'high', latency: 'standard', throughput: 'scale' },
};

export const SAMPLES: Sample[] = [
  {
    id: 'support-triage-volume',
    name: 'High volume support triage',
    teaches:
      'Throughput and cost dominate this ranking once you rate the candidates, illustrated here with example ratings standing in for your own evaluation notes, since this tool ships none of its own.',
    requirements: {
      taskType: 'general-chat',
      accuracyBar: 'solid',
      contextNeededTokens: 6000,
      latencyCeilingMs: 3000,
      costCeilingPerMTok: 5,
      needsVision: false,
      needsToolUse: false,
      hostingRequirement: 'any',
      dataSensitivity: 'internal',
      throughputNeed: 'high',
    },
    weights: { capability: 20, cost: 35, latency: 20, throughput: 25 },
    tokenBlend: { inputShare: 0.75, outputShare: 0.25 },
    userRatings: ILLUSTRATIVE_SAMPLE_RATINGS,
  },
  {
    id: 'regulated-document-analysis',
    name: 'Regulated document analysis',
    teaches:
      'A hosting requirement and a large context need eliminate most of the catalog before ranking even starts, entirely from published facts, before any rating enters the picture.',
    requirements: {
      taskType: 'long-document-summarization',
      accuracyBar: 'high',
      contextNeededTokens: 400000,
      latencyCeilingMs: null,
      costCeilingPerMTok: null,
      needsVision: false,
      needsToolUse: false,
      hostingRequirement: 'private-cloud',
      dataSensitivity: 'regulated',
      throughputNeed: 'low',
    },
    weights: { capability: 50, cost: 15, latency: 10, throughput: 25 },
    tokenBlend: { inputShare: 0.85, outputShare: 0.15 },
    userRatings: ILLUSTRATIVE_SAMPLE_RATINGS,
  },
  {
    id: 'realtime-coding-copilot',
    name: 'Real time coding copilot',
    teaches:
      'Two candidates that both pass every hard constraint still trade places when the weights move, once each carries a capability and latency rating from your own experience.',
    requirements: {
      taskType: 'coding',
      accuracyBar: 'high',
      contextNeededTokens: 32000,
      latencyCeilingMs: 1500,
      costCeilingPerMTok: 20,
      needsVision: false,
      needsToolUse: true,
      hostingRequirement: 'any',
      dataSensitivity: 'confidential',
      throughputNeed: 'medium',
    },
    weights: { capability: 45, cost: 15, latency: 30, throughput: 10 },
    tokenBlend: { inputShare: 0.7, outputShare: 0.3 },
    userRatings: ILLUSTRATIVE_SAMPLE_RATINGS,
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

const DEFAULT_REQUIREMENTS: WorkloadRequirements = {
  taskType: 'general-chat',
  accuracyBar: 'solid',
  contextNeededTokens: 8000,
  latencyCeilingMs: null,
  costCeilingPerMTok: null,
  needsVision: false,
  needsToolUse: false,
  hostingRequirement: 'any',
  dataSensitivity: 'internal',
  throughputNeed: 'low',
};

export function emptyState(): SelectorState {
  return {
    requirements: { ...DEFAULT_REQUIREMENTS },
    weights: { ...DEFAULT_WEIGHTS },
    tokenBlend: { ...DEFAULT_TOKEN_BLEND },
    userRatings: {},
  };
}

export function sampleState(id: string = SAMPLES[0].id): SelectorState {
  const sample = getSample(id) ?? SAMPLES[0];
  return {
    requirements: { ...sample.requirements },
    weights: { ...sample.weights },
    tokenBlend: { ...sample.tokenBlend },
    userRatings: Object.fromEntries(
      Object.entries(sample.userRatings ?? {}).map(([modelId, rating]) => [modelId, { ...rating }]),
    ),
  };
}

export function reset(): SelectorState {
  return emptyState();
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: SelectorState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { requirements, weights, tokenBlend } = state;

  if (!Number.isFinite(requirements.contextNeededTokens) || requirements.contextNeededTokens <= 0) {
    issues.push({
      field: 'contextNeededTokens',
      message: 'Context needed must be a positive number of tokens.',
      severity: 'error',
    });
  }
  if (requirements.latencyCeilingMs != null && requirements.latencyCeilingMs <= 0) {
    issues.push({
      field: 'latencyCeilingMs',
      message: 'A stated latency ceiling must be a positive number of milliseconds, or left blank for none.',
      severity: 'error',
    });
  }
  if (requirements.costCeilingPerMTok != null && requirements.costCeilingPerMTok <= 0) {
    issues.push({
      field: 'costCeilingPerMTok',
      message: 'A stated cost ceiling must be a positive dollar amount, or left blank for none.',
      severity: 'error',
    });
  }
  const shareSum = tokenBlend.inputShare + tokenBlend.outputShare;
  if (Math.abs(shareSum - 1) > 0.01) {
    issues.push({
      field: 'tokenBlend',
      message: 'Input and output token shares must add to 100 percent.',
      severity: 'error',
    });
  }
  const totalWeight = AXIS_KEYS.reduce((sum, axis) => sum + weights[axis], 0);
  if (totalWeight <= 0) {
    issues.push({
      field: 'weights',
      message: 'All weights are zero. Ranking falls back to an unweighted average of whichever axes are modeled.',
      severity: 'warning',
    });
  }

  return issues;
}

export type ExportFormat = 'json' | 'markdown';

/**
 * Renders the same rating tag on screen and in export, so the two
 * surfaces cannot say different things about which axes carry a user
 * supplied rating for this candidate and which carry none.
 */
function ratingTag(fields: RatedField[]): string {
  return fields.length ? `user rated: ${fields.join(', ')}` : 'no rating supplied';
}

export function serialize(state: SelectorState, format: ExportFormat): string {
  const result = rankCandidates(state);
  const sensitivity = computeSensitivity(result.ranked[0], result.ranked[1], state.weights);
  const questions = unansweredQuestions(state, result);
  const plan = evaluationPlan(state, result);
  const unmodeled = unmodeledAxes(result);
  // Evaluated at the moment of export, same as the page evaluates it at
  // load, rather than at some earlier build time.
  const staleness = catalogStaleness();

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Model Selector',
        note:
          'This ranking follows only from the constraints and weights stated below, plus whatever ratings were supplied, and is not a claim that any model is objectively best. This tool ships no capability, latency, or throughput rating of its own; each is modeled for a candidate only once a rating for it is supplied, from a person\'s own evals or experience. Every axis a candidate carries a rating for is named in ratedFields per candidate below, and any axis with no rating for any surviving candidate in this run is named in unmodeledAxes.',
        // Everything needed to reconstruct why this answer came out,
        // per the PRD user outcome of "a defensible model selection
        // shortlist": the requirements, the weights, the token blend,
        // any per candidate ratings, which axes went unmodeled, and how
        // current the catalog was at the moment this was generated.
        catalogStaleness: {
          thresholdDays: staleness.thresholdDays,
          totalCandidates: staleness.total,
          staleCount: staleness.staleCount,
          oldestPriceModel: staleness.oldest.name,
          oldestPriceDate: staleness.oldest.priceEffectiveDate,
          oldestPriceDays: staleness.oldestDays,
          staleModels: staleness.staleModels.map((s) => ({
            model: s.model.name,
            priceEffectiveDate: s.model.priceEffectiveDate,
            days: s.days,
          })),
          riskIfAnyStale: STALE_RISK_STATEMENT,
        },
        requirements: state.requirements,
        weights: state.weights,
        tokenBlend: state.tokenBlend,
        userRatings: state.userRatings,
        unmodeledAxes: unmodeled.map((axis) => ({ axis, label: AXIS_LABELS[axis] })),
        ranked: result.ranked.map((r) => ({
          rank: r.rank,
          model: r.model.name,
          provider: r.model.provider,
          weightedScore: Number(r.weightedScore.toFixed(1)),
          axisScores: r.axisScores,
          priceConfidence: r.model.priceConfidence,
          priceEffectiveDate: r.model.priceEffectiveDate,
          priceStale: isModelStale(r.model),
          ratedFields: r.ratedFields,
        })),
        eliminated: result.eliminated.map((e) => ({
          model: e.model.name,
          provider: e.model.provider,
          failedChecks: e.failedChecks,
          priceConfidence: e.model.priceConfidence,
          priceEffectiveDate: e.model.priceEffectiveDate,
          priceStale: isModelStale(e.model),
          ratedFields: e.ratedFields,
        })),
        tradeoff: sensitivity,
        unansweredQuestions: questions,
        recommendedEvaluationPlan: plan,
      },
      null,
      2,
    );
  }

  const lines: string[] = [
    '# Model Selector report',
    '',
    'This ranking follows only from the constraints and weights stated below, plus whatever ratings were supplied, and is not a claim that any model is objectively best. This tool ships no capability, latency, or throughput rating of its own. Each is modeled for a candidate only once a rating for it is supplied, from a person\'s own evals or experience.',
    '',
    '## Axes not modeled',
    '',
    ...(unmodeled.length
      ? [
          `${unmodeled.map((a) => AXIS_LABELS[a]).join(', ')} carry no rating for any surviving candidate in this run. Supply a rating per candidate to bring an axis into the ranking.`,
        ]
      : ['Every scored axis carries a rating for at least one surviving candidate in this run.']),
    '',
    `Catalog currency: checked against a ${STALE_THRESHOLD_DAYS} day staleness threshold. Oldest price point is ${staleness.oldest.name} at ${staleness.oldestDays} days old, dated ${staleness.oldest.priceEffectiveDate}. ${staleness.staleCount} of ${staleness.total} candidates exceed the threshold.`,
    ...(staleness.staleCount > 0
      ? [
          '',
          `Stale entries: ${staleness.staleModels.map((s) => `${s.model.name} (${s.days} days old)`).join(', ')}.`,
          '',
          STALE_RISK_STATEMENT,
        ]
      : ['', 'No candidate currently exceeds the staleness threshold.']),
    '',
    '## Stated requirements',
    '',
    `Task type: ${TASK_TYPE_LABELS[state.requirements.taskType]}`,
    `Accuracy bar: ${state.requirements.accuracyBar}`,
    `Context needed: ${fmtInt(state.requirements.contextNeededTokens)} tokens`,
    `Latency ceiling: ${state.requirements.latencyCeilingMs != null ? `${fmtInt(state.requirements.latencyCeilingMs)} ms` : 'none stated'}`,
    `Cost ceiling: ${state.requirements.costCeilingPerMTok != null ? `$${state.requirements.costCeilingPerMTok.toFixed(2)} per million tokens` : 'none stated'}`,
    `Vision required: ${state.requirements.needsVision ? 'yes' : 'no'}`,
    `Tool use required: ${state.requirements.needsToolUse ? 'yes' : 'no'}`,
    `Hosting requirement: ${HOSTING_REQUIREMENT_LABELS[state.requirements.hostingRequirement]}`,
    `Data sensitivity: ${state.requirements.dataSensitivity}`,
    `Throughput need: ${state.requirements.throughputNeed}`,
    '',
    '## Weights',
    '',
    ...AXIS_KEYS.map((axis) => `${AXIS_LABELS[axis]}: ${state.weights[axis]}`),
    '',
    '## Ranked candidates',
    '',
    ...(result.ranked.length
      ? result.ranked.map(
          (r) =>
            `${r.rank}. ${r.model.name} (${r.model.provider}), weighted score ${r.weightedScore.toFixed(1)}, ${ratingTag(r.ratedFields)}. ` +
            r.axisScores.map((a) => `${a.label} ${a.modeled ? a.score : 'not modeled'}`).join(', '),
        )
      : ['No candidate survived every hard constraint.']),
    '',
    '## Disqualified candidates',
    '',
    ...(result.eliminated.length
      ? result.eliminated.map(
          (e) =>
            `${e.model.name} (${e.model.provider}), ${ratingTag(e.ratedFields)}, eliminated by: ${e.failedChecks.map((c) => c.label).join(', ')}.`,
        )
      : ['None. Every candidate in the catalog passed every hard constraint.']),
    '',
    '## Tradeoff',
    '',
    sensitivity.message,
    '',
    '## Unanswered questions',
    '',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    '',
    '## Recommended evaluation plan',
    '',
    ...plan.map((p, i) => `${i + 1}. ${p}`),
    '',
  ];

  return lines.join('\n');
}

export function filename(_state: SelectorState, _format: ExportFormat): string {
  return 'model-selector-report';
}
