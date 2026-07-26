/**
 * Context Packer, packing engine.
 *
 * PRD: tools-nixfred-prds/tools/03-CONTEXT-PACKER.md
 * User outcome: choose what information fits into a finite model context
 * and see what gets dropped or compressed.
 *
 * HARD BOUNDARY FROM THE PRD: "This is a planning simulator, not a
 * tokenizer guarantee. Token estimates must be labeled by method."
 * Nothing here calls a real tokenizer. Every token count is either a
 * number the user typed (method "manual") or a heuristic over pasted
 * text (method "chars-per-4"), and the UI states which one produced any
 * number it shows.
 *
 * SAFETY PROPERTY, the reason this tool exists: required content can
 * never be silently dropped. If the blocks marked required already cost
 * more than the budget, pack() refuses to report a packed result at all
 * rather than quietly excluding one of them. See the "feasible" field.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Token estimation
 * ------------------------------------------------------------------ */

export type EstimateMethod = 'manual' | 'chars-per-4';

export const ESTIMATE_METHODS: EstimateMethod[] = ['manual', 'chars-per-4'];

export const ESTIMATE_METHOD_LABELS: Record<EstimateMethod, string> = {
  manual: 'Manual estimate',
  'chars-per-4': 'From pasted content',
};

/** Shown next to every number this method produces, per the PRD boundary. */
export const ESTIMATE_METHOD_NOTES: Record<EstimateMethod, string> = {
  manual:
    'Entered directly. As accurate as the number you typed, and only that accurate.',
  'chars-per-4':
    'Estimated at 4 characters per token from the pasted content. A heuristic, not a tokenizer, and it drifts on code and non English text.',
};

/**
 * Estimate tokens from characters. Same 4 characters per token heuristic
 * used across this workbench's tools, so a count from one tool means the
 * same thing in another.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

/* ------------------------------------------------------------------ *
 * Context blocks
 * ------------------------------------------------------------------ */

export interface ContextBlock {
  id: string;
  label: string;
  /**
   * Pasted or descriptive text. Drives the token estimate when
   * estimateMethod is "chars-per-4". Kept even for manual blocks as a
   * free text note, since it is useful context regardless of which
   * number is authoritative.
   */
  content: string;
  estimateMethod: EstimateMethod;
  /** Authoritative token count when estimateMethod is "manual". Ignored otherwise. */
  manualTokens: number;
  /** Never dropped without an explicit, prominent warning. See pack(). */
  required: boolean;
}

/** Priority is never stored on the block. It is the block's position in
 * the array, so there is exactly one place that can go out of sync with
 * itself: nowhere. Reordering the array IS changing priority. */
export function tokensOf(block: ContextBlock): number {
  if (block.estimateMethod === 'manual') {
    return Math.max(0, Math.round(block.manualTokens || 0));
  }
  return estimateTokens(block.content);
}

export interface BlockView {
  block: ContextBlock;
  tokens: number;
  /** 1 based position in the array. 1 is the highest priority. */
  rank: number;
}

export function viewBlocks(blocks: ContextBlock[]): BlockView[] {
  return blocks.map((block, i) => ({ block, tokens: tokensOf(block), rank: i + 1 }));
}

export function totalTokens(blocks: ContextBlock[]): number {
  return blocks.reduce((sum, b) => sum + tokensOf(b), 0);
}

let nextBlockSeq = 1;

/** Monotonic, unique within a session, and never collides with a
 * sample's own descriptive ids. Good enough for a client side list. */
export function createBlockId(): string {
  const id = `block-${nextBlockSeq}`;
  nextBlockSeq += 1;
  return id;
}

export function addBlock(
  blocks: ContextBlock[],
  partial: Partial<ContextBlock> = {},
): ContextBlock[] {
  const block: ContextBlock = {
    id: partial.id ?? createBlockId(),
    label: partial.label ?? 'New context block',
    content: partial.content ?? '',
    estimateMethod: partial.estimateMethod ?? 'manual',
    manualTokens: partial.manualTokens ?? 0,
    required: partial.required ?? false,
  };
  return [...blocks, block];
}

export function removeBlock(blocks: ContextBlock[], id: string): ContextBlock[] {
  return blocks.filter((b) => b.id !== id);
}

export function updateBlock(
  blocks: ContextBlock[],
  id: string,
  patch: Partial<ContextBlock>,
): ContextBlock[] {
  return blocks.map((b) => (b.id === id ? { ...b, ...patch } : b));
}

/**
 * Swap a block with its neighbor. This is the keyboard and drag
 * reordering primitive: the PRD requires "drag or keyboard controls
 * change priority", and since priority is array position, moving a
 * block IS the whole implementation. Returns the same array reference
 * when the move is a no-op at a boundary, so callers can tell nothing
 * changed.
 */
export function moveBlock(
  blocks: ContextBlock[],
  id: string,
  direction: 'up' | 'down',
): ContextBlock[] {
  const index = blocks.findIndex((b) => b.id === id);
  if (index === -1) return blocks;
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= blocks.length) return blocks;
  const next = blocks.slice();
  const tmp = next[index];
  next[index] = next[swapWith];
  next[swapWith] = tmp;
  return next;
}

/* ------------------------------------------------------------------ *
 * Packing strategies
 *
 * Each strategy decides the ORDER in which optional blocks are
 * attempted. Required blocks are never subject to strategy: they are
 * placed first, unconditionally, and only the leftover capacity is
 * handed to the strategy. This is what makes the safety property hold
 * for every strategy at once, instead of being a special case bolted
 * onto each one.
 *
 * None of these strategies solves knapsack optimally. Each is a
 * deterministic greedy rule, stated plainly, so the result is
 * explainable rather than mysteriously "best". An honest greedy result
 * beats a fake optimum.
 * ------------------------------------------------------------------ */

export const STRATEGIES = [
  'priority-order',
  'largest-first',
  'smallest-first',
  'value-density',
] as const;

export type Strategy = (typeof STRATEGIES)[number];

export const STRATEGY_LABELS: Record<Strategy, string> = {
  'priority-order': 'Priority order',
  'largest-first': 'Largest first',
  'smallest-first': 'Smallest first',
  'value-density': 'Value density',
};

/** The general rule, shown once near the strategy picker. Per-block
 * reasons below explain a single placement; this explains the strategy
 * itself. */
export const STRATEGY_RULES: Record<Strategy, string> = {
  'priority-order':
    'Required blocks are placed first. Remaining optional blocks are attempted strictly in the order you ranked them, highest priority first. A block that does not fit is skipped and the next one in priority order is tried in whatever space is left.',
  'largest-first':
    'Required blocks are placed first. Remaining optional blocks are attempted biggest token cost first. This front loads the budget with the heaviest content and can leave no room for small, low priority blocks that would otherwise have fit.',
  'smallest-first':
    'Required blocks are placed first. Remaining optional blocks are attempted smallest token cost first, which tends to fit more distinct blocks into the same budget at the cost of ignoring how important each one is.',
  'value-density':
    'Required blocks are placed first. Remaining optional blocks are attempted by priority weight per token, highest first, so a small high priority block outranks a large one even when the large block was ranked higher overall.',
};

export const BUDGET_PRESETS: Array<{ label: string; value: number }> = [
  { label: '4,000 tokens, small window', value: 4000 },
  { label: '8,000 tokens', value: 8000 },
  { label: '32,000 tokens', value: 32000 },
  { label: '128,000 tokens', value: 128000 },
  { label: '200,000 tokens, large window', value: 200000 },
];

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Higher for higher priority, meaning a lower rank number. Used only to
 * build the value density sort key below. */
function valueOf(view: BlockView, totalCount: number): number {
  return totalCount - (view.rank - 1);
}

/** Guards against divide by zero for a zero token block. That block is
 * effectively free to include, so giving it a very high density rather
 * than an undefined one is the correct behavior, not a workaround. */
function densityOf(view: BlockView, totalCount: number): number {
  const tokens = Math.max(view.tokens, 1);
  return valueOf(view, totalCount) / tokens;
}

type Comparator = (a: BlockView, b: BlockView, totalCount: number) => number;

const STRATEGY_COMPARATORS: Record<Strategy, Comparator> = {
  'priority-order': (a, b) => a.rank - b.rank,
  'largest-first': (a, b) => b.tokens - a.tokens || a.rank - b.rank,
  'smallest-first': (a, b) => a.tokens - b.tokens || a.rank - b.rank,
  'value-density': (a, b, total) => densityOf(b, total) - densityOf(a, total) || a.rank - b.rank,
};

function explainInclusion(
  strategy: Strategy,
  view: BlockView,
  attemptIndex: number,
  attemptTotal: number,
  remainingBefore: number,
  totalCount: number,
): string {
  const used = view.tokens;
  const left = remainingBefore - used;
  switch (strategy) {
    case 'priority-order':
      return `Included. This block is priority rank ${view.rank} of ${totalCount} and was attempted ${ordinal(attemptIndex + 1)} of ${attemptTotal} optional blocks in strict priority order. It used ${used} of the ${remainingBefore} tokens available at that point, leaving ${left}.`;
    case 'largest-first':
      return `Included. It is the ${ordinal(attemptIndex + 1)} largest optional block at ${used} tokens, attempted in that size order. It used ${used} of the ${remainingBefore} tokens available at that point, leaving ${left}.`;
    case 'smallest-first':
      return `Included. It is the ${ordinal(attemptIndex + 1)} smallest optional block at ${used} tokens, attempted in that size order so more distinct blocks fit into the budget. It used ${used} of the ${remainingBefore} tokens available at that point, leaving ${left}.`;
    case 'value-density':
      return `Included. Its priority weight per token ranked it ${ordinal(attemptIndex + 1)} of ${attemptTotal} optional blocks. It used ${used} of the ${remainingBefore} tokens available at that point, leaving ${left}.`;
    default:
      return 'Included.';
  }
}

function explainExclusion(strategy: Strategy, view: BlockView, remainingBefore: number): string {
  const shortBy = view.tokens - remainingBefore;
  return `Excluded by the ${STRATEGY_LABELS[strategy]} strategy. It needs ${view.tokens} tokens but only ${remainingBefore} remained in the budget when this strategy reached it, short by ${shortBy}.`;
}

/* ------------------------------------------------------------------ *
 * Pack result
 * ------------------------------------------------------------------ */

export interface PackedBlockResult {
  block: ContextBlock;
  tokens: number;
  /** 1 based position in the final packed sequence, required blocks first. */
  order: number;
  reason: string;
}

export interface ExcludedBlockResult {
  block: ContextBlock;
  tokens: number;
  reason: string;
  /** The most tokens this block could have used and still fit, at the
   * point the strategy tried to place it. Undefined only cannot occur
   * here; a block is excluded precisely because this number is smaller
   * than its token count. */
  suggestedTarget: number;
}

export interface SummarizationTarget {
  blockId: string;
  label: string;
  currentTokens: number;
  targetTokens: number;
  note: string;
}

export type TruncationRisk = 'blocked' | 'high' | 'medium' | 'low';

export interface PackResult {
  strategy: Strategy;
  budget: number;
  /** False means pack() refused. See the module doc comment. */
  feasible: boolean;
  requiredTokens: number;
  /** Empty when infeasible. Never a lie about what fit. */
  packed: PackedBlockResult[];
  /** Populated only when infeasible: every required block, for the
   * record, with a reason that says plainly that nothing was placed. */
  requiredOverflow: PackedBlockResult[];
  excluded: ExcludedBlockResult[];
  /** Negative when infeasible, meaning a deficit rather than headroom. */
  remainingCapacity: number;
  truncationRisk: TruncationRisk;
  summarizationTargets: SummarizationTarget[];
  overflowMessage?: string;
}

function riskFor(remainingCapacity: number, budget: number): TruncationRisk {
  if (budget <= 0) return 'high';
  const ratio = remainingCapacity / budget;
  if (ratio < 0.02) return 'high';
  if (ratio < 0.1) return 'medium';
  return 'low';
}

/** Distributes the overage proportionally across required blocks by
 * their share of the required total. One reasonable distribution among
 * many, and the note says so; it is a starting point for a human
 * decision, not the only correct split. */
function suggestRequiredShrink(
  requiredViews: BlockView[],
  overBy: number,
): SummarizationTarget[] {
  const total = requiredViews.reduce((s, v) => s + v.tokens, 0) || 1;
  return requiredViews
    .map((v) => {
      const share = v.tokens / total;
      const reduction = Math.round(share * overBy);
      const targetTokens = Math.max(0, v.tokens - reduction);
      return {
        blockId: v.block.id,
        label: v.block.label,
        currentTokens: v.tokens,
        targetTokens,
        note: `A proportional share of the ${overBy} token overage. Shrinking every required block by about this much would bring the total back to budget. This is one possible split, not the only correct one, and it is your call which required block actually loses content.`,
      };
    })
    .filter((t) => t.currentTokens > t.targetTokens);
}

function suggestOptionalShrink(excluded: ExcludedBlockResult[]): SummarizationTarget[] {
  return excluded
    .filter((x) => x.suggestedTarget < x.tokens)
    .map((x) => ({
      blockId: x.block.id,
      label: x.block.label,
      currentTokens: x.tokens,
      targetTokens: x.suggestedTarget,
      note: `Shrinking this block to about ${x.suggestedTarget} tokens would have let it fit where this strategy tried to place it. A different strategy, a higher priority ranking, or a larger budget may fit it without any shrinking at all.`,
    }));
}

/**
 * Pack blocks into the budget.
 *
 * THE SAFETY CHECK RUNS FIRST AND UNCONDITIONALLY. If the blocks marked
 * required already cost more than the budget, this returns
 * feasible: false and an EMPTY packed array. It never trims a required
 * block to make the numbers work, and it never reports a packed result
 * that quietly omits one. That is the property the PRD calls the whole
 * point of the tool.
 */
export function pack(state: PackerState): PackResult {
  const budget = Math.max(0, Math.round(state.budget || 0));
  const views = viewBlocks(state.blocks);
  const totalCount = views.length;
  const requiredViews = views.filter((v) => v.block.required);
  const optionalViews = views.filter((v) => !v.block.required);
  const requiredTokens = requiredViews.reduce((sum, v) => sum + v.tokens, 0);

  if (requiredTokens > budget) {
    const overBy = requiredTokens - budget;
    const requiredOverflow: PackedBlockResult[] = requiredViews.map((v, i) => ({
      block: v.block,
      tokens: v.tokens,
      order: i + 1,
      reason:
        'Required. Listed here for the record only: this pack was refused before anything could be placed, so this block was never dropped, it was never attempted.',
    }));
    const excluded: ExcludedBlockResult[] = optionalViews.map((v) => ({
      block: v.block,
      tokens: v.tokens,
      reason: `Not attempted. Required content alone needs ${requiredTokens} tokens, which already exceeds the ${budget} token budget by ${overBy}. Optional packing never begins until that is fixed.`,
      suggestedTarget: 0,
    }));
    return {
      strategy: state.strategy,
      budget,
      feasible: false,
      requiredTokens,
      packed: [],
      requiredOverflow,
      excluded,
      remainingCapacity: budget - requiredTokens,
      truncationRisk: 'blocked',
      summarizationTargets: suggestRequiredShrink(requiredViews, overBy),
      overflowMessage: `Required content alone needs ${requiredTokens} tokens against a ${budget} token budget, short by ${overBy}. Increase the budget, or make ${requiredViews.length > 1 ? 'some of these required blocks' : 'this required block'} optional, before anything can be packed.`,
    };
  }

  const comparator = STRATEGY_COMPARATORS[state.strategy];
  const attemptOrder = optionalViews.slice().sort((a, b) => comparator(a, b, totalCount));

  const packedOptional: Array<{ view: BlockView; reason: string }> = [];
  const excluded: ExcludedBlockResult[] = [];
  let remaining = budget - requiredTokens;

  attemptOrder.forEach((view, i) => {
    if (view.tokens <= remaining) {
      const reason = explainInclusion(
        state.strategy,
        view,
        i,
        attemptOrder.length,
        remaining,
        totalCount,
      );
      packedOptional.push({ view, reason });
      remaining -= view.tokens;
    } else {
      excluded.push({
        block: view.block,
        tokens: view.tokens,
        reason: explainExclusion(state.strategy, view, remaining),
        suggestedTarget: Math.max(remaining, 0),
      });
    }
  });

  const requiredPacked: PackedBlockResult[] = requiredViews.map((v, i) => ({
    block: v.block,
    tokens: v.tokens,
    order: i + 1,
    reason:
      'Required. Space for this block is reserved before any optional block is considered, regardless of strategy.',
  }));

  const packed: PackedBlockResult[] = [
    ...requiredPacked,
    ...packedOptional.map((p, i) => ({
      block: p.view.block,
      tokens: p.view.tokens,
      order: requiredPacked.length + i + 1,
      reason: p.reason,
    })),
  ];

  const usedOptionalTokens = packedOptional.reduce((s, p) => s + p.view.tokens, 0);
  const remainingCapacity = budget - requiredTokens - usedOptionalTokens;

  return {
    strategy: state.strategy,
    budget,
    feasible: true,
    requiredTokens,
    packed,
    requiredOverflow: [],
    excluded,
    remainingCapacity,
    truncationRisk: riskFor(remainingCapacity, budget),
    summarizationTargets: suggestOptionalShrink(excluded),
    overflowMessage: undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * PRD acceptance criterion: "Includes a realistic agent task sample."
 * Three ship. The first is that sample. The second demonstrates why
 * priority order alone can waste a budget on one large "important
 * looking" block. The third is the mandatory safety demonstration: a
 * budget too small for the required blocks alone.
 * ------------------------------------------------------------------ */

export interface Sample {
  id: string;
  name: string;
  /** What this sample is meant to show. */
  teaches: string;
  budget: number;
  blocks: ContextBlock[];
}

export const SAMPLES: Sample[] = [
  {
    id: 'support-agent',
    name: 'Customer support agent',
    teaches:
      'A realistic agent context pack where required system and tool instructions leave a tight remainder, so the packing strategy decides which optional context survives. Priority order and largest first keep different blocks than smallest first and value density.',
    budget: 4000,
    blocks: [
      {
        id: 'sys-instructions',
        label: 'System instructions',
        required: true,
        estimateMethod: 'manual',
        manualTokens: 250,
        content:
          'You are a support agent for an online retailer. Stay factual, cite order data when you have it, and escalate anything involving a chargeback or a legal threat.',
      },
      {
        id: 'tool-defs',
        label: 'Tool definitions',
        required: true,
        estimateMethod: 'manual',
        manualTokens: 600,
        content:
          'Schema for lookupOrder, issueRefund, and escalateToHuman, each with required parameters and a description of when to call it.',
      },
      {
        id: 'current-message',
        label: 'Current Customer message',
        required: true,
        estimateMethod: 'chars-per-4',
        manualTokens: 0,
        content:
          'My last payment failed twice and I was charged both times. I need a refund and to know why my card keeps getting declined.',
      },
      {
        id: 'history',
        label: 'Conversation history, last 10 turns',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 1200,
        content:
          'Ten prior turns covering the Customer confirming their account, describing the failed charges, and asking for a timeline.',
      },
      {
        id: 'kb',
        label: 'Retrieved knowledge base articles',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 2000,
        content:
          'Three articles on duplicate charge handling, refund timing, and card decline reason codes.',
      },
      {
        id: 'catalog',
        label: 'Product catalog snapshot',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 500,
        content:
          'A snapshot of the three products on the Customer order, in case the reply needs to reference them.',
      },
      {
        id: 'scratch',
        label: 'Agent scratchpad notes',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 300,
        content: 'Working notes the agent keeps for itself while reasoning through the ticket.',
      },
    ],
  },
  {
    id: 'research-notes',
    name: 'Research summarization agent',
    teaches:
      'Priority order can spend the whole remaining budget on one large, top ranked block and starve everything else. Smallest first and value density pack more of the available context instead of just the biggest name on the list.',
    budget: 2000,
    blocks: [
      {
        id: 'question',
        label: 'Research question',
        required: true,
        estimateMethod: 'chars-per-4',
        manualTokens: 0,
        content:
          'What are the tradeoffs between value density packing and strict priority order when the highest priority block is also the largest one available.',
      },
      {
        id: 'format',
        label: 'Output format specification',
        required: true,
        estimateMethod: 'manual',
        manualTokens: 150,
        content: 'Answer in three short paragraphs, then a one line recommendation.',
      },
      {
        id: 'dump',
        label: 'Full literature review dump',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 1600,
        content: 'The complete literature review document, unedited.',
      },
      {
        id: 'stats',
        label: 'Key statistics table',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 300,
        content: 'A compact table of the five statistics the answer is most likely to cite.',
      },
      {
        id: 'summary',
        label: 'Executive summary of the related paper',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 250,
        content: 'A one page summary of the paper most relevant to the question.',
      },
      {
        id: 'appendix',
        label: 'Raw appendix data',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 1500,
        content: 'Supporting tables from the appendix, mostly redundant with the statistics table.',
      },
    ],
  },
  {
    id: 'overflow-safety',
    name: 'Overloaded required context',
    teaches:
      'When the blocks marked required already cost more than the budget, the tool refuses to pack rather than quietly dropping one of them. This is the safety property the whole tool exists to enforce.',
    budget: 500,
    blocks: [
      {
        id: 'sys2',
        label: 'System instructions',
        required: true,
        estimateMethod: 'manual',
        manualTokens: 300,
        content: 'Full safety and behavior policy for a regulated financial assistant.',
      },
      {
        id: 'policy',
        label: 'Compliance and safety policy',
        required: true,
        estimateMethod: 'manual',
        manualTokens: 400,
        content: 'The compliance rules the agent must never violate, required in full on every turn.',
      },
      {
        id: 'req3',
        label: 'Current user request',
        required: true,
        estimateMethod: 'manual',
        manualTokens: 150,
        content: 'The literal request text from the user this turn.',
      },
      {
        id: 'history2',
        label: 'Recent chat history',
        required: false,
        estimateMethod: 'manual',
        manualTokens: 200,
        content: 'The last two exchanges, included only if there is room.',
      },
    ],
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

export interface PackerState {
  blocks: ContextBlock[];
  budget: number;
  strategy: Strategy;
  scenarioId: string;
}

export function emptyState(): PackerState {
  return { blocks: [], budget: 8000, strategy: 'priority-order', scenarioId: '' };
}

export function sampleState(id: string = SAMPLES[0].id): PackerState {
  const sample = getSample(id) ?? SAMPLES[0];
  return {
    blocks: sample.blocks.map((b) => ({ ...b })),
    budget: sample.budget,
    strategy: 'priority-order',
    scenarioId: sample.id,
  };
}

export function reset(): PackerState {
  return emptyState();
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: PackerState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (state.blocks.length === 0) {
    issues.push({
      field: 'blocks',
      message: 'Add at least one context block, or load a sample.',
      severity: 'error',
    });
  }

  if (!(state.budget > 0)) {
    issues.push({
      field: 'budget',
      message: 'Budget must be a positive number of tokens.',
      severity: 'error',
    });
  }

  state.blocks.forEach((b) => {
    if (!b.label.trim()) {
      issues.push({
        field: `block.${b.id}.label`,
        message: 'A block has no label. Name it so the packed order stays readable.',
        severity: 'warning',
      });
    }
    if (b.estimateMethod === 'manual' && (!b.manualTokens || b.manualTokens <= 0)) {
      issues.push({
        field: `block.${b.id}.manualTokens`,
        message: `Block "${b.label || b.id}" has a manual estimate of zero tokens and will not affect the pack.`,
        severity: 'warning',
      });
    }
    if (b.estimateMethod === 'chars-per-4' && !b.content.trim()) {
      issues.push({
        field: `block.${b.id}.content`,
        message: `Block "${b.label || b.id}" has no pasted content to estimate from and will count as zero tokens.`,
        severity: 'warning',
      });
    }
  });

  return issues;
}

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: PackerState, format: ExportFormat): string {
  const result = pack(state);

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Context Packer',
        note: 'Planning simulation only. Token counts are estimates, not a tokenizer guarantee.',
        budget: state.budget,
        strategy: state.strategy,
        blocks: state.blocks,
        result,
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push('# Context Packer report');
  lines.push('');
  lines.push('Planning simulation only. Token counts are estimates, not a tokenizer guarantee.');
  lines.push('');
  lines.push(`Strategy: ${STRATEGY_LABELS[state.strategy]}`);
  lines.push(`Budget: ${state.budget} tokens`);
  lines.push('');

  if (!result.feasible) {
    lines.push('## Refused to pack');
    lines.push('');
    lines.push(result.overflowMessage ?? '');
    lines.push('');
    lines.push('### Required blocks');
    lines.push('');
    result.requiredOverflow.forEach((p) => {
      lines.push(`1. ${p.block.label}, ${p.tokens} tokens. ${p.reason}`);
    });
  } else {
    lines.push('## Packed order');
    lines.push('');
    result.packed.forEach((p) => {
      lines.push(
        `${p.order}. ${p.block.label}, ${p.tokens} tokens, ${p.block.required ? 'required' : 'optional'}. ${p.reason}`,
      );
    });
    lines.push('');
    lines.push('## Excluded blocks');
    lines.push('');
    lines.push(result.excluded.length ? '' : 'None. Every block fit.');
    result.excluded.forEach((x) => {
      lines.push(`1. ${x.block.label}, ${x.tokens} tokens. ${x.reason}`);
    });
    lines.push('');
    lines.push(`Remaining capacity: ${result.remainingCapacity} tokens.`);
    lines.push(`Truncation risk: ${result.truncationRisk}.`);
  }

  if (result.summarizationTargets.length) {
    lines.push('');
    lines.push('## Suggested summarization targets');
    lines.push('');
    result.summarizationTargets.forEach((t) => {
      lines.push(
        `1. ${t.label}, currently ${t.currentTokens} tokens, target about ${t.targetTokens} tokens. ${t.note}`,
      );
    });
  }

  return lines.join('\n');
}

export function filename(_state: PackerState, format: ExportFormat): string {
  return format === 'json' ? 'context-packer-report' : 'context-packer-report';
}
