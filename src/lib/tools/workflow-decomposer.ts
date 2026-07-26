/**
 * Workflow Decomposer, classification and analysis engine.
 *
 * PRD: tools-nixfred-prds/tools/07-WORKFLOW-DECOMPOSER.md
 * User outcome: break a fuzzy business process into steps a system can
 * actually automate, and mark the ones it cannot.
 *
 * HARD BOUNDARY, stated because it is the reason this tool earns its
 * place: anyone can list steps. The value is in being honest about
 * which steps must stay human. A step that is frequent but irreversible
 * and unverifiable is NEVER classified as safe to automate here, no
 * matter how much time automating it would save. Frequency only affects
 * the order in which already automatable steps get built, never whether
 * a step is automatable in the first place. See classifyStep below,
 * which never reads a step's frequency at all.
 *
 * INPUT MODEL, per the PRD's "Describe an outcome; add inputs, actors,
 * constraints, and approval points": a process states its outcome,
 * inputs, and constraints as free text, once, at the process level.
 * Actors and approval points are NOT a second free text list a user has
 * to keep in sync by hand. Actors are derived from the owner already
 * stated on every step (deriveActors), and approval points are derived
 * from classification and handoff detection (deriveApprovalPoints), so
 * neither can drift from the steps that actually define them.
 *
 * DEPENDENCY MODEL: a step's dependsOn is an array of step ids, so this
 * is a real DAG, not a linked list. A step may wait on more than one
 * other step, which real workflows need, a payment run waiting on both
 * an approval and a separate verification step is one example below.
 *
 * AGENT DESIGNER: this file never imports src/lib/tools/agent-designer.ts,
 * and must never be imported by it either. See "Agent Designer handoff"
 * below for the explicit, documented export shape that stands in for
 * any direct coupling, per the PRD: "through an explicit export, not
 * hidden coupling."
 *
 * Pure functions only. No DOM, no globals, no I/O, no randomness.
 */

/* ------------------------------------------------------------------ *
 * Step properties
 *
 * These seven properties are the whole input to classification. Per
 * step, a user states each one; the classifier states which one, or
 * which combination, decided the result.
 * ------------------------------------------------------------------ */

export const FREQUENCY_LEVELS = ['rare', 'monthly', 'weekly', 'daily'] as const;
export type FrequencyLevel = (typeof FREQUENCY_LEVELS)[number];

export const FREQUENCY_LABELS: Record<FrequencyLevel, string> = {
  rare: 'Rare, a few times a year',
  monthly: 'About monthly',
  weekly: 'About weekly',
  daily: 'Daily or more',
};

/**
 * Relative runs per month. An ordinal scale chosen to keep rare, weekly,
 * and daily work clearly separated, not a measured count from any real
 * process. Stated here so the priority formula below can be checked by
 * hand rather than taken on faith.
 */
export const FREQUENCY_WEIGHT: Record<FrequencyLevel, number> = {
  rare: 1,
  monthly: 3,
  weekly: 8,
  daily: 20,
};

export const COST_LEVELS = ['low', 'medium', 'high'] as const;
export type CostLevel = (typeof COST_LEVELS)[number];

export const COST_LABELS: Record<CostLevel, string> = {
  low: 'Low, a mistake is a minor annoyance',
  medium: 'Medium, a mistake costs real time or money to fix',
  high: 'High, a mistake is expensive, embarrassing, or hard to reverse',
};

/** Same honesty note as FREQUENCY_WEIGHT: an ordinal scale, not currency. */
export const COST_WEIGHT: Record<CostLevel, number> = {
  low: 1,
  medium: 4,
  high: 10,
};

export interface StepProperties {
  /** Does the input arrive in a fixed, parseable shape, or as free text a person has to interpret. */
  inputStructured: boolean;
  /** Can a system check the result against a rule, without a person looking at it. */
  outputVerifiable: boolean;
  /** Can the action be undone if it turns out to be wrong. */
  reversible: boolean;
  /** Does the step require a judgment call rather than following a fixed rule. */
  needsJudgment: boolean;
  /** Does the step carry legal or financial exposure. */
  legalFinancialRisk: boolean;
  /** How often the step runs. */
  frequency: FrequencyLevel;
  /** What a mistake at this step costs to fix. */
  mistakeCost: CostLevel;
}

export type StepPropertyKey = keyof StepProperties;

/** Short phrase naming each property, used to render a driving property as a sentence fragment. */
export const PROPERTY_LABELS: Record<StepPropertyKey, string> = {
  inputStructured: 'whether the input is structured',
  outputVerifiable: 'whether the output can be verified',
  reversible: 'whether the action is reversible',
  needsJudgment: 'whether it needs human judgment',
  legalFinancialRisk: 'legal or financial risk',
  frequency: 'how often it runs',
  mistakeCost: 'the cost of a mistake',
};

export const DEFAULT_PROPERTIES: StepProperties = {
  inputStructured: true,
  outputVerifiable: true,
  reversible: true,
  needsJudgment: false,
  legalFinancialRisk: false,
  frequency: 'weekly',
  mistakeCost: 'low',
};

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

export interface Step {
  id: string;
  name: string;
  /** Who or what is accountable for this step today. A person, a team, or a system. PRD: every step needs an owner. */
  owner: string;
  /** How anyone confirms the step actually finished. PRD: every step needs completion evidence. */
  completionEvidence: string;
  /**
   * Ids of every step this one waits on. Empty means it starts a
   * chain, which is normal for the first step and abnormal, an orphan,
   * for any step nothing else connects to either. A step may depend on
   * more than one other step: that is what makes this a DAG rather
   * than a linked list. See findGraphIssues for cycle and orphan
   * detection over this shape.
   */
  dependsOn: string[];
  properties: StepProperties;
}

export interface ProcessState {
  /** One line describing the outcome the whole process produces. PRD: "Describe an outcome". */
  outcome: string;
  /** What the process starts with. Free text, process level, not per step. */
  inputs: string;
  /** Limits or rules that bound the whole process, not any single step. */
  constraints: string;
  steps: Step[];
  /** Which sample is loaded, or 'custom' once the user edits it. */
  scenarioId: string;
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

export const CLASSIFICATION_LEVELS = [
  'automate-now',
  'automate-with-checkpoint',
  'keep-human',
  'needs-redesign',
] as const;
export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number];

export const CLASSIFICATION_LABELS: Record<ClassificationLevel, string> = {
  'automate-now': 'Automate now',
  'automate-with-checkpoint': 'Automate with a human checkpoint',
  'keep-human': 'Keep human',
  'needs-redesign': 'Needs redesign before either',
};

export interface Classification {
  level: ClassificationLevel;
  /** The single property whose value decided this classification. */
  drivingProperty: StepPropertyKey;
  /** Plain language reason naming the driving property. */
  reason: string;
  /** Other properties that also pushed toward this result, beyond the driving one. */
  contributingFactors: StepPropertyKey[];
}

/**
 * Classify one step from its properties alone.
 *
 * Deliberately a fixed sequence of disqualifiers followed by a
 * checkpoint aggregator, in that order, so the same properties always
 * produce the same result and the result always names what decided it.
 * Frequency and cost of a mistake are read only after a step has
 * already cleared every disqualifier, never before, which is what
 * keeps this function honest under pressure to automate something
 * popular.
 */
export function classifyStep(properties: StepProperties): Classification {
  const p = properties;

  // Disqualifier 1. Nobody, human or system, has a way to tell whether
  // this step worked, and no human judgment is applied to catch a bad
  // result either. The step is not ready to assign to anyone until
  // someone defines what success looks like.
  if (!p.outputVerifiable && !p.needsJudgment) {
    return {
      level: 'needs-redesign',
      drivingProperty: 'outputVerifiable',
      reason:
        'Nothing checks whether this step succeeded, automatically or by a person. Define what success looks like before deciding who or what performs it.',
      contributingFactors: ['needsJudgment'],
    };
  }

  // Disqualifier 2. The headline rule this tool exists to enforce.
  // Irreversible and unverifiable stays with a human no matter how
  // often it runs or how much time automating it would save. Frequency
  // is not consulted here on purpose.
  if (!p.reversible && !p.outputVerifiable) {
    return {
      level: 'keep-human',
      drivingProperty: 'reversible',
      reason:
        'This step cannot be undone and its result cannot be verified. A mistake here is permanent and invisible, so no run frequency makes automating it safe.',
      contributingFactors: ['outputVerifiable'],
    };
  }

  // Disqualifier 3. Legal or financial exposure, no undo path, and a
  // mistake that is not cheap. That combination stays with a human
  // regardless of volume.
  if (p.legalFinancialRisk && !p.reversible && p.mistakeCost !== 'low') {
    return {
      level: 'keep-human',
      drivingProperty: 'legalFinancialRisk',
      reason:
        'This step carries legal or financial exposure, cannot be undone, and a mistake would cost real money or standing. That stays with a human regardless of how often it runs.',
      contributingFactors: ['reversible', 'mistakeCost'],
    };
  }

  // Disqualifier 4. A judgment call on input with no fixed shape has no
  // rule set a system could follow. There is no automation target here,
  // only a case to decide.
  if (p.needsJudgment && !p.inputStructured) {
    return {
      level: 'keep-human',
      drivingProperty: 'needsJudgment',
      reason:
        'This step needs a judgment call and the input has no fixed structure for a system to read. There is no rule to encode, only a case to decide by hand.',
      contributingFactors: ['inputStructured'],
    };
  }

  // Nothing disqualifies automation outright. Collect every remaining
  // reason a person should still see the result before it counts as
  // done. A checkpoint step is still system performed for scoring
  // purposes below; the human signs off rather than doing the work.
  const checkpoint: Array<{ property: StepPropertyKey; reason: string }> = [];

  if (p.needsJudgment) {
    checkpoint.push({
      property: 'needsJudgment',
      reason:
        'Needs a judgment call, but the input is structured enough that a system can prepare the decision and route it to a person rather than deciding alone.',
    });
  }
  if (p.legalFinancialRisk && p.mistakeCost !== 'low') {
    checkpoint.push({
      property: 'legalFinancialRisk',
      reason:
        'Carries legal or financial exposure and a mistake is not cheap, but the action is reversible. Automate the work and require a human check before it becomes final.',
    });
  }
  if (!p.outputVerifiable) {
    checkpoint.push({
      property: 'outputVerifiable',
      reason:
        'The result cannot be checked automatically, so a person should look at it even though the action itself can still be undone if it turns out wrong.',
    });
  }
  if (!p.inputStructured) {
    checkpoint.push({
      property: 'inputStructured',
      reason:
        'The input arrives unstructured, so parsing it carries its own error rate. Keep a human check until the parser has proven itself.',
    });
  }

  if (checkpoint.length > 0) {
    const [first, ...rest] = checkpoint;
    return {
      level: 'automate-with-checkpoint',
      drivingProperty: first.property,
      reason: first.reason,
      contributingFactors: rest.map((c) => c.property),
    };
  }

  // Clean profile. Structured input, a result a system can check, an
  // undo path if the check is ever wrong, no judgment call, and no
  // meaningful risk. Nothing here needs a person in the loop.
  return {
    level: 'automate-now',
    drivingProperty: 'outputVerifiable',
    reason:
      'The input is structured, the result can be checked automatically, and the action can be undone if that check fails. Nothing here needs a person in the loop.',
    contributingFactors: ['inputStructured', 'reversible'],
  };
}

/* ------------------------------------------------------------------ *
 * Graph issues: cycles, orphans, broken dependencies
 *
 * A step's dependsOn lists every step that must finish first, so the
 * process as a whole is a DAG, and it is only legal to start where no
 * cycle exists. Cycle and orphan detection here are exact, a real
 * depth first search with a recursion stack, not an approximation.
 * ------------------------------------------------------------------ */

export type GraphIssueKind = 'cycle' | 'orphan-step' | 'broken-dependency';

export interface GraphIssue {
  kind: GraphIssueKind;
  stepIds: string[];
  message: string;
}

export const GRAPH_ISSUE_LABELS: Record<GraphIssueKind, string> = {
  cycle: 'Cycle',
  'orphan-step': 'Orphan step',
  'broken-dependency': 'Broken dependency',
};

/**
 * Depth first search with an explicit recursion stack, the standard
 * way to find cycles in a directed graph. A step marked "visiting" that
 * is reached again while still on the current path is a back edge, and
 * the slice of the path from that step onward is the actual cycle, the
 * real loop of step ids, not just the fact that one exists. A step
 * already fully resolved on an earlier walk is left alone, which is
 * what keeps this linear rather than exponential.
 */
export function detectCycles(steps: Step[]): string[][] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[][] = [];

  function visit(id: string, path: string[]): void {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const start = path.indexOf(id);
      cycles.push(path.slice(start));
      return;
    }
    state.set(id, 'visiting');
    const step = byId.get(id);
    // A dependsOn id naming a step that no longer exists is reported
    // separately as a broken dependency, so it is skipped here rather
    // than treated as a dead end that could hide a real cycle.
    const deps = step ? step.dependsOn.filter((d) => byId.has(d)) : [];
    for (const dep of deps) {
      visit(dep, [...path, id]);
    }
    state.set(id, 'done');
  }

  for (const step of steps) {
    if (!state.has(step.id)) visit(step.id, []);
  }

  return cycles;
}

/**
 * An orphan is a step with no connection to the rest of the process at
 * all: nothing it depends on, and nothing depends on it. A step that
 * starts its own chain but feeds a later step is a legitimate second
 * start, not an orphan, so it is excluded.
 */
export function detectOrphans(steps: Step[]): string[] {
  if (steps.length <= 1) return [];
  const hasDependent = new Set(steps.flatMap((s) => s.dependsOn));
  return steps
    .filter((s) => s.dependsOn.length === 0 && !hasDependent.has(s.id))
    .map((s) => s.id);
}

export function findGraphIssues(steps: Step[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map(steps.map((s) => [s.id, s]));
  const nameOf = (id: string) => byId.get(id)?.name || id;

  for (const step of steps) {
    const broken = step.dependsOn.filter((d) => !byId.has(d));
    if (broken.length > 0) {
      const phrase =
        broken.length === 1 ? 'a step that no longer exists' : `${broken.length} steps that no longer exist`;
      issues.push({
        kind: 'broken-dependency',
        stepIds: [step.id],
        message: `"${nameOf(step.id)}" depends on ${phrase}. Point it at a real step or clear the dependency.`,
      });
    }
  }

  for (const cycle of detectCycles(steps)) {
    const names = cycle.map(nameOf).join(', then ');
    issues.push({
      kind: 'cycle',
      stepIds: cycle,
      message: `These steps depend on each other in a loop: ${names}, and back to the first. A process cannot start from a circular dependency.`,
    });
  }

  for (const id of detectOrphans(steps)) {
    issues.push({
      kind: 'orphan-step',
      stepIds: [id],
      message: `"${nameOf(id)}" has no connection to the rest of the process. Link it to a dependency, or confirm it truly stands alone.`,
    });
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * Handoffs and silent failure
 *
 * A handoff is any edge where the step performing the work changes
 * from a system to a person or back. That crossing is where real
 * workflows break, because each side assumes the other checked
 * something it did not. A checkpoint step still counts as system
 * performed here, since a person only signs off rather than doing the
 * work themselves.
 * ------------------------------------------------------------------ */

export type Performer = 'system' | 'human' | 'undetermined';

export function performerFor(level: ClassificationLevel): Performer {
  if (level === 'automate-now' || level === 'automate-with-checkpoint') return 'system';
  if (level === 'keep-human') return 'human';
  return 'undetermined';
}

const PERFORMER_LABELS: Record<Performer, string> = {
  system: 'a system',
  human: 'a person',
  undetermined: 'undecided, it needs redesign',
};

export interface Handoff {
  fromStepId: string;
  toStepId: string;
  fromPerformer: Performer;
  toPerformer: Performer;
  message: string;
}

export function findHandoffs(
  steps: Step[],
  classifications: Map<string, Classification>,
): Handoff[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const handoffs: Handoff[] = [];

  for (const step of steps) {
    for (const dependsOnId of step.dependsOn) {
      const upstream = byId.get(dependsOnId);
      if (!upstream) continue; // reported separately, as a broken dependency

      const fromLevel = classifications.get(upstream.id)?.level;
      const toLevel = classifications.get(step.id)?.level;
      if (!fromLevel || !toLevel) continue;

      const fromPerformer = performerFor(fromLevel);
      const toPerformer = performerFor(toLevel);
      if (fromPerformer === toPerformer) continue;

      handoffs.push({
        fromStepId: upstream.id,
        toStepId: step.id,
        fromPerformer,
        toPerformer,
        message: `Work passes from "${upstream.name || upstream.id}" (${PERFORMER_LABELS[fromPerformer]}) to "${step.name || step.id}" (${PERFORMER_LABELS[toPerformer]}). This crossing is where the process is most likely to break.`,
      });
    }
  }

  return handoffs;
}

export interface SilentFailureRisk {
  stepId: string;
  message: string;
}

/**
 * A step whose failure would be silent: something depends on it, but
 * nothing checks its own result, so a bad output keeps moving through
 * the process undetected. This is checked independently of automation
 * status, because an unverified handoff between two human steps is just
 * as silent as one between two automated steps.
 */
export function findSilentFailureRisks(steps: Step[]): SilentFailureRisk[] {
  const dependedOn = new Set(steps.flatMap((s) => s.dependsOn));
  return steps
    .filter((s) => dependedOn.has(s.id) && !s.properties.outputVerifiable)
    .map((s) => ({
      stepId: s.id,
      message: `"${s.name || s.id}" feeds later steps but nothing checks its own result. If it fails, the process keeps running on a bad output until someone notices much later.`,
    }));
}

/* ------------------------------------------------------------------ *
 * Implementation order
 * ------------------------------------------------------------------ */

/** Additive penalty applied when legal or financial risk is present and a mistake is not cheap. */
export const RISK_UNIT = 3;

export const PRIORITY_SCORE_METHOD =
  'Score equals frequency weight times mistake cost weight, minus a risk penalty when the step carries legal or financial exposure and a mistake is not cheap. Frequency and cost weights are ordinal estimates (rare 1, monthly 3, weekly 8, daily 20; low 1, medium 4, high 10), not measured counts or currency. Only steps classified automate now or automate with a checkpoint are ranked, since keep human and needs redesign steps are not being automated at all.';

export interface PriorityEntry {
  stepId: string;
  score: number;
  frequencyWeight: number;
  costWeight: number;
  riskPenalty: number;
}

export function computeImplementationOrder(
  steps: Step[],
  classifications: Map<string, Classification>,
): PriorityEntry[] {
  const entries: PriorityEntry[] = [];

  for (const step of steps) {
    const level = classifications.get(step.id)?.level;
    if (level !== 'automate-now' && level !== 'automate-with-checkpoint') continue;

    const frequencyWeight = FREQUENCY_WEIGHT[step.properties.frequency];
    const costWeight = COST_WEIGHT[step.properties.mistakeCost];
    const riskPenalty =
      step.properties.legalFinancialRisk && step.properties.mistakeCost !== 'low'
        ? costWeight * RISK_UNIT
        : 0;
    const score = frequencyWeight * costWeight - riskPenalty;

    entries.push({ stepId: step.id, score, frequencyWeight, costWeight, riskPenalty });
  }

  // Highest score first. Ties keep the step's original position, so the
  // order is stable across runs and explainable by the numbers alone,
  // never by sort implementation details.
  const indexOf = new Map(steps.map((s, i) => [s.id, i]));
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (indexOf.get(a.stepId) ?? 0) - (indexOf.get(b.stepId) ?? 0);
  });

  return entries;
}

/* ------------------------------------------------------------------ *
 * Actors and approval points
 *
 * PRD input model: "add inputs, actors, constraints, and approval
 * points." Outcome, inputs, and constraints are free text a user states
 * once at the process level, above in ProcessState. Actors and approval
 * points are NOT a second list a user has to maintain by hand: actors
 * are the distinct owners already stated on every step, and approval
 * points are the steps classification and handoff detection already
 * identify as needing a person. Deriving both means neither can drift
 * out of sync with the steps that define them.
 * ------------------------------------------------------------------ */

/** Distinct owners across every step, in first appearance order. */
export function deriveActors(steps: Step[]): string[] {
  const seen = new Set<string>();
  const actors: string[] = [];
  for (const step of steps) {
    const owner = step.owner.trim();
    if (owner && !seen.has(owner)) {
      seen.add(owner);
      actors.push(owner);
    }
  }
  return actors;
}

export interface ApprovalPoint {
  stepId: string;
  name: string;
  reason: string;
}

/**
 * A step is an approval point when a person must decide something
 * before the process can rely on it: it is the human side of a handoff,
 * it is a checkpoint step that needs a sign off regardless of where its
 * input came from, or it is a fully human step reached by no handoff at
 * all, for example the first step in the process. Returned in process
 * order rather than discovery order.
 */
export function deriveApprovalPoints(
  steps: Step[],
  classifications: Map<string, Classification>,
  handoffs: Handoff[],
): ApprovalPoint[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const points = new Map<string, ApprovalPoint>();

  for (const h of handoffs) {
    if (h.toPerformer !== 'human') continue;
    const step = byId.get(h.toStepId);
    if (!step || points.has(step.id)) continue;
    points.set(step.id, {
      stepId: step.id,
      name: step.name || step.id,
      reason: 'Work reaches this step from a system, and a person decides what happens next.',
    });
  }

  for (const step of steps) {
    if (points.has(step.id)) continue;
    if (classifications.get(step.id)?.level === 'automate-with-checkpoint') {
      points.set(step.id, {
        stepId: step.id,
        name: step.name || step.id,
        reason: 'This step is automated, but a person must sign off before its result is final.',
      });
    }
  }

  for (const step of steps) {
    if (points.has(step.id)) continue;
    if (classifications.get(step.id)?.level === 'keep-human') {
      points.set(step.id, {
        stepId: step.id,
        name: step.name || step.id,
        reason: 'This step is performed by a person end to end.',
      });
    }
  }

  return steps.filter((s) => points.has(s.id)).map((s) => points.get(s.id) as ApprovalPoint);
}

/* ------------------------------------------------------------------ *
 * Whole process analysis
 * ------------------------------------------------------------------ */

export interface ProcessAnalysis {
  classifications: Map<string, Classification>;
  levelCounts: Record<ClassificationLevel, number>;
  graphIssues: GraphIssue[];
  handoffs: Handoff[];
  silentFailureRisks: SilentFailureRisk[];
  implementationOrder: PriorityEntry[];
  actors: string[];
  approvalPoints: ApprovalPoint[];
}

export function analyzeProcess(state: ProcessState): ProcessAnalysis {
  const classifications = new Map<string, Classification>();
  for (const step of state.steps) {
    classifications.set(step.id, classifyStep(step.properties));
  }

  const levelCounts = CLASSIFICATION_LEVELS.reduce(
    (acc, level) => {
      acc[level] = 0;
      return acc;
    },
    {} as Record<ClassificationLevel, number>,
  );
  for (const c of classifications.values()) levelCounts[c.level] += 1;

  const handoffs = findHandoffs(state.steps, classifications);

  return {
    classifications,
    levelCounts,
    graphIssues: findGraphIssues(state.steps),
    handoffs,
    silentFailureRisks: findSilentFailureRisks(state.steps),
    implementationOrder: computeImplementationOrder(state.steps, classifications),
    actors: deriveActors(state.steps),
    approvalPoints: deriveApprovalPoints(state.steps, classifications, handoffs),
  };
}

/* ------------------------------------------------------------------ *
 * Agent Designer handoff, an explicit export only
 *
 * PRD acceptance criterion: "User can promote the workflow into Agent
 * Designer through an explicit export, not hidden coupling." This file
 * never imports src/lib/tools/agent-designer.ts, and must never be
 * imported by it either. The shape below IS the whole contract between
 * the two tools: a user reads or downloads this JSON here and carries
 * it into Agent Designer by hand. There is no live call, no shared
 * module, and no runtime dependency in either direction, which is what
 * "explicit export, not hidden coupling" requires.
 * ------------------------------------------------------------------ */

export const AGENT_DESIGNER_SCHEMA = 'nixfred.workflow-decomposer.agent-designer-handoff.v1';

export interface AgentDesignerCandidate {
  /** The step this candidate came from, so a person can trace it back. */
  sourceStepId: string;
  name: string;
  /** Always automate-now or automate-with-checkpoint. Nothing else becomes a candidate. */
  classification: ClassificationLevel;
  /** Whether a person must sign off before this candidate's result is final. */
  requiresHumanCheckpoint: boolean;
  /** Carried over from the step. What proves the work actually happened. */
  completionEvidence: string;
  /** Who owns this today, a starting point for who signs off on the built agent. */
  currentOwner: string;
  /** Plain language limits, derived from the step's own properties. */
  limits: string[];
  /** Step ids this candidate must wait on before it can run. */
  dependsOnStepIds: string[];
}

export interface AgentDesignerEscalationPath {
  fromStepId: string;
  toStepId: string;
  /** Always "human". An escalation path is, by definition, work leaving the system for a person. */
  toPerformer: Performer;
  reason: string;
}

export interface AgentDesignerPayload {
  schema: typeof AGENT_DESIGNER_SCHEMA;
  processOutcome: string;
  generatedBy: string;
  note: string;
  candidates: AgentDesignerCandidate[];
  escalationPaths: AgentDesignerEscalationPath[];
}

function deriveLimits(properties: StepProperties, requiresCheckpoint: boolean): string[] {
  const limits: string[] = [];
  if (requiresCheckpoint) {
    limits.push('Requires a human check before the result is final.');
  }
  if (properties.legalFinancialRisk) {
    limits.push('Carries legal or financial exposure. Scope its authority narrowly and log every action.');
  }
  if (!properties.reversible) {
    limits.push('Cannot be undone once taken. Verify inputs before it commits.');
  }
  if (!properties.inputStructured) {
    limits.push('Reads unstructured input. Treat its parsing as unreliable until proven otherwise.');
  }
  if (limits.length === 0) {
    limits.push('No special limits beyond normal monitoring.');
  }
  return limits;
}

/**
 * Build the explicit export payload for Agent Designer. Only steps
 * classified automate now or automate with a checkpoint become
 * candidates, since keep human and needs redesign steps are not being
 * handed to an agent at all. Escalation paths are the handoffs that
 * land on a person, which is exactly what an agent built from these
 * candidates would need to hand off itself.
 */
export function buildAgentDesignerPayload(state: ProcessState): AgentDesignerPayload {
  const analysis = analyzeProcess(state);

  const candidates: AgentDesignerCandidate[] = state.steps.flatMap((step) => {
    const classification = analysis.classifications.get(step.id);
    if (
      !classification ||
      (classification.level !== 'automate-now' && classification.level !== 'automate-with-checkpoint')
    ) {
      return [];
    }
    const requiresHumanCheckpoint = classification.level === 'automate-with-checkpoint';
    return [
      {
        sourceStepId: step.id,
        name: step.name || step.id,
        classification: classification.level,
        requiresHumanCheckpoint,
        completionEvidence: step.completionEvidence,
        currentOwner: step.owner,
        limits: deriveLimits(step.properties, requiresHumanCheckpoint),
        dependsOnStepIds: step.dependsOn,
      },
    ];
  });

  const escalationPaths: AgentDesignerEscalationPath[] = analysis.handoffs
    .filter((h) => h.toPerformer === 'human')
    .map((h) => ({
      fromStepId: h.fromStepId,
      toStepId: h.toStepId,
      toPerformer: h.toPerformer,
      reason: h.message,
    }));

  return {
    schema: AGENT_DESIGNER_SCHEMA,
    processOutcome: state.outcome,
    generatedBy: 'Nixfred AI Systems Workbench, Workflow Decomposer',
    note: 'Explicit export for Agent Designer. This is a data handoff a person carries over by hand, not a live integration. Nothing in this file calls Agent Designer, and nothing in Agent Designer calls this file.',
    candidates,
    escalationPaths,
  };
}

/**
 * Validates a value against the AgentDesignerPayload shape without
 * importing anything from Agent Designer. This function IS the
 * documented contract; a shape error here means the payload changed
 * without this validator changing with it, not that Agent Designer
 * disagrees with something it never sees. Returns [] when valid.
 */
export function validateAgentDesignerPayload(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['payload is not an object'];
  }
  const payload = value as Record<string, unknown>;

  if (payload.schema !== AGENT_DESIGNER_SCHEMA) {
    errors.push(`schema must be "${AGENT_DESIGNER_SCHEMA}", got ${JSON.stringify(payload.schema)}`);
  }
  if (typeof payload.processOutcome !== 'string') errors.push('processOutcome must be a string');
  if (typeof payload.generatedBy !== 'string') errors.push('generatedBy must be a string');
  if (typeof payload.note !== 'string') errors.push('note must be a string');

  if (!Array.isArray(payload.candidates)) {
    errors.push('candidates must be an array');
  } else {
    payload.candidates.forEach((c, i) => {
      if (typeof c !== 'object' || c === null) {
        errors.push(`candidates[${i}] is not an object`);
        return;
      }
      const candidate = c as Record<string, unknown>;
      const requiredStrings: string[] = [
        'sourceStepId',
        'name',
        'classification',
        'completionEvidence',
        'currentOwner',
      ];
      for (const field of requiredStrings) {
        if (typeof candidate[field] !== 'string') {
          errors.push(`candidates[${i}].${field} must be a string`);
        }
      }
      if (typeof candidate.requiresHumanCheckpoint !== 'boolean') {
        errors.push(`candidates[${i}].requiresHumanCheckpoint must be a boolean`);
      }
      if (!Array.isArray(candidate.limits) || !candidate.limits.every((l) => typeof l === 'string')) {
        errors.push(`candidates[${i}].limits must be a string array`);
      }
      if (
        !Array.isArray(candidate.dependsOnStepIds) ||
        !candidate.dependsOnStepIds.every((d) => typeof d === 'string')
      ) {
        errors.push(`candidates[${i}].dependsOnStepIds must be a string array`);
      }
      if (
        candidate.classification !== 'automate-now' &&
        candidate.classification !== 'automate-with-checkpoint'
      ) {
        errors.push(
          `candidates[${i}].classification must be automate-now or automate-with-checkpoint, got ${JSON.stringify(candidate.classification)}`,
        );
      }
    });
  }

  if (!Array.isArray(payload.escalationPaths)) {
    errors.push('escalationPaths must be an array');
  } else {
    payload.escalationPaths.forEach((p, i) => {
      if (typeof p !== 'object' || p === null) {
        errors.push(`escalationPaths[${i}] is not an object`);
        return;
      }
      const path = p as Record<string, unknown>;
      if (typeof path.fromStepId !== 'string') errors.push(`escalationPaths[${i}].fromStepId must be a string`);
      if (typeof path.toStepId !== 'string') errors.push(`escalationPaths[${i}].toStepId must be a string`);
      if (path.toPerformer !== 'human') {
        errors.push(`escalationPaths[${i}].toPerformer must be "human", got ${JSON.stringify(path.toPerformer)}`);
      }
      if (typeof path.reason !== 'string') errors.push(`escalationPaths[${i}].reason must be a string`);
    });
  }

  return errors;
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * Three ship. Each is a realistic process chosen to demonstrate a
 * different part of the engine: a step that cannot be classified until
 * it is redefined, the headline rule that volume never overrides an
 * irreversible unverifiable step, and a priority order where the
 * highest stakes steps are not the first ones worth building. The
 * invoice sample also carries a genuine DAG merge point, one step
 * waiting on two others, to exercise the multi dependency model.
 * ------------------------------------------------------------------ */

export interface Sample {
  id: string;
  name: string;
  teaches: string;
  state: ProcessState;
}

export const SAMPLES: Sample[] = [
  {
    id: 'refund-handling',
    name: 'Customer refund request',
    teaches:
      'A step nobody can verify needs redesign before it can be classified at all, and a human approval feeding straight into an automated payment is exactly the handoff that breaks.',
    state: {
      outcome: 'Customer refund request handling',
      inputs:
        'A support ticket containing the order number, the stated reason, and the requested amount.',
      constraints:
        'Refunds over 500 dollars require manager approval. All refunds must complete within 5 business days of the request.',
      scenarioId: 'refund-handling',
      steps: [
        {
          id: 'parse-ticket',
          name: 'Read the incoming request and pull out order, reason, and amount',
          owner: 'Support system, unassigned today',
          completionEvidence: 'None defined yet',
          dependsOn: [],
          properties: {
            inputStructured: false,
            outputVerifiable: false,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: false,
            frequency: 'daily',
            mistakeCost: 'medium',
          },
        },
        {
          id: 'check-eligibility',
          name: 'Check the order against the refund policy',
          owner: 'Refund service',
          completionEvidence: 'Eligibility result recorded on the ticket',
          dependsOn: ['parse-ticket'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: false,
            frequency: 'daily',
            mistakeCost: 'low',
          },
        },
        {
          id: 'approve-large-refund',
          name: 'Approve refunds over 500 dollars',
          owner: 'Support manager',
          completionEvidence: 'Approval decision logged with a name and a timestamp',
          dependsOn: ['check-eligibility'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: false,
            needsJudgment: true,
            legalFinancialRisk: true,
            frequency: 'weekly',
            mistakeCost: 'high',
          },
        },
        {
          id: 'issue-payment',
          name: 'Send the refund through the payment processor',
          owner: 'Payments service',
          completionEvidence: 'Payment confirmation id stored on the ticket',
          dependsOn: ['approve-large-refund'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: true,
            frequency: 'daily',
            mistakeCost: 'high',
          },
        },
        {
          id: 'send-confirmation',
          name: 'Email the Customer a refund confirmation',
          owner: 'Notification service',
          completionEvidence: 'Delivery receipt from the email provider',
          dependsOn: ['issue-payment'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: false,
            frequency: 'daily',
            mistakeCost: 'low',
          },
        },
      ],
    },
  },
  {
    id: 'file-cleanup',
    name: 'Automated disk cleanup',
    teaches:
      'The headline rule. Deleting flagged files is the most frequent step in this process and still stays keep human, because it cannot be undone and its result cannot be checked.',
    state: {
      outcome: 'Automated disk cleanup',
      inputs: 'A list of file paths under the project root and their last modified dates.',
      constraints: 'Never delete a file that is referenced by an active import.',
      scenarioId: 'file-cleanup',
      steps: [
        {
          id: 'scan-files',
          name: 'Scan the project directory for candidate unused files',
          owner: 'Cleanup agent',
          completionEvidence: 'Candidate file list written to a report',
          dependsOn: [],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: false,
            frequency: 'daily',
            mistakeCost: 'low',
          },
        },
        {
          id: 'delete-files',
          name: 'Delete the flagged files',
          owner: 'Cleanup agent, unsupervised today',
          completionEvidence: 'None. The files are simply gone',
          dependsOn: ['scan-files'],
          properties: {
            inputStructured: true,
            outputVerifiable: false,
            reversible: false,
            needsJudgment: true,
            legalFinancialRisk: false,
            frequency: 'daily',
            mistakeCost: 'high',
          },
        },
      ],
    },
  },
  {
    id: 'invoice-processing',
    name: 'Vendor invoice processing',
    teaches:
      'Priority order is not a ranking of importance. Approving the largest invoices, and verifying vendor bank details, are the two highest stakes steps here and both still rank last to build, because they run rarely and the risk penalty outweighs the payoff. The payment run also waits on both of them at once, a real DAG merge, not a chain.',
    state: {
      outcome: 'Vendor invoice processing',
      inputs: 'A scanned vendor invoice and the purchase order it should match.',
      constraints:
        'Invoices over 10000 dollars require finance manager approval before payment is scheduled.',
      scenarioId: 'invoice-processing',
      steps: [
        {
          id: 'extract-invoice',
          name: 'Extract line items and totals from the scanned invoice',
          owner: 'Extraction service',
          completionEvidence: 'Extracted totals cross checked against the purchase order',
          dependsOn: [],
          properties: {
            inputStructured: false,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: false,
            frequency: 'daily',
            mistakeCost: 'low',
          },
        },
        {
          id: 'match-po',
          name: 'Match the invoice to its purchase order',
          owner: 'Invoice service',
          completionEvidence: 'Match result stored with both record ids',
          dependsOn: ['extract-invoice'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: false,
            frequency: 'daily',
            mistakeCost: 'low',
          },
        },
        {
          id: 'approve-large-invoice',
          name: 'Approve invoices over 10000 dollars',
          owner: 'Finance manager',
          completionEvidence: 'Approval logged with a name and a date',
          dependsOn: ['match-po'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: true,
            legalFinancialRisk: true,
            frequency: 'monthly',
            mistakeCost: 'high',
          },
        },
        {
          id: 'verify-vendor-bank-details',
          name: 'Verify the vendor bank account on file',
          owner: 'Payments service',
          completionEvidence: 'Bank account match confirmed against the vendor record',
          dependsOn: ['match-po'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: true,
            frequency: 'monthly',
            mistakeCost: 'high',
          },
        },
        {
          id: 'schedule-payment',
          name: 'Schedule the payment run',
          owner: 'Payments service',
          completionEvidence: 'Scheduled batch id recorded',
          dependsOn: ['approve-large-invoice', 'verify-vendor-bank-details'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: true,
            frequency: 'weekly',
            mistakeCost: 'medium',
          },
        },
        {
          id: 'file-invoice-record',
          name: 'File the invoice record for audit',
          owner: 'Records service',
          completionEvidence: 'Record id appears in the audit index',
          dependsOn: ['schedule-payment'],
          properties: {
            inputStructured: true,
            outputVerifiable: true,
            reversible: true,
            needsJudgment: false,
            legalFinancialRisk: false,
            frequency: 'daily',
            mistakeCost: 'low',
          },
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

export function emptyState(): ProcessState {
  return { outcome: '', inputs: '', constraints: '', steps: [], scenarioId: '' };
}

export function sampleState(id: string = SAMPLES[0].id): ProcessState {
  const sample = getSample(id) ?? SAMPLES[0];
  // Deep copy, including the dependsOn arrays. A tool must never let
  // the page mutate the shipped sample data out from under a later
  // "load sample" click; an array reference shared with the sample
  // would let a later splice or push corrupt it silently.
  return {
    outcome: sample.state.outcome,
    inputs: sample.state.inputs,
    constraints: sample.state.constraints,
    scenarioId: sample.state.scenarioId,
    steps: sample.state.steps.map((s) => ({
      ...s,
      dependsOn: [...s.dependsOn],
      properties: { ...s.properties },
    })),
  };
}

export function reset(): ProcessState {
  return emptyState();
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: ProcessState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (state.steps.length === 0) {
    issues.push({
      field: 'steps',
      message: 'Add at least one step, or load a sample.',
      severity: 'error',
    });
    return issues;
  }

  state.steps.forEach((step, index) => {
    const label = step.name.trim() || `Step ${index + 1}`;
    if (!step.name.trim()) {
      issues.push({
        field: `steps[${index}].name`,
        message: `Step ${index + 1} has no name.`,
        severity: 'warning',
      });
    }
    if (!step.owner.trim()) {
      issues.push({
        field: `steps[${index}].owner`,
        message: `"${label}" has no owner. State who or what is accountable for it today.`,
        severity: 'warning',
      });
    }
    if (!step.completionEvidence.trim()) {
      issues.push({
        field: `steps[${index}].completionEvidence`,
        message: `"${label}" has no completion evidence. State how anyone would confirm it actually finished. A step whose doneness cannot be evidenced cannot be automated or delegated reliably.`,
        severity: 'warning',
      });
    }
  });

  return issues;
}

export type ExportFormat = 'json' | 'markdown';

function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workflow-decomposer';
}

export function serialize(state: ProcessState, format: ExportFormat): string {
  const analysis = analyzeProcess(state);
  const byId = new Map(state.steps.map((s) => [s.id, s]));

  const stepRows = state.steps.map((step) => ({
    id: step.id,
    name: step.name,
    owner: step.owner,
    completionEvidence: step.completionEvidence,
    dependsOn: step.dependsOn,
    properties: step.properties,
    classification: analysis.classifications.get(step.id),
  }));

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Workflow Decomposer',
        note: 'Local rule based classification. No model produced these results.',
        priorityScoreMethod: PRIORITY_SCORE_METHOD,
        outcome: state.outcome,
        inputs: state.inputs,
        constraints: state.constraints,
        actors: analysis.actors,
        steps: stepRows,
        levelCounts: analysis.levelCounts,
        graphIssues: analysis.graphIssues,
        handoffs: analysis.handoffs,
        silentFailureRisks: analysis.silentFailureRisks,
        approvalPoints: analysis.approvalPoints,
        implementationOrder: analysis.implementationOrder.map((entry) => ({
          ...entry,
          name: byId.get(entry.stepId)?.name ?? entry.stepId,
        })),
      },
      null,
      2,
    );
  }

  const renderStep = (step: Step, index: number) => {
    const c = analysis.classifications.get(step.id);
    const dependsOnNames = step.dependsOn.length
      ? step.dependsOn.map((id) => byId.get(id)?.name ?? id).join(', ')
      : 'Nothing, this starts a chain';
    return [
      `### ${index + 1}. ${step.name || step.id}`,
      '',
      `Owner: ${step.owner || '(none stated)'}`,
      '',
      `Completion evidence: ${step.completionEvidence || '(none stated)'}`,
      '',
      `Depends on: ${dependsOnNames}`,
      '',
      `Classification: ${c ? CLASSIFICATION_LABELS[c.level] : 'unclassified'}`,
      '',
      c ? `Reason: ${c.reason}` : '',
      '',
    ].join('\n');
  };

  const graphIssuesText = analysis.graphIssues.length
    ? analysis.graphIssues.map((g, i) => `${i + 1}. ${g.message}`).join('\n')
    : 'None detected.';

  const handoffsText = analysis.handoffs.length
    ? analysis.handoffs.map((h, i) => `${i + 1}. ${h.message}`).join('\n')
    : 'None. No edge in this process crosses from a system to a person or back.';

  const silentText = analysis.silentFailureRisks.length
    ? analysis.silentFailureRisks.map((s, i) => `${i + 1}. ${s.message}`).join('\n')
    : 'None detected.';

  const approvalPointsText = analysis.approvalPoints.length
    ? analysis.approvalPoints.map((a, i) => `${i + 1}. ${a.name}. ${a.reason}`).join('\n')
    : 'None. Nothing in this process currently requires a human sign off.';

  const orderText = analysis.implementationOrder.length
    ? analysis.implementationOrder
        .map(
          (entry, i) =>
            `${i + 1}. ${byId.get(entry.stepId)?.name ?? entry.stepId}, score ${entry.score} (frequency weight ${entry.frequencyWeight} times cost weight ${entry.costWeight}, minus risk penalty ${entry.riskPenalty})`,
        )
        .join('\n')
    : 'No step in this process is classified automate now or automate with a checkpoint.';

  return [
    `# Workflow Decomposer report: ${state.outcome || '(unnamed process)'}`,
    '',
    'Local rule based classification. No model produced these results.',
    '',
    '## Process',
    '',
    `Outcome: ${state.outcome || '(not stated)'}`,
    '',
    `Inputs: ${state.inputs || '(not stated)'}`,
    '',
    `Constraints: ${state.constraints || '(not stated)'}`,
    '',
    `Actors: ${analysis.actors.length ? analysis.actors.join(', ') : '(none stated)'}`,
    '',
    '## Steps',
    '',
    ...state.steps.map(renderStep),
    '## Structural issues',
    '',
    graphIssuesText,
    '',
    '## Handoffs',
    '',
    handoffsText,
    '',
    '## Silent failure risks',
    '',
    silentText,
    '',
    '## Approval points',
    '',
    approvalPointsText,
    '',
    '## Implementation order',
    '',
    `Method: ${PRIORITY_SCORE_METHOD}`,
    '',
    orderText,
    '',
  ].join('\n');
}

export function filename(state: ProcessState, _format: ExportFormat): string {
  return `${slugify(state.outcome)}-workflow-report`;
}
