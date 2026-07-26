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
 * 1. This tool never claims benchmark authority. Every field that is an
 *    editorial judgment rather than a published spec (capabilityTier,
 *    latencyClass, throughputTier, and each strong task affinity) is
 *    labeled as such everywhere it renders, and every one of those
 *    fields is user overridable through the overrides map on
 *    SelectorState. Nothing here pretends a coarse tier is a benchmark
 *    score.
 * 2. Only OBJECTIVE, published facts are allowed to eliminate a
 *    candidate outright. That is why the five hard constraints below
 *    are context window size, vision support, tool use support,
 *    hosting availability, and published or estimated price against a
 *    stated ceiling, and why capability, latency, and throughput never
 *    appear in evaluateHardConstraints. An editorial guess is not
 *    allowed the power to silently kill a candidate.
 * 3. Nothing here computes a single "best model." rankCandidates
 *    returns a ranking that is a pure function of the stated weights,
 *    and computeSensitivity always names what would have to change for
 *    the runner up to win instead.
 *
 * Pure functions only. No DOM, no globals, no I/O, no network. The
 * catalog is static versioned data with a source and a date on every
 * price.
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

/** Shared by a workload's stated accuracy bar and a model's capability rating. */
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

export const LATENCY_CLASSES = ['fast', 'standard', 'slow'] as const;
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

/**
 * Representative time to a usable response, in milliseconds. This is a
 * coarse editorial estimate, not a measured benchmark, stated here so
 * the UI can render the number next to the label rather than hiding it.
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
 * dates." Every entry states where its price came from and when that
 * price was true. capabilityTier, latencyClass, and throughputTier are
 * this tool's own coarse editorial priors, not vendor claims and not
 * benchmark results, which is why SelectorState carries an overrides
 * map that lets a user replace any one of them per candidate.
 * ------------------------------------------------------------------ */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  /** Coarse editorial prior. Overridable. Never used in a hard constraint. */
  capabilityTier: CapabilityTier;
  /** Task types this catalog notes as a particular strength. Editorial. */
  strongTasks: TaskType[];
  /** Published spec. Used in a hard constraint. */
  contextWindowTokens: number;
  /** Published spec. Used in a hard constraint. */
  supportsVision: boolean;
  /** Published spec. Used in a hard constraint. */
  supportsToolUse: boolean;
  /** Published or well documented availability. Used in a hard constraint. */
  hosting: HostingMode[];
  /** Coarse editorial prior. Overridable. Never used in a hard constraint. */
  latencyClass: LatencyClass;
  /** Coarse editorial prior. Overridable. Never used in a hard constraint. */
  throughputTier: ThroughputTier;
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
    capabilityTier: 'frontier',
    strongTasks: ['reasoning-and-analysis', 'coding', 'agentic-tool-use'],
    contextWindowTokens: 200000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    latencyClass: 'slow',
    throughputTier: 'limited',
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
    capabilityTier: 'high',
    strongTasks: ['coding', 'general-chat', 'extraction-and-structured-output'],
    contextWindowTokens: 200000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    latencyClass: 'standard',
    throughputTier: 'standard',
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
    capabilityTier: 'solid',
    strongTasks: ['general-chat', 'extraction-and-structured-output'],
    contextWindowTokens: 200000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    latencyClass: 'fast',
    throughputTier: 'scale',
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
    capabilityTier: 'high',
    strongTasks: ['general-chat', 'extraction-and-structured-output'],
    contextWindowTokens: 128000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    latencyClass: 'standard',
    throughputTier: 'standard',
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
    capabilityTier: 'solid',
    strongTasks: ['general-chat'],
    contextWindowTokens: 128000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    latencyClass: 'fast',
    throughputTier: 'scale',
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
    capabilityTier: 'high',
    strongTasks: ['coding', 'long-document-summarization'],
    contextWindowTokens: 1000000,
    supportsVision: true,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud'],
    latencyClass: 'standard',
    throughputTier: 'standard',
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
    capabilityTier: 'solid',
    strongTasks: ['general-chat'],
    contextWindowTokens: 128000,
    supportsVision: false,
    supportsToolUse: true,
    hosting: ['vendor-api', 'private-cloud', 'self-hosted'],
    latencyClass: 'standard',
    throughputTier: 'scale',
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
    capabilityTier: 'high',
    strongTasks: ['coding', 'reasoning-and-analysis'],
    contextWindowTokens: 64000,
    supportsVision: false,
    supportsToolUse: true,
    hosting: ['vendor-api', 'self-hosted'],
    latencyClass: 'standard',
    throughputTier: 'scale',
    pricePerMillionInput: 0.27,
    pricePerMillionOutput: 1.1,
    priceConfidence: 'published',
    priceSource: 'DeepSeek published API list price at the date below, standard rate.',
    priceEffectiveDate: '2024-12-26',
    notes:
      'Text only. Capability tier is a cautious editorial read of third party comparisons, not independently verified by this catalog.',
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

export const OVERRIDABLE_FIELDS = ['capabilityTier', 'latencyClass', 'throughputTier'] as const;
export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

export type ModelOverride = Partial<Pick<ModelEntry, OverridableField>>;
export type Overrides = Record<string, ModelOverride>;

export interface SelectorState {
  requirements: WorkloadRequirements;
  weights: Weights;
  tokenBlend: TokenBlend;
  overrides: Overrides;
}

function applyOverride(model: ModelEntry, override?: ModelOverride): ModelEntry {
  if (!override) return model;
  return { ...model, ...override };
}

/**
 * Which fields of a candidate carry a user supplied value rather than
 * shipped catalog data, in a stable order. Empty when the user has not
 * touched this candidate. This is the fact that makes a row "user
 * edited" rather than "as shipped," a distinction the PRD requires to
 * survive into the export, not just show up as a badge on screen.
 */
export function overriddenFields(modelId: string, overrides: Overrides): OverridableField[] {
  const override = overrides[modelId];
  if (!override) return [];
  return OVERRIDABLE_FIELDS.filter((field) => override[field] !== undefined);
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
 * them reads an editorial rating, on purpose, per the honesty
 * boundary stated at the top of this file.
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
 * string, and every editorial input it depends on is named so the UI
 * can point back to the override control for it.
 * ------------------------------------------------------------------ */

export interface AxisScore {
  axis: AxisKey;
  label: string;
  score: number;
  why: string;
}

function scoreCapability(model: ModelEntry, requirements: WorkloadRequirements): AxisScore {
  const modelRank = CAPABILITY_RANK[model.capabilityTier];
  const requiredRank = CAPABILITY_RANK[requirements.accuracyBar];
  const gap = modelRank - requiredRank;
  let score = gap >= 0 ? Math.min(100, 85 + gap * 5) : Math.max(0, 85 + gap * 35);

  const isStrongTask = model.strongTasks.includes(requirements.taskType);
  if (isStrongTask) score = Math.min(100, score + 10);
  score = Math.round(score);

  const gapWord =
    gap === 0
      ? 'meets'
      : gap > 0
        ? `exceeds by ${gap} tier${gap > 1 ? 's' : ''}`
        : `falls short by ${Math.abs(gap)} tier${Math.abs(gap) > 1 ? 's' : ''}`;
  const taskNote = isStrongTask
    ? `This catalog also notes a particular editorial strength for ${TASK_TYPE_LABELS[requirements.taskType].toLowerCase()}.`
    : `This catalog notes no particular strength for ${TASK_TYPE_LABELS[requirements.taskType].toLowerCase()}, which is not a claim of weakness, only an absence of a noted strength.`;

  return {
    axis: 'capability',
    label: AXIS_LABELS.capability,
    score,
    why: `Capability tier "${model.capabilityTier}" ${gapWord} the stated "${requirements.accuracyBar}" bar. ${taskNote} Capability tier is a coarse editorial prior, not a benchmark result, and it is overridable.`,
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
    score,
    why: `Blended cost estimate is $${blended.toFixed(2)} per million tokens, assuming ${Math.round(tokenBlend.inputShare * 100)} percent input and ${Math.round(tokenBlend.outputShare * 100)} percent output tokens. That is the ${ordinal(cheaperCount + 1)} cheapest of the ${allBlendedCosts.length} candidates in this catalog. Change the token blend assumption to match real traffic.`,
  };
}

function scoreLatency(model: ModelEntry, requirements: WorkloadRequirements): AxisScore {
  const ms = LATENCY_CLASS_MS[model.latencyClass];
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
    score,
    why: `Editorial "${model.latencyClass}" latency class, about ${fmtInt(ms)} milliseconds typical. ${fitNote} Latency class is a coarse editorial estimate, not a measured benchmark, and it is overridable.`,
  };
}

function scoreThroughput(model: ModelEntry, requirements: WorkloadRequirements): AxisScore {
  const modelRank = THROUGHPUT_RANK[model.throughputTier];
  const neededRank = THROUGHPUT_NEED_RANK[requirements.throughputNeed];
  const shortfall = neededRank - modelRank;
  const score = shortfall <= 0 ? 100 : shortfall === 1 ? 40 : 0;

  return {
    axis: 'throughput',
    label: AXIS_LABELS.throughput,
    score,
    why: `Rated "${model.throughputTier}" for sustained throughput, an editorial read of typical published rate limits and the availability of batch or provisioned capacity, against the stated "${requirements.throughputNeed}" need. Throughput tier is overridable.`,
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
  /** Empty when this candidate is exactly as shipped in the catalog. */
  overriddenFields: OverridableField[];
}

export interface EliminatedCandidate {
  model: ModelEntry;
  hardChecks: HardCheck[];
  failedChecks: HardCheck[];
  /** Empty when this candidate is exactly as shipped in the catalog. */
  overriddenFields: OverridableField[];
}

export interface SelectionResult {
  ranked: RankedCandidate[];
  eliminated: EliminatedCandidate[];
}

export function computeWeightedScore(axisScores: AxisScore[], weights: Weights): number {
  const totalWeight = AXIS_KEYS.reduce((sum, axis) => sum + weights[axis], 0);
  if (totalWeight <= 0) {
    return axisScores.reduce((sum, a) => sum + a.score, 0) / axisScores.length;
  }
  const sum = axisScores.reduce((acc, a) => acc + a.score * weights[a.axis], 0);
  return sum / totalWeight;
}

export function rankCandidates(state: SelectorState): SelectionResult {
  const allBlendedCosts = CATALOG.map((m) => blendedCost(m, state.tokenBlend));

  const ranked: RankedCandidate[] = [];
  const eliminated: EliminatedCandidate[] = [];

  for (const baseModel of CATALOG) {
    const model = applyOverride(baseModel, state.overrides[baseModel.id]);
    const fields = overriddenFields(baseModel.id, state.overrides);
    const hardChecks = evaluateHardConstraints(model, state.requirements, state.tokenBlend);
    const failedChecks = hardChecks.filter((c) => !c.passed);

    if (failedChecks.length > 0) {
      eliminated.push({ model, hardChecks, failedChecks, overriddenFields: fields });
      continue;
    }

    const axisScores: AxisScore[] = [
      scoreCapability(model, state.requirements),
      scoreCost(model, state.tokenBlend, allBlendedCosts),
      scoreLatency(model, state.requirements),
      scoreThroughput(model, state.requirements),
    ];
    const weightedScore = computeWeightedScore(axisScores, state.weights);
    ranked.push({ model, hardChecks, axisScores, weightedScore, rank: 0, overriddenFields: fields });
  }

  ranked.sort((a, b) => b.weightedScore - a.weightedScore || a.model.name.localeCompare(b.model.name));
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });

  return { ranked, eliminated };
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

  let best: { axis: AxisKey; requiredWeight: number } | null = null;

  for (const axis of AXIS_KEYS) {
    const winnerScore = winner.axisScores.find((a) => a.axis === axis)!.score;
    const runnerScore = runnerUp.axisScores.find((a) => a.axis === axis)!.score;
    if (runnerScore <= winnerScore) continue;

    let runnerRest = 0;
    let winnerRest = 0;
    for (const other of AXIS_KEYS) {
      if (other === axis) continue;
      const w = weights[other];
      runnerRest += w * runnerUp.axisScores.find((a) => a.axis === other)!.score;
      winnerRest += w * winner.axisScores.find((a) => a.axis === other)!.score;
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
      message: `${runnerUp.model.name} trails ${winner.model.name} on every scored axis, so no single weight change flips this ranking. Multiple axes would have to move together.`,
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

  if (requirements.dataSensitivity === 'regulated' && requirements.hostingRequirement === 'any') {
    questions.push(
      'Data sensitivity is marked regulated but no private cloud or self hosted requirement was stated. Confirm the vendor agreement and data processing terms cover this before proceeding.',
    );
  }
  if (requirements.throughputNeed === 'high') {
    questions.push(
      'Throughput need is marked high. State an actual expected request or token volume per day so a real rate limit and cost projection can be checked against it, since this tool only scores a coarse throughput tier.',
    );
  }
  if (requirements.costCeilingPerMTok == null) {
    questions.push(
      'No cost ceiling was stated. Every candidate passes the cost hard constraint by default in that case, and cost only affects the weighted ranking.',
    );
  }
  if (requirements.latencyCeilingMs == null) {
    questions.push(
      'No latency ceiling was stated. Latency is scored only as a soft preference for speed in that case.',
    );
  }
  if (result.eliminated.length === CATALOG.length) {
    questions.push(
      'Every candidate in this catalog was eliminated by a hard constraint. Loosen the tightest one, most likely context size, cost ceiling, or the hosting requirement, and run this again.',
    );
  }
  if (result.ranked.length > 0) {
    questions.push(
      'Confirm whether this shortlist has been tested against real examples from this workload, since every score above comes from stated constraints and catalog data, not from a live run.',
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
      'Load test at the expected peak volume before committing, since published rate limits and this tool throughput rating are both coarse.',
    );
  }
  plan.push('Repeat this comparison when the catalog date is old or when a new model generation ships.');

  return plan;
}

/* ------------------------------------------------------------------ *
 * Samples
 * ------------------------------------------------------------------ */

export interface Sample {
  id: string;
  name: string;
  teaches: string;
  requirements: WorkloadRequirements;
  weights: Weights;
  tokenBlend: TokenBlend;
}

export const SAMPLES: Sample[] = [
  {
    id: 'support-triage-volume',
    name: 'High volume support triage',
    teaches:
      'Throughput and cost dominate the ranking when the accuracy bar only needs to be solid and nothing is regulated.',
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
  },
  {
    id: 'regulated-document-analysis',
    name: 'Regulated document analysis',
    teaches:
      'A hosting requirement and a large context need eliminate most of the catalog before ranking even starts.',
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
  },
  {
    id: 'realtime-coding-copilot',
    name: 'Real time coding copilot',
    teaches:
      'Two candidates that both pass every hard constraint still trade places when the weights move.',
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
    overrides: {},
  };
}

export function sampleState(id: string = SAMPLES[0].id): SelectorState {
  const sample = getSample(id) ?? SAMPLES[0];
  return {
    requirements: { ...sample.requirements },
    weights: { ...sample.weights },
    tokenBlend: { ...sample.tokenBlend },
    overrides: {},
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
      message: 'All weights are zero. Ranking falls back to an unweighted average of the four scored axes.',
      severity: 'warning',
    });
  }

  return issues;
}

export type ExportFormat = 'json' | 'markdown';

/**
 * Renders the same override tag on screen and in export, so the two
 * surfaces cannot say different things about which data is shipped
 * catalog data and which is user supplied.
 */
function overrideTag(fields: OverridableField[]): string {
  return fields.length ? `user edited: ${fields.join(', ')}` : 'as shipped in the catalog';
}

export function serialize(state: SelectorState, format: ExportFormat): string {
  const result = rankCandidates(state);
  const sensitivity = computeSensitivity(result.ranked[0], result.ranked[1], state.weights);
  const questions = unansweredQuestions(state, result);
  const plan = evaluationPlan(state, result);
  // Evaluated at the moment of export, same as the page evaluates it at
  // load, rather than at some earlier build time.
  const staleness = catalogStaleness();

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Model Selector',
        note:
          'This ranking follows only from the constraints and weights stated below, and is not a claim that any model is objectively best. Capability, latency, and throughput ratings are coarse editorial priors, not measured benchmarks. Every field the user changed from its catalog default is marked overriddenFields per candidate below, distinct from unedited catalog data.',
        // Everything needed to reconstruct why this answer came out,
        // per the PRD user outcome of "a defensible model selection
        // shortlist": the requirements, the weights, the token blend,
        // any per candidate overrides, and how current the catalog was
        // at the moment this was generated.
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
        overrides: state.overrides,
        ranked: result.ranked.map((r) => ({
          rank: r.rank,
          model: r.model.name,
          provider: r.model.provider,
          weightedScore: Number(r.weightedScore.toFixed(1)),
          axisScores: r.axisScores,
          priceConfidence: r.model.priceConfidence,
          priceEffectiveDate: r.model.priceEffectiveDate,
          priceStale: isModelStale(r.model),
          overriddenFields: r.overriddenFields,
        })),
        eliminated: result.eliminated.map((e) => ({
          model: e.model.name,
          provider: e.model.provider,
          failedChecks: e.failedChecks,
          priceConfidence: e.model.priceConfidence,
          priceEffectiveDate: e.model.priceEffectiveDate,
          priceStale: isModelStale(e.model),
          overriddenFields: e.overriddenFields,
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
    'This ranking follows only from the constraints and weights stated below, and is not a claim that any model is objectively best. Capability, latency, and throughput ratings are coarse editorial priors, not measured benchmarks.',
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
            `${r.rank}. ${r.model.name} (${r.model.provider}), weighted score ${r.weightedScore.toFixed(1)}, ${overrideTag(r.overriddenFields)}. ` +
            r.axisScores.map((a) => `${a.label} ${a.score}`).join(', '),
        )
      : ['No candidate survived every hard constraint.']),
    '',
    '## Disqualified candidates',
    '',
    ...(result.eliminated.length
      ? result.eliminated.map(
          (e) =>
            `${e.model.name} (${e.model.provider}), ${overrideTag(e.overriddenFields)}, eliminated by: ${e.failedChecks.map((c) => c.label).join(', ')}.`,
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
