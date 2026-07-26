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
 * Mission
 *
 * PRD mode: "Mission: steps and tool calls for a sample task." A
 * mission is a deterministic, user authored walkthrough of one sample
 * task, not a model call and never presented as one. Its whole
 * teaching point is criterion 4: "Simulation distinguishes
 * observation, decision, action, result, and memory." Those five step
 * types are kept as a closed, ordered set for exactly that reason.
 * ------------------------------------------------------------------ */

export const MISSION_STEP_TYPES = ['observation', 'decision', 'action', 'result', 'memory'] as const;
export type MissionStepType = (typeof MISSION_STEP_TYPES)[number];

export const MISSION_STEP_LABELS: Record<MissionStepType, string> = {
  observation: 'Observation',
  decision: 'Decision',
  action: 'Action',
  result: 'Result',
  memory: 'Memory',
};

export interface MissionStep {
  id: string;
  type: MissionStepType;
  /** What happens at this step, in plain language. */
  description: string;
  /**
   * Required when type is action: the id of a tool from the
   * Architecture tool list. This is the field criterion 2 checks:
   * "every action maps to an explicit permission." A tool that does
   * not exist in the Architecture spec is not a permission, it is a
   * typo, and the step is unauthorized until it is fixed.
   */
  toolId: string;
  /** Id of the MissionLoop this step repeats inside, or blank for a step that runs once. */
  loopId: string;
}

/**
 * Criterion 3: "Loops require limits and exit conditions." A loop is
 * a labeled block of contiguous mission steps that share its id. Both
 * fields are required once a loop is actually wired to a step; an
 * unused, freshly added loop is not yet a hazard.
 */
export interface MissionLoop {
  id: string;
  label: string;
  /** Maximum times the loop body repeats. 0 means not set. */
  maxIterations: number;
  /** The condition that should end the loop before the limit, stated in words. */
  exitCondition: string;
}

export interface Mission {
  /** The sample task this walkthrough steps through. */
  task: string;
  steps: MissionStep[];
  loops: MissionLoop[];
}

/* ------------------------------------------------------------------ *
 * Team
 *
 * PRD mode: "Team: delegation and handoffs." Handoffs already carry
 * delegation targets (src/lib/tools/agent-designer.ts, Handoff). The
 * roster below is the rest of that mode: who else is on the team.
 *
 * Criterion 1: "A single agent sample works before team mode is
 * introduced." An empty roster is a complete, valid, standalone
 * agent, not a missing field, so team membership is never required by
 * computeCompleteness. Team mode exists only once a roster entry
 * exists.
 * ------------------------------------------------------------------ */

export interface TeammateAgent {
  id: string;
  name: string;
  role: string;
}

/* ------------------------------------------------------------------ *
 * The specification
 * ------------------------------------------------------------------ */

export interface AgentSpecState {
  name: string;
  purpose: Purpose;
  /** What the agent remembers, and for how long. PRD names this a first class Architecture field. */
  memory: string;
  /** What starts a run: an event, a schedule, a message, a manual call. Also a first class Architecture field. */
  triggers: string;
  tools: ToolSpec[];
  autonomy: Autonomy;
  handoffs: Handoff[];
  limits: Limits;
  failure: Failure;
  mission: Mission;
  team: TeammateAgent[];
}

/* ------------------------------------------------------------------ *
 * Risk flags
 *
 * Each function checks one PRD requirement and nothing else, so a
 * failing test names exactly which contradiction stopped firing.
 * ------------------------------------------------------------------ */

export const FLAG_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

export type FlagPanel = 'autonomy' | 'handoffs' | 'limits' | 'failure' | 'mission';

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

/**
 * Criterion 2: "Every action maps to an explicit permission." A
 * permission, in this tool, is a tool defined in the Architecture tool
 * list. An action step naming no tool, or a tool id that Architecture
 * does not define, has no permission behind it and is flagged as
 * unauthorized. A step that is entirely untouched, meaning both its
 * description and its tool reference are still blank, is a fresh row
 * rather than an authored contradiction, so it is skipped.
 */
function checkMissionPermissions(mission: Mission, tools: ToolSpec[]): Flag[] {
  const flags: Flag[] = [];
  for (const step of mission.steps) {
    if (step.type !== 'action') continue;
    const started = step.description.trim() || step.toolId.trim();
    if (!started) continue;
    const authorized = step.toolId.trim() && tools.some((t) => t.id === step.toolId);
    if (!authorized) {
      const label = step.description.trim() || 'This action step';
      flags.push({
        id: `mission-permission-${step.id}`,
        severity: 'critical',
        panel: 'mission',
        message: `${label} does not name a tool defined in Architecture, so it has no explicit permission behind it. Point it at a real tool, or add the tool it needs to Architecture first.`,
      });
    }
  }
  return flags;
}

/**
 * Criterion 3: "Loops require limits and exit conditions." Checked
 * only for loops actually wired to at least one step, since a loop
 * with nothing assigned to it yet is not a hazard, just unfinished.
 */
function checkMissionLoops(mission: Mission): Flag[] {
  const flags: Flag[] = [];
  for (const loop of mission.loops) {
    const used = mission.steps.some((s) => s.loopId === loop.id);
    if (!used) continue;
    const label = loop.label.trim() || 'This loop';
    if (loop.maxIterations <= 0) {
      flags.push({
        id: `mission-loop-limit-${loop.id}`,
        severity: 'critical',
        panel: 'mission',
        message: `${label} has no iteration limit. A loop with no limit can repeat forever in the simulation, exactly as it could in a real run.`,
      });
    }
    if (!loop.exitCondition.trim()) {
      flags.push({
        id: `mission-loop-exit-${loop.id}`,
        severity: 'critical',
        panel: 'mission',
        message: `${label} has no stated exit condition. The iteration limit is a backstop, not a substitute for saying what should end the loop first.`,
      });
    }
  }
  return flags;
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
    ...checkMissionPermissions(state.mission, state.tools),
    ...checkMissionLoops(state.mission),
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

/**
 * A mission is complete once it names its task, has at least one
 * step, every step says what happens, and every action step names a
 * tool that actually exists in the Architecture tool list. That last
 * clause is what keeps completeness and the mission permission flag
 * telling the same story instead of two different ones.
 */
function missionComplete(mission: Mission, tools: ToolSpec[]): boolean {
  return (
    Boolean(mission.task.trim()) &&
    mission.steps.length > 0 &&
    mission.steps.every(
      (s) =>
        s.description.trim() &&
        (s.type !== 'action' || (s.toolId.trim() && tools.some((t) => t.id === s.toolId))),
    )
  );
}

/**
 * Team mode is optional by design (criterion 1). An empty roster is
 * complete on its own; a roster with a half filled row is not.
 */
function teamComplete(team: TeammateAgent[]): boolean {
  return team.length === 0 || team.every((t) => t.name.trim() && t.role.trim());
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
      key: 'memory',
      label: 'Architecture: what the agent remembers',
      filled: Boolean(state.memory.trim()),
    },
    {
      key: 'triggers',
      label: 'Architecture: what starts a run',
      filled: Boolean(state.triggers.trim()),
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
    {
      key: 'mission',
      label: 'Mission: a sample task with at least one step, every action naming a real tool',
      filled: missionComplete(state.mission, state.tools),
    },
    {
      key: 'team',
      label: 'Team: every roster entry, if any, has a name and a role',
      filled: teamComplete(state.team),
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
 * Observatory
 *
 * PRD mode: "Observatory: timeline, state, cost estimate, failures,
 * and recovery." This section is the mechanism, a deterministic
 * expansion of a Mission into an ordered timeline. It is not a model
 * call and it never claims to be: the boundary from
 * 00-PRODUCT-VISION.md, "Hidden claims that a simulated result is a
 * real model benchmark" is forbidden, so the cost figure below is
 * labeled as a count of simulated tool calls, never a dollar
 * prediction.
 *
 * A loop with a stated limit is expanded to exactly that many
 * iterations and then halts, which is the mechanical answer to
 * criterion 3: the simulation does not just get flagged for missing a
 * limit, it actually stops at one when a limit exists.
 * ------------------------------------------------------------------ */

export interface TimelineEntry {
  /** Position in the produced timeline. Strictly increasing, starting at 0. */
  order: number;
  type: MissionStepType;
  description: string;
  /** The tool called, only meaningful when type is action. Blank otherwise. */
  toolName: string;
  /** False only for an action step whose tool reference did not resolve. */
  authorized: boolean;
  /** The loop this entry repeats inside, or blank for a step that ran once. */
  loopLabel: string;
  /** 1 based iteration number inside its loop, or 0 outside any loop. */
  iteration: number;
  /** Simulated tool calls this entry counts as: 1 for an action, 0 otherwise. */
  costUnits: number;
}

export interface MissionRun {
  timeline: TimelineEntry[];
  /** Sum of every entry's costUnits. A count, not a dollar estimate. */
  totalCostUnits: number;
  /** True when at least one loop ran to its stated limit and stopped there. */
  haltedByLimit: boolean;
  /** Plain language account of which loop halted and at what count. Blank when haltedByLimit is false. */
  haltReason: string;
  /** How many action entries had no resolvable permission. Mirrors checkMissionPermissions. */
  unauthorizedCount: number;
}

/**
 * Expand a Mission into its timeline. Steps that do not belong to a
 * loop appear once, in the order authored. Steps that share a loop id
 * are treated as one contiguous block and repeated for the loop's
 * stated iteration count, or once when no limit is set, since running
 * a step zero times would erase it from the timeline entirely and
 * hide the very thing the missing limit flag exists to surface.
 */
export function runMission(mission: Mission, tools: ToolSpec[]): MissionRun {
  const timeline: TimelineEntry[] = [];
  let totalCostUnits = 0;
  let unauthorizedCount = 0;
  let haltedByLimit = false;
  let haltReason = '';
  let order = 0;

  const pushEntry = (step: MissionStep, loopLabel: string, iteration: number) => {
    const tool = step.type === 'action' ? tools.find((t) => t.id === step.toolId) : undefined;
    const authorized = step.type !== 'action' || Boolean(tool);
    if (!authorized) unauthorizedCount += 1;
    const costUnits = step.type === 'action' ? 1 : 0;
    totalCostUnits += costUnits;
    timeline.push({
      order: order++,
      type: step.type,
      description: step.description.trim() || '(no description)',
      toolName: tool ? tool.name.trim() || '(unnamed tool)' : '',
      authorized,
      loopLabel,
      iteration,
      costUnits,
    });
  };

  let i = 0;
  while (i < mission.steps.length) {
    const step = mission.steps[i];
    if (!step.loopId) {
      pushEntry(step, '', 0);
      i += 1;
      continue;
    }

    const loopId = step.loopId;
    let j = i;
    while (j < mission.steps.length && mission.steps[j].loopId === loopId) j += 1;
    const block = mission.steps.slice(i, j);
    const loop = mission.loops.find((l) => l.id === loopId);
    const label = loop?.label.trim() || 'Unlabeled loop';
    const maxIterations = loop && loop.maxIterations > 0 ? loop.maxIterations : 1;

    for (let iter = 1; iter <= maxIterations; iter += 1) {
      for (const blockStep of block) pushEntry(blockStep, label, iter);
    }

    if (loop && loop.maxIterations > 0) {
      haltedByLimit = true;
      const note = `Loop "${label}" halted at its stated limit of ${loop.maxIterations} iterations.`;
      haltReason = haltReason ? `${haltReason} ${note}` : note;
    }

    i = j;
  }

  return { timeline, totalCostUnits, haltedByLimit, haltReason, unauthorizedCount };
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
      memory: 'Remembers the current ticket only for the duration of one run. Nothing persists between tickets.',
      triggers: 'A new ticket arriving in the support queue.',
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
      mission: {
        task: 'A ticket comes in about a failed payment. Walk it through triage.',
        steps: [
          {
            id: 'step-observe',
            type: 'observation',
            description: 'Reads the new ticket and sees it is about a failed payment.',
            toolId: '',
            loopId: '',
          },
          {
            id: 'step-fetch',
            type: 'action',
            description: 'Calls Fetch ticket to pull the ticket text and the order history.',
            toolId: 't-fetch',
            loopId: 'loop-fetch',
          },
          {
            id: 'step-decide',
            type: 'decision',
            description:
              'Decides the ticket does not mention a chargeback or a legal threat, so it can proceed without escalating.',
            toolId: '',
            loopId: '',
          },
          {
            id: 'step-draft',
            type: 'action',
            description: 'Calls Draft reply to prepare a response addressing the failed payment.',
            toolId: 't-draft',
            loopId: '',
          },
          {
            id: 'step-remember',
            type: 'memory',
            description: 'Remembers the ticket id and the drafted reply text for the rest of this run.',
            toolId: '',
            loopId: '',
          },
          {
            id: 'step-result',
            type: 'result',
            description: 'A draft reply exists, tagged with the ticket id, waiting in the review queue.',
            toolId: '',
            loopId: '',
          },
        ],
        loops: [
          {
            id: 'loop-fetch',
            label: 'Fetch ticket retry',
            maxIterations: 2,
            exitCondition: 'The ticket loads successfully.',
          },
        ],
      },
      team: [],
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
      memory:
        'Remembers which papers were already included in a past digest, so the same paper is never suggested twice.',
      triggers: 'A schedule, once per week, and a manual run when the topic owner asks for an early digest.',
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
      mission: {
        task: "Produce this week's digest for the tracked topic.",
        steps: [
          {
            id: 'step-observe',
            type: 'observation',
            description: 'Reads the tracked topic and the date range for this run.',
            toolId: '',
            loopId: '',
          },
          {
            id: 'step-search',
            type: 'action',
            description: 'Calls Search papers for the topic over the last seven days.',
            toolId: 't-search',
            loopId: '',
          },
          {
            id: 'step-decide',
            type: 'decision',
            description: 'Decides which papers are relevant enough to include, based on the abstract.',
            toolId: '',
            loopId: '',
          },
          {
            id: 'step-write',
            type: 'action',
            description: 'Calls Write digest over the papers judged relevant.',
            toolId: 't-write',
            loopId: '',
          },
          {
            id: 'step-remember',
            type: 'memory',
            description: 'Remembers which papers were included, so next run does not repeat them.',
            toolId: '',
            loopId: '',
          },
          {
            id: 'step-result',
            type: 'result',
            description: 'A suggested digest exists, ready for the topic owner to read.',
            toolId: '',
            loopId: '',
          },
        ],
        loops: [],
      },
      team: [],
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
      memory: 'Remembers nothing between runs. Every run rescans the whole directory from scratch.',
      triggers: 'A scheduled job, once when disk usage crosses the free space threshold.',
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
      mission: {
        task: 'Free disk space by deleting files nobody uses.',
        steps: [
          {
            id: 'step-list',
            type: 'action',
            description: 'Calls List files to see everything in the target directory.',
            toolId: 't-list',
            loopId: '',
          },
          {
            id: 'step-decide',
            type: 'decision',
            description: 'Decides a file is unused if it has not been modified in 180 days.',
            toolId: '',
            loopId: '',
          },
          {
            // Deliberately wrong: this mistypes the tool id instead of
            // "t-delete", which is the whole point of this sample. The
            // description reads like an authorized action, but the tool
            // reference does not resolve, so checkMissionPermissions
            // must flag it regardless of how plausible the prose sounds.
            id: 'step-delete',
            type: 'action',
            description: 'Deletes the file identified as unused.',
            toolId: 't-delete-typo',
            loopId: 'loop-delete',
          },
          {
            id: 'step-confirm',
            type: 'result',
            description: 'Confirms the file is gone, assuming the delete call actually succeeded.',
            toolId: '',
            loopId: 'loop-delete',
          },
          {
            id: 'step-remember',
            type: 'memory',
            description: 'Does not track which files were already considered in an earlier run.',
            toolId: '',
            loopId: '',
          },
        ],
        // Deliberately incomplete: no limit and no exit condition, so
        // checkMissionLoops must flag both. This is the mission side of
        // the same "no stop condition" failure the Limits panel already
        // flags at the whole agent level.
        loops: [
          {
            id: 'loop-delete',
            label: 'Delete loop',
            maxIterations: 0,
            exitCondition: '',
          },
        ],
      },
      team: [
        {
          id: 'team-monitor',
          name: 'Disk monitor agent',
          role: 'Watches disk usage and triggers this cleanup agent when free space drops below a threshold.',
        },
        {
          id: 'team-responder',
          name: 'Incident responder',
          role: 'Picks up the handoff when deletion fails repeatedly on the same file.',
        },
      ],
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
    memory: '',
    triggers: '',
    tools: [],
    autonomy: { level: 'suggest-only', rationale: '' },
    handoffs: [],
    limits: { stepBudget: 0, timeBudgetMinutes: 0, costCeiling: '', retryPolicy: '', stopConditions: [] },
    failure: { onToolFailure: '', onUncertainty: '', onLoopDetected: '' },
    mission: { task: '', steps: [], loops: [] },
    team: [],
  };
}

/** Deep copy, so loading a sample never lets the page mutate the sample constant. */
function cloneState(state: AgentSpecState): AgentSpecState {
  return {
    name: state.name,
    purpose: { ...state.purpose },
    memory: state.memory,
    triggers: state.triggers,
    tools: state.tools.map((t) => ({ ...t })),
    autonomy: { ...state.autonomy },
    handoffs: state.handoffs.map((h) => ({ ...h })),
    limits: { ...state.limits, stopConditions: [...state.limits.stopConditions] },
    failure: { ...state.failure },
    mission: {
      task: state.mission.task,
      steps: state.mission.steps.map((s) => ({ ...s })),
      loops: state.mission.loops.map((l) => ({ ...l })),
    },
    team: state.team.map((t) => ({ ...t })),
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
        missionRun: runMission(state.mission, state.tools),
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
    'Generated by the Nixfred AI Systems Workbench, Agent Designer. This is a design specification, not a running agent. Nothing here called a model or executed a tool call.',
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
  lines.push('## Memory');
  lines.push('');
  lines.push(state.memory.trim() || '(not stated)');

  lines.push('');
  lines.push('## Triggers');
  lines.push('');
  lines.push(state.triggers.trim() || '(not stated)');

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
  lines.push('## Team');
  lines.push('');
  if (state.team.length === 0) {
    lines.push('Solo agent. No teammates defined, and none are required: a single agent stands on its own.');
  } else {
    state.team.forEach((member, i) => {
      lines.push(`${i + 1}. ${member.name.trim() || '(unnamed teammate)'}`);
      lines.push(`   Role. ${member.role.trim() || '(not stated)'}`);
    });
    lines.push('See Handoffs above for what moves between this agent and the team.');
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
  lines.push('## Mission');
  lines.push('');
  lines.push(`Sample task. ${state.mission.task.trim() || '(not stated)'}`);
  lines.push('');
  if (state.mission.loops.length) {
    lines.push('Loops.');
    state.mission.loops.forEach((loop, i) => {
      const limit = loop.maxIterations > 0 ? `${loop.maxIterations} iterations` : '(NO LIMIT SET)';
      lines.push(`  ${i + 1}. ${loop.label.trim() || '(unlabeled loop)'}, limit ${limit}.`);
      lines.push(`     Exit condition. ${loop.exitCondition.trim() || '(NOT DEFINED)'}`);
    });
    lines.push('');
  }
  if (state.mission.steps.length === 0) {
    lines.push('No steps authored yet.');
  } else {
    state.mission.steps.forEach((step, i) => {
      const loop = state.mission.loops.find((l) => l.id === step.loopId);
      const loopNote = loop ? `, inside loop "${loop.label.trim() || '(unlabeled loop)'}"` : '';
      lines.push(`${i + 1}. ${MISSION_STEP_LABELS[step.type]}${loopNote}. ${step.description.trim() || '(not stated)'}`);
      if (step.type === 'action') {
        const tool = state.tools.find((t) => t.id === step.toolId);
        lines.push(`   Calls. ${tool ? tool.name.trim() || '(unnamed tool)' : 'NOT AUTHORIZED, no matching tool'}`);
      }
    });
  }

  lines.push('');
  lines.push('## Observatory');
  lines.push('');
  lines.push(
    'A deterministic expansion of the mission above into a timeline. Not a model call and not a benchmark: it is a mechanical walkthrough of the steps you authored.',
  );
  lines.push('');
  const run = runMission(state.mission, state.tools);
  if (run.timeline.length === 0) {
    lines.push('No timeline yet. Author at least one mission step to produce one.');
  } else {
    run.timeline.forEach((entry) => {
      const loopNote = entry.loopLabel ? `, ${entry.loopLabel} iteration ${entry.iteration}` : '';
      const toolNote = entry.type === 'action' ? `, calls ${entry.toolName || '(unresolved)'}` : '';
      const authNote = entry.type === 'action' && !entry.authorized ? ', UNAUTHORIZED' : '';
      lines.push(
        `${entry.order + 1}. ${MISSION_STEP_LABELS[entry.type]}${loopNote}${toolNote}${authNote}. ${entry.description}`,
      );
    });
  }
  lines.push('');
  lines.push(
    `Simulated tool calls: ${run.totalCostUnits}. This counts action steps in the simulated run; it is not a real dollar cost. Stated cost ceiling: ${state.limits.costCeiling.trim() || '(not stated)'}.`,
  );
  lines.push(run.haltedByLimit ? run.haltReason : 'No loop reached a limit in this run.');
  lines.push(
    run.unauthorizedCount > 0
      ? `Failures: ${run.unauthorizedCount} unauthorized action step(s). See Risk flags below.`
      : 'Failures: none detected by these checks.',
  );
  lines.push(
    `Recovery. On a tool call failing: ${state.failure.onToolFailure.trim() || '(not stated)'} On uncertainty: ${state.failure.onUncertainty.trim() || '(NOT DEFINED)'} On a detected loop: ${state.failure.onLoopDetected.trim() || '(not stated)'}`,
  );

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
