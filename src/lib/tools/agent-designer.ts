/**
 * Agent Designer, specification engine.
 *
 * PRD: tools-nixfred-prds/tools/08-AGENT-DESIGNER.md
 * User outcome: specify a bounded AI agent completely enough that an
 * engineer could read the output and build it without asking follow up
 * questions.
 *
 * CONSOLIDATION, per 01-INFORMATION-ARCHITECTURE.md: "Agent Observatory,
 * Mission Control, Fleet Command, autonomy, and handoffs become modes or
 * panels inside Agent Designer." Autonomy and handoffs live here as
 * panels of one tool, not as separate tools.
 *
 * HARD BOUNDARY FROM THE PRD: "This is not a production runtime."
 * Nothing in this file calls a model or executes a tool call. It is a
 * structured document plus a linter for that document. Every function
 * below either shapes the specification or checks it for one specific,
 * statable contradiction. The UI states the same boundary in its own
 * words.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Purpose
 * ------------------------------------------------------------------ */

export interface Purpose {
  /** What the agent is for, in outcome terms. */
  summary: string;
  /** What it must never do, stated as a hard boundary. */
  mustNever: string;
  /** What done looks like for one run. */
  doneLooksLike: string;
  /** How success is measured across many runs. */
  successMeasure: string;
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export interface ToolSpec {
  /** Stable row key. Not shown to the user. */
  id: string;
  name: string;
  /** What the tool needs to be called. */
  input: string;
  /** What the tool returns. */
  output: string;
  /** Whether calling it changes anything outside its own response. */
  mutates: boolean;
  /** Whether a mutation, once made, can be undone. Only meaningful when mutates is true. */
  irreversible: boolean;
  /** Whether a human must approve the call before it runs. */
  needsConfirmation: boolean;
}

/* ------------------------------------------------------------------ *
 * Autonomy
 * ------------------------------------------------------------------ */

export const AUTONOMY_LEVELS = [
  'suggest-only',
  'act-with-confirmation',
  'act-and-report',
  'fully-autonomous',
] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  'suggest-only': 'Suggest only',
  'act-with-confirmation': 'Act with confirmation',
  'act-and-report': 'Act and report',
  'fully-autonomous': 'Fully autonomous',
};

/** Shown under the level select, and folded into the export. */
export const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  'suggest-only':
    'The agent never takes an action. It only produces a recommendation for a human to act on.',
  'act-with-confirmation':
    'The agent may act, but every mutating tool call waits for a human to approve it first.',
  'act-and-report':
    'The agent acts on its own, then tells a human what it did afterward. Nothing waits for approval before it runs.',
  'fully-autonomous':
    'The agent acts with no human checkpoint at any point in the run.',
};

export interface Autonomy {
  level: AutonomyLevel;
  /** Why this level, not a stricter or looser one. Required: the choice needs a stated reason. */
  rationale: string;
}

/* ------------------------------------------------------------------ *
 * Handoffs
 * ------------------------------------------------------------------ */

export interface Handoff {
  id: string;
  /** The condition that triggers the escalation. */
  trigger: string;
  /** Who or what receives it: a human role, or another agent. */
  target: string;
  /** What information moves with the handoff. */
  contextTransferred: string;
  /** Who is accountable for the task after the handoff. The field the PRD singles out. */
  owner: string;
}

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export interface Limits {
  /** Maximum tool calls in one run. 0 means not set. */
  stepBudget: number;
  /** Maximum wall clock minutes in one run. 0 means not set. */
  timeBudgetMinutes: number;
  /** Free text so it can carry a currency and a period, for example "$0.50 per ticket". */
  costCeiling: string;
  retryPolicy: string;
  /** One condition per entry. At least one is required. */
  stopConditions: string[];
}

/* ------------------------------------------------------------------ *
 * Failure
 * ------------------------------------------------------------------ */

export interface Failure {
  onToolFailure: string;
  /** What it does when it is uncertain rather than wrong. Required: PRD calls an agent with no answer here incomplete. */
  onUncertainty: string;
  onLoopDetected: string;
}

/* ------------------------------------------------------------------ *
 * The specification
 * ------------------------------------------------------------------ */

export interface AgentSpecState {
  name: string;
  purpose: Purpose;
  tools: ToolSpec[];
  autonomy: Autonomy;
  handoffs: Handoff[];
  limits: Limits;
  failure: Failure;
}

/* ------------------------------------------------------------------ *
 * Risk flags
 *
 * Each function checks one PRD requirement and nothing else, so a
 * failing test names exactly which contradiction stopped firing.
 * ------------------------------------------------------------------ */

export const FLAG_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

export type FlagPanel = 'autonomy' | 'handoffs' | 'limits' | 'failure';

export interface Flag {
  id: string;
  severity: FlagSeverity;
  panel: FlagPanel;
  message: string;
}

/**
 * Autonomy against the tool list.
 *
 * The PRD requirement this exists to satisfy: "The tool must CHECK the
 * chosen level against the tool list and object when they disagree: a
 * mutating irreversible tool combined with full autonomy is a
 * contradiction and must be flagged loudly." That case is the first
 * rule below and it is unconditional: it fires on every irreversible,
 * mutating tool at the fully autonomous level, regardless of anything
 * else in the spec.
 */
function checkAutonomy(autonomy: Autonomy, tools: ToolSpec[]): Flag[] {
  const flags: Flag[] = [];

  for (const tool of tools) {
    const label = tool.name.trim() || 'An unnamed tool';

    if (autonomy.level === 'fully-autonomous') {
      if (tool.mutates && tool.irreversible) {
        flags.push({
          id: `autonomy-irreversible-${tool.id}`,
          severity: 'critical',
          panel: 'autonomy',
          message: `${label} is a mutating, irreversible tool. Combined with fully autonomous execution, nothing stops it from running before a human ever sees the decision. Full autonomy and an irreversible mutation cannot both be true of the same agent.`,
        });
      }
      if (tool.needsConfirmation) {
        flags.push({
          id: `autonomy-confirmation-${tool.id}`,
          severity: 'critical',
          panel: 'autonomy',
          message: `${label} is marked as needing confirmation, but fully autonomous means no human is ever in the loop to give it. Lower the autonomy level, or remove the confirmation requirement from this tool.`,
        });
      }
    }

    if (autonomy.level === 'suggest-only' && tool.mutates) {
      flags.push({
        id: `autonomy-suggest-${tool.id}`,
        severity: 'critical',
        panel: 'autonomy',
        message: `${label} can mutate something, but suggest only means the agent never takes an action, only proposes one. Either remove this tool's ability to mutate, or raise the autonomy level.`,
      });
    }

    if (autonomy.level === 'act-with-confirmation' && tool.mutates && !tool.needsConfirmation) {
      flags.push({
        id: `autonomy-unconfirmed-${tool.id}`,
        severity: 'warning',
        panel: 'autonomy',
        message: `${label} mutates something but is not marked as needing confirmation, so it skips the checkpoint this autonomy level promises.`,
      });
    }

    if (
      autonomy.level === 'act-and-report' &&
      tool.mutates &&
      tool.irreversible &&
      !tool.needsConfirmation
    ) {
      flags.push({
        id: `autonomy-report-${tool.id}`,
        severity: 'warning',
        panel: 'autonomy',
        message: `${label} makes an irreversible change that is only reported after the fact. Consider whether this specific action deserves a confirmation step even at this autonomy level.`,
      });
    }
  }

  return flags;
}

/**
 * PRD requirement: "Flag any escalation path that has no defined
 * owner, because that is where agent systems silently drop work." A
 * handoff row that is entirely untouched is not yet part of the
 * specification, so it is skipped until at least one of its other
 * fields is filled in.
 */
function checkHandoffs(handoffs: Handoff[]): Flag[] {
  const flags: Flag[] = [];
  for (const handoff of handoffs) {
    const started = handoff.trigger.trim() || handoff.target.trim() || handoff.contextTransferred.trim();
    if (!started) continue;
    if (!handoff.owner.trim()) {
      const trigger = handoff.trigger.trim() || 'this condition';
      flags.push({
        id: `handoff-owner-${handoff.id}`,
        severity: 'critical',
        panel: 'handoffs',
        message: `The handoff triggered by "${trigger}" has no defined owner. Work handed off with nobody accountable for it afterward is exactly how agent systems silently drop tasks.`,
      });
    }
  }
  return flags;
}

/**
 * PRD requirement: "An agent with no stop condition must be flagged."
 */
function checkLimits(limits: Limits): Flag[] {
  const hasStopCondition = limits.stopConditions.some((c) => c.trim());
  if (hasStopCondition) return [];
  return [
    {
      id: 'limits-stop-condition',
      severity: 'critical',
      panel: 'limits',
      message:
        'No stop condition is defined. An agent with no stop condition can keep running indefinitely once started.',
    },
  ];
}

/**
 * PRD requirement: "An agent with no defined uncertain behavior is
 * incomplete."
 */
function checkFailure(failure: Failure): Flag[] {
  if (failure.onUncertainty.trim()) return [];
  return [
    {
      id: 'failure-uncertainty',
      severity: 'critical',
      panel: 'failure',
      message:
        'Nothing defines what the agent does when it is uncertain rather than wrong. An agent with no defined uncertain behavior is incomplete.',
    },
  ];
}

const FLAG_SEVERITY_RANK: Record<FlagSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function evaluateSpec(state: AgentSpecState): Flag[] {
  const flags = [
    ...checkAutonomy(state.autonomy, state.tools),
    ...checkHandoffs(state.handoffs),
    ...checkLimits(state.limits),
    ...checkFailure(state.failure),
  ];
  return flags.sort((a, b) => FLAG_SEVERITY_RANK[a.severity] - FLAG_SEVERITY_RANK[b.severity]);
}

/* ------------------------------------------------------------------ *
 * Completeness
 *
 * A fixed checklist, not one derived from array length, so the total
 * stays stable while the user is still adding tool or handoff rows.
 * The PRD's own acceptance test for this panel: never call a spec
 * complete while a required field is blank.
 * ------------------------------------------------------------------ */

export interface CompletenessItem {
  key: string;
  label: string;
  filled: boolean;
}

export interface Completeness {
  items: CompletenessItem[];
  filled: number;
  total: number;
  /** 0 to 100, rounded. */
  score: number;
  /** Labels of every unmet item, in checklist order. */
  missing: string[];
}

function toolsComplete(tools: ToolSpec[]): boolean {
  return tools.length > 0 && tools.every((t) => t.name.trim() && t.input.trim() && t.output.trim());
}

function handoffsComplete(handoffs: Handoff[]): boolean {
  return (
    handoffs.length > 0 &&
    handoffs.every(
      (h) => h.trigger.trim() && h.target.trim() && h.contextTransferred.trim() && h.owner.trim(),
    )
  );
}

export function computeCompleteness(state: AgentSpecState): Completeness {
  const items: CompletenessItem[] = [
    { key: 'name', label: 'Agent name', filled: Boolean(state.name.trim()) },
    {
      key: 'purpose.summary',
      label: 'Purpose: what the agent is for',
      filled: Boolean(state.purpose.summary.trim()),
    },
    {
      key: 'purpose.mustNever',
      label: 'Purpose: what it must never do',
      filled: Boolean(state.purpose.mustNever.trim()),
    },
    {
      key: 'purpose.doneLooksLike',
      label: 'Purpose: what done looks like',
      filled: Boolean(state.purpose.doneLooksLike.trim()),
    },
    {
      key: 'purpose.successMeasure',
      label: 'Purpose: how success is measured',
      filled: Boolean(state.purpose.successMeasure.trim()),
    },
    {
      key: 'tools',
      label: 'At least one tool, each with a name, an input, and an output',
      filled: toolsComplete(state.tools),
    },
    {
      key: 'autonomy.rationale',
      label: 'Autonomy: the reason for the chosen level',
      filled: Boolean(state.autonomy.rationale.trim()),
    },
    {
      key: 'handoffs',
      label: 'At least one handoff, each with a trigger, a target, transferred context, and an owner',
      filled: handoffsComplete(state.handoffs),
    },
    {
      key: 'limits.stepBudget',
      label: 'Limits: step budget',
      filled: state.limits.stepBudget > 0,
    },
    {
      key: 'limits.timeBudgetMinutes',
      label: 'Limits: time budget',
      filled: state.limits.timeBudgetMinutes > 0,
    },
    {
      key: 'limits.costCeiling',
      label: 'Limits: cost ceiling',
      filled: Boolean(state.limits.costCeiling.trim()),
    },
    {
      key: 'limits.retryPolicy',
      label: 'Limits: retry policy',
      filled: Boolean(state.limits.retryPolicy.trim()),
    },
    {
      key: 'limits.stopConditions',
      label: 'Limits: at least one stop condition',
      filled: state.limits.stopConditions.some((c) => c.trim()),
    },
    {
      key: 'failure.onToolFailure',
      label: 'Failure: behavior when a tool call fails',
      filled: Boolean(state.failure.onToolFailure.trim()),
    },
    {
      key: 'failure.onUncertainty',
      label: 'Failure: behavior when the agent is uncertain',
      filled: Boolean(state.failure.onUncertainty.trim()),
    },
    {
      key: 'failure.onLoopDetected',
      label: 'Failure: behavior when the agent has looped',
      filled: Boolean(state.failure.onLoopDetected.trim()),
    },
  ];

  const filled = items.filter((i) => i.filled).length;
  const total = items.length;
  const score = total === 0 ? 0 : Math.round((filled / total) * 100);
  const missing = items.filter((i) => !i.filled).map((i) => i.label);

  return { items, filled, total, score, missing };
}

/**
 * The single question this whole tool exists to answer: could an
 * engineer build this without asking a follow up question. That
 * requires every required field filled AND no unresolved critical
 * contradiction, which is why this is not simply "score equals 100".
 */
export function isReadyToBuild(state: AgentSpecState): boolean {
  const completeness = computeCompleteness(state);
  const flags = evaluateSpec(state);
  return completeness.missing.length === 0 && !flags.some((f) => f.severity === 'critical');
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * Three ship. Two are complete and flag free, at opposite ends of the
 * autonomy scale, to prove the checks do not simply fire on
 * everything. One is deliberately unsafe, built to trip every rule
 * above at once, so loading it is itself a demonstration of what the
 * tool catches.
 * ------------------------------------------------------------------ */

export interface Sample {
  id: string;
  name: string;
  /** What this sample is meant to show. */
  teaches: string;
  state: AgentSpecState;
}

export const SAMPLES: Sample[] = [
  {
    id: 'support-triage',
    name: 'Support ticket triage agent',
    teaches:
      'A complete, flag free specification. Every mutating tool needs confirmation, matching the act with confirmation level, and the one handoff path has a named owner.',
    state: {
      name: 'Support ticket triage agent',
      purpose: {
        summary:
          'Reads incoming support tickets, drafts a reply, and flags anything that needs a human before it goes out.',
        mustNever:
          'Send a reply to the Customer without a human approving it first, and never promise a refund or a ship date it cannot verify.',
        doneLooksLike: 'A drafted reply exists, tagged with the ticket id, waiting in the review queue.',
        successMeasure:
          'The drafted reply needs no more than one edit from the reviewing human before it is sent.',
      },
      tools: [
        {
          id: 't-fetch',
          name: 'Fetch ticket',
          input: 'A ticket id',
          output: 'The ticket text, the Customer name, and the order history',
          mutates: false,
          irreversible: false,
          needsConfirmation: false,
        },
        {
          id: 't-draft',
          name: 'Draft reply',
          input: 'The ticket text and a tone setting',
          output: 'A draft reply that has not been sent',
          mutates: true,
          irreversible: false,
          needsConfirmation: true,
        },
        {
          id: 't-send',
          name: 'Send reply',
          input: 'An approved draft',
          output: 'Confirmation that the reply was sent',
          mutates: true,
          irreversible: true,
          needsConfirmation: true,
        },
      ],
      autonomy: {
        level: 'act-with-confirmation',
        rationale:
          'Drafting is low risk and can happen freely, but nothing reaches the Customer until a human approves it, because a wrong reply damages trust in a way that is hard to undo.',
      },
      handoffs: [
        {
          id: 'h-escalate',
          trigger: 'The ticket mentions a chargeback or a legal threat',
          target: 'A human, the support team lead on duty',
          contextTransferred:
            'The full ticket thread, the drafted reply if one exists, and the stated reason for escalation',
          owner: 'The support team lead, until they reassign it',
        },
      ],
      limits: {
        stepBudget: 6,
        timeBudgetMinutes: 10,
        costCeiling: '$0.50 per ticket',
        retryPolicy: 'Retry a failed tool call once, then hand the ticket to a human.',
        stopConditions: [
          'The reply has been sent, or the ticket has been handed to a human',
          'The step budget is reached',
          'The same ticket is seen twice in one run',
        ],
      },
      failure: {
        onToolFailure:
          'Retries the call once. If it fails again, stops and hands the ticket to a human with a note describing what failed.',
        onUncertainty:
          'Drafts the reply anyway, but flags it for mandatory review instead of letting it skip the queue.',
        onLoopDetected:
          'Stops immediately and hands the ticket to a human, since seeing it twice is a sign it needs judgment the agent does not have.',
      },
    },
  },
  {
    id: 'research-digest',
    name: 'Research digest suggester',
    teaches:
      'A complete, flag free specification at the opposite end of the autonomy scale. Suggest only, with tools that only produce a recommendation, so there is nothing for the autonomy check to object to.',
    state: {
      name: 'Research digest suggester',
      purpose: {
        summary:
          'Reads new papers in a tracked topic and suggests a short digest for a human to review and post.',
        mustNever: 'Publish or send the digest itself.',
        doneLooksLike: 'A suggested digest exists, ready for the topic owner to read.',
        successMeasure:
          'A human accepts the suggested digest with no more than light editing at least eight times out of ten.',
      },
      tools: [
        {
          id: 't-search',
          name: 'Search papers',
          input: 'A topic and a date range',
          output: 'A list of paper titles, authors, and abstracts',
          mutates: false,
          irreversible: false,
          needsConfirmation: false,
        },
        {
          id: 't-write',
          name: 'Write digest',
          input: 'A list of papers',
          output: 'A suggested digest, returned as the response, saved nowhere else',
          mutates: false,
          irreversible: false,
          needsConfirmation: false,
        },
      ],
      autonomy: {
        level: 'suggest-only',
        rationale:
          'The digest shapes what other people read. A first version should only ever be a suggestion until it has earned trust over time.',
      },
      handoffs: [
        {
          id: 'h-review',
          trigger: 'Every run, once a digest is ready',
          target: 'A human, the topic owner',
          contextTransferred: 'The suggested digest and the list of source papers it drew from',
          owner: 'The topic owner, who decides whether to post it',
        },
      ],
      limits: {
        stepBudget: 4,
        timeBudgetMinutes: 5,
        costCeiling: '$0.10 per run',
        retryPolicy: 'Retry a failed search once, then note the gap in the digest.',
        stopConditions: ['A digest has been produced for this run', 'The step budget is reached'],
      },
      failure: {
        onToolFailure: 'Notes the gap in the digest rather than failing the whole run.',
        onUncertainty: 'Marks the uncertain paper as a maybe in the digest instead of guessing.',
        onLoopDetected: 'Stops and returns whatever digest exists so far.',
      },
    },
  },
  {
    id: 'cleanup-agent',
    name: 'Autonomous file cleanup agent',
    teaches:
      'A deliberately unsafe specification. Fully autonomous combined with an irreversible delete tool trips two autonomy contradictions at once, the escalation path has no owner, no stop condition is defined, and uncertain behavior is never stated. Load it to see every flag fire.',
    state: {
      name: 'Autonomous file cleanup agent',
      purpose: {
        summary: 'Frees disk space by finding and deleting files nobody uses.',
        mustNever: 'Delete a file that is still being used.',
        doneLooksLike: 'Disk usage drops below a stated threshold.',
        successMeasure: 'Free space increases and nothing that was still needed breaks.',
      },
      tools: [
        {
          id: 't-list',
          name: 'List files',
          input: 'A directory path',
          output: 'A list of file paths with their last modified date',
          mutates: false,
          irreversible: false,
          needsConfirmation: false,
        },
        {
          id: 't-delete',
          name: 'Delete file',
          input: 'A file path',
          output: 'Confirmation that the file is gone',
          mutates: true,
          irreversible: true,
          needsConfirmation: true,
        },
      ],
      autonomy: {
        level: 'fully-autonomous',
        rationale: 'Disk space is running low, and waiting on a human would defeat the purpose.',
      },
      handoffs: [
        {
          id: 'h-failure',
          trigger: 'Deletion fails repeatedly on the same file',
          target: 'The engineer on call',
          contextTransferred: 'The list of files that failed to delete and the error message',
          owner: '',
        },
      ],
      limits: {
        stepBudget: 500,
        timeBudgetMinutes: 45,
        costCeiling: '',
        retryPolicy: 'Retry each deletion up to three times before moving on.',
        stopConditions: [],
      },
      failure: {
        onToolFailure: 'Logs the error and tries the next file.',
        onUncertainty: '',
        onLoopDetected: 'No special handling. The loop keeps running.',
      },
    },
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */

export function emptyState(): AgentSpecState {
  return {
    name: '',
    purpose: { summary: '', mustNever: '', doneLooksLike: '', successMeasure: '' },
    tools: [],
    autonomy: { level: 'suggest-only', rationale: '' },
    handoffs: [],
    limits: { stepBudget: 0, timeBudgetMinutes: 0, costCeiling: '', retryPolicy: '', stopConditions: [] },
    failure: { onToolFailure: '', onUncertainty: '', onLoopDetected: '' },
  };
}

/** Deep copy, so loading a sample never lets the page mutate the sample constant. */
function cloneState(state: AgentSpecState): AgentSpecState {
  return {
    name: state.name,
    purpose: { ...state.purpose },
    tools: state.tools.map((t) => ({ ...t })),
    autonomy: { ...state.autonomy },
    handoffs: state.handoffs.map((h) => ({ ...h })),
    limits: { ...state.limits, stopConditions: [...state.limits.stopConditions] },
    failure: { ...state.failure },
  };
}

export function sampleState(id: string = SAMPLES[0].id): AgentSpecState {
  const sample = getSample(id) ?? SAMPLES[0];
  return cloneState(sample.state);
}

export function reset(): AgentSpecState {
  return emptyState();
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: AgentSpecState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!state.name.trim()) {
    issues.push({
      field: 'name',
      message: 'Name the agent before designing it. Even a working title helps.',
      severity: 'error',
    });
  }
  if (state.tools.length === 0) {
    issues.push({
      field: 'tools',
      message: 'Add at least one tool. An agent with no tools cannot do anything.',
      severity: 'warning',
    });
  }
  return issues;
}

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: AgentSpecState, format: ExportFormat): string {
  const completeness = computeCompleteness(state);
  const flags = evaluateSpec(state);
  const readyToBuild = completeness.missing.length === 0 && !flags.some((f) => f.severity === 'critical');

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Agent Designer',
        note: 'A design specification. Nothing here called a model or executed a tool.',
        spec: state,
        completeness,
        flags,
        readyToBuild,
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`# Agent specification, ${state.name.trim() || '(unnamed agent)'}`);
  lines.push('');
  lines.push(
    'Generated by the Nixfred AI Systems Workbench, Agent Designer. This is a design specification, not a running agent.',
  );
  lines.push('');
  lines.push(
    `Completeness: ${completeness.score} percent, ${completeness.filled} of ${completeness.total} required fields.`,
  );
  if (completeness.missing.length) {
    lines.push('');
    lines.push('Missing before this spec is complete.');
    completeness.missing.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
  }

  lines.push('');
  lines.push('## Purpose');
  lines.push('');
  lines.push(`What it is for. ${state.purpose.summary.trim() || '(not stated)'}`);
  lines.push('');
  lines.push(`What it must never do. ${state.purpose.mustNever.trim() || '(not stated)'}`);
  lines.push('');
  lines.push(`What done looks like. ${state.purpose.doneLooksLike.trim() || '(not stated)'}`);
  lines.push('');
  lines.push(`How success is measured. ${state.purpose.successMeasure.trim() || '(not stated)'}`);

  lines.push('');
  lines.push('## Tools');
  lines.push('');
  if (state.tools.length === 0) {
    lines.push('No tools defined.');
  } else {
    state.tools.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name.trim() || '(unnamed tool)'}`);
      lines.push(`   Input. ${t.input.trim() || '(not stated)'}`);
      lines.push(`   Output. ${t.output.trim() || '(not stated)'}`);
      lines.push(
        `   Mutates: ${t.mutates ? 'yes' : 'no'}. Irreversible: ${t.irreversible ? 'yes' : 'no'}. Needs confirmation: ${t.needsConfirmation ? 'yes' : 'no'}.`,
      );
    });
  }

  lines.push('');
  lines.push('## Autonomy');
  lines.push('');
  lines.push(`Level: ${AUTONOMY_LABELS[state.autonomy.level]}.`);
  lines.push(AUTONOMY_DESCRIPTIONS[state.autonomy.level]);
  lines.push('');
  lines.push(`Rationale. ${state.autonomy.rationale.trim() || '(not stated)'}`);

  lines.push('');
  lines.push('## Handoffs');
  lines.push('');
  if (state.handoffs.length === 0) {
    lines.push('No handoff paths defined.');
  } else {
    state.handoffs.forEach((h, i) => {
      lines.push(`${i + 1}. Trigger. ${h.trigger.trim() || '(not stated)'}`);
      lines.push(`   Escalates to. ${h.target.trim() || '(not stated)'}`);
      lines.push(`   Context transferred. ${h.contextTransferred.trim() || '(not stated)'}`);
      lines.push(`   Owner after handoff. ${h.owner.trim() || '(NOT DEFINED)'}`);
    });
  }

  lines.push('');
  lines.push('## Limits');
  lines.push('');
  lines.push(`Step budget. ${state.limits.stepBudget > 0 ? state.limits.stepBudget : '(not stated)'}`);
  lines.push(
    `Time budget. ${state.limits.timeBudgetMinutes > 0 ? `${state.limits.timeBudgetMinutes} minutes` : '(not stated)'}`,
  );
  lines.push(`Cost ceiling. ${state.limits.costCeiling.trim() || '(not stated)'}`);
  lines.push(`Retry policy. ${state.limits.retryPolicy.trim() || '(not stated)'}`);
  lines.push('Stop conditions.');
  const conditions = state.limits.stopConditions.filter((c) => c.trim());
  if (conditions.length === 0) {
    lines.push('  (NONE DEFINED)');
  } else {
    conditions.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }

  lines.push('');
  lines.push('## Failure');
  lines.push('');
  lines.push(`On a tool call failing. ${state.failure.onToolFailure.trim() || '(not stated)'}`);
  lines.push(`On uncertainty. ${state.failure.onUncertainty.trim() || '(NOT DEFINED)'}`);
  lines.push(`On detecting a loop. ${state.failure.onLoopDetected.trim() || '(not stated)'}`);

  lines.push('');
  lines.push('## Risk flags');
  lines.push('');
  if (flags.length === 0) {
    lines.push('None detected.');
  } else {
    flags.forEach((f, i) => lines.push(`${i + 1}. Severity ${f.severity}, ${f.panel} panel. ${f.message}`));
  }

  lines.push('');
  lines.push(`Ready to build: ${readyToBuild ? 'yes' : 'no'}.`);
  lines.push('');

  return lines.join('\n');
}

export function filename(_state: AgentSpecState, format: ExportFormat): string {
  return format === 'json' ? 'agent-designer-spec' : 'agent-designer-spec';
}
