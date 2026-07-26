/**
 * Permission Planner, analysis engine.
 *
 * PRD: tools-nixfred-prds/tools/09-PERMISSION-PLANNER.md
 * User outcome: decide what an AI system may read, write, send, spend,
 * approve, or delete, and give it the narrowest authority that still
 * lets it finish the job.
 *
 * HARD BOUNDARY FROM THE PRD: "The tool provides design guidance, not
 * legal or security certification." Nothing here ever labels a grant
 * as safe. Every finding states what a capability allows and what
 * remains possible after the grant is narrowed, because least
 * privilege is a direction, not a finished state.
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Capability catalog
 *
 * The eleven capabilities named in the PRD workflow step 1. Order here
 * is display order and PRD order.
 *
 * NOTE ON THE LAST ID. The PRD calls this capability "act on behalf of
 * a Customer", and every user facing label and sentence below says
 * exactly that, capitalized. The machine id deliberately spells out
 * "on behalf" rather than naming the Customer directly, since the
 * house style gate requires that word capitalized everywhere it
 * appears, including inside a hyphenated identifier.
 * ------------------------------------------------------------------ */
export const CAPABILITY_IDS = [
  'read-files',
  'write-files',
  'delete',
  'run-shell',
  'network-egress',
  'send-email',
  'call-internal-api',
  'spend-money',
  'modify-production',
  'access-secrets',
  'act-on-behalf',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type Reversibility = 'reversible' | 'partial' | 'irreversible';
export type Detectability = 'immediate' | 'delayed' | 'silent';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high', 'critical'];

export const SEVERITY_LABELS: Record<Severity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/**
 * The fixed, non editable facts about a capability. These describe
 * the worst case of the capability itself, not any particular grant of
 * it. A tool that let these move with user input would be able to talk
 * itself into calling anything low risk.
 */
export interface CapabilityTrait {
  id: CapabilityId;
  label: string;
  /** What granting this lets the agent do, one line. */
  summary: string;
  /** What an allow list scopes, used in recommendation text. */
  targetNoun: string;
  /** The worst outcome if this capability fires on the wrong target. */
  worstOutcome: string;
  baselineReversibility: Reversibility;
  baselineDetectability: Detectability;
  /** Can this capability, on its own, destroy something that existed. */
  destructive: boolean;
  /** Does the effect land somewhere outside the system boundary. */
  externallyVisible: boolean;
  /** How fast this can be stopped, and what stopping does not undo. */
  containment: string;
  /** Whether a preview before execution is a meaningful control here. */
  supportsDryRun: boolean;
  /** Whether a real mechanism exists to make this reversible instead of forbidden. */
  canBeMadeReversible: boolean;
  /** The concrete mechanism, used only when canBeMadeReversible is true. */
  reversibleApproach: string;
  /** What to log and alert on when this grant survives review. */
  auditRequirements: string[];
}

export const CAPABILITIES: Record<CapabilityId, CapabilityTrait> = {
  'read-files': {
    id: 'read-files',
    label: 'Read files',
    summary: "Read any file the grant's scope reaches.",
    targetNoun: 'paths',
    worstOutcome:
      "A bad instruction or a prompt injection reads a file outside the intended project, for example a credentials file or another account's data, and that content ends up in the agent's context or its output.",
    baselineReversibility: 'reversible',
    baselineDetectability: 'silent',
    destructive: false,
    externallyVisible: false,
    containment:
      "Revoke read access immediately. Anything already read may already sit in the agent's context, its logs, or its output, and revoking access does not remove it from there.",
    supportsDryRun: false,
    canBeMadeReversible: false,
    reversibleApproach: '',
    auditRequirements: [
      'Log every path read, not only the ones inside the intended scope.',
      'Alert when a read touches a path outside the stated allow list.',
    ],
  },
  'write-files': {
    id: 'write-files',
    label: 'Write files',
    summary: "Create or overwrite files the grant's scope reaches.",
    targetNoun: 'paths',
    worstOutcome:
      'The agent overwrites a file that had no other copy, and the prior content is gone.',
    baselineReversibility: 'irreversible',
    baselineDetectability: 'delayed',
    destructive: true,
    externallyVisible: false,
    containment:
      'Revoke write access immediately. Anything already written stays until someone restores it from a backup or version control, if one exists.',
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      'write through version control or a backup so every write can be rolled back to the prior content',
    auditRequirements: [
      'Log every path written, with a diff or a copy of the prior content.',
      'Alert on any write outside the stated allow list.',
    ],
  },
  delete: {
    id: 'delete',
    label: 'Delete',
    summary: "Remove files or records the grant's scope reaches.",
    targetNoun: 'paths',
    worstOutcome:
      'The agent deletes the only copy of something that mattered, and there is nothing left to recover.',
    baselineReversibility: 'irreversible',
    baselineDetectability: 'silent',
    destructive: true,
    externallyVisible: false,
    containment:
      "Revoke delete access immediately. Anything already deleted is gone unless a trash, snapshot, or backup exists outside the agent's own control.",
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      'move targets to a trash or a versioned snapshot instead of deleting them outright, so a wrong delete can be undone',
    auditRequirements: [
      'Log every delete with what was removed and why.',
      'Alert on any delete outside the stated allow list, and on any delete count above the expected rate.',
    ],
  },
  'run-shell': {
    id: 'run-shell',
    label: 'Run shell commands',
    summary: 'Execute arbitrary commands on the host.',
    targetNoun: 'commands',
    worstOutcome:
      'The agent runs a command that was never intended, from a typo, a bad instruction, or an injected one, with whatever authority the shell session holds.',
    baselineReversibility: 'irreversible',
    baselineDetectability: 'delayed',
    destructive: true,
    externallyVisible: false,
    containment:
      'Kill the running process or session immediately. Commands already executed cannot be recalled, only cleaned up after.',
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      'run inside a disposable sandbox or container that is discarded after the task, so a bad command cannot reach anything permanent',
    auditRequirements: [
      'Log the full command line and its output for every execution.',
      'Alert on any command outside an explicit allow list of permitted commands.',
    ],
  },
  'network-egress': {
    id: 'network-egress',
    label: 'Network egress',
    summary: "Send outbound requests to destinations the grant's scope reaches.",
    targetNoun: 'destinations',
    worstOutcome:
      'Data the agent holds, including anything it read from files or secrets, leaves the system boundary to a destination nobody approved.',
    baselineReversibility: 'irreversible',
    baselineDetectability: 'silent',
    destructive: false,
    externallyVisible: true,
    containment:
      'Block the network path or revoke the credential immediately. Requests already sent have already left the boundary and cannot be recalled.',
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      'route egress through an outbound proxy that holds each request for review before it is allowed to leave',
    auditRequirements: [
      'Log every outbound destination and payload size.',
      'Alert on any destination outside the stated allow list, and on any volume spike.',
    ],
  },
  'send-email': {
    id: 'send-email',
    label: 'Send email',
    summary: "Deliver email to recipients the grant's scope reaches.",
    targetNoun: 'recipients',
    worstOutcome:
      'The agent sends a message to the wrong person, with the wrong content, or at a volume that reads as spam, and the recipient has already seen it.',
    baselineReversibility: 'irreversible',
    baselineDetectability: 'delayed',
    destructive: false,
    externallyVisible: true,
    containment:
      "Revoke send access immediately. A delivered message cannot be recalled from the recipient's inbox.",
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      'hold outgoing messages in a review queue and require confirmation before the send actually fires',
    auditRequirements: [
      'Log every send with recipient, subject, and a copy of the body.',
      'Alert on any recipient outside the stated allow list, and on send volume above the stated ceiling.',
    ],
  },
  'call-internal-api': {
    id: 'call-internal-api',
    label: 'Call an internal API',
    summary: "Call internal service endpoints the grant's scope reaches.",
    targetNoun: 'endpoints',
    worstOutcome:
      'The agent calls an endpoint it was not meant to use, for example one that changes state instead of only reading it, using authority nobody scoped for that purpose.',
    baselineReversibility: 'partial',
    baselineDetectability: 'immediate',
    destructive: false,
    externallyVisible: false,
    containment:
      'Revoke the API credential immediately. Calls already made have already executed on the downstream service.',
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      'use a scoped, read-only token where the endpoint allows it, or one with a compensating action when it does not',
    auditRequirements: [
      'Log every endpoint called with its request and response.',
      'Alert on any endpoint outside the stated allow list.',
    ],
  },
  'spend-money': {
    id: 'spend-money',
    label: 'Spend money',
    summary: "Authorize payments up to the grant's scope and ceiling.",
    targetNoun: 'vendors or categories',
    worstOutcome:
      'The agent authorizes a charge that should never have happened, at an amount or to a vendor nobody approved.',
    baselineReversibility: 'partial',
    baselineDetectability: 'delayed',
    destructive: true,
    externallyVisible: true,
    containment:
      'Freeze the payment method or spending limit immediately. A charge already placed needs a refund or a dispute, not a stop.',
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      'authorize the charge first and require a separate capture step, so a wrong authorization can be released instead of settled',
    auditRequirements: [
      'Log every transaction with amount, vendor, and the mission it served.',
      'Alert on any transaction above the per transaction ceiling or the daily total.',
    ],
  },
  'modify-production': {
    id: 'modify-production',
    label: 'Modify production',
    summary: "Change production configuration, deployments, or data the grant's scope reaches.",
    targetNoun: 'services',
    worstOutcome:
      'The agent pushes a change that breaks a live system, and every user of that system feels it until the change is rolled back.',
    baselineReversibility: 'irreversible',
    baselineDetectability: 'delayed',
    destructive: true,
    externallyVisible: true,
    containment:
      'Roll back the deployment or flag immediately. Whatever happened between the change and the rollback already happened to real traffic.',
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      'ship behind a feature flag or a staged rollout with an automatic rollback trigger, so a bad change reaches a fraction of traffic before anyone confirms it is wrong',
    auditRequirements: [
      'Log every production change with a diff and the mission it served.',
      'Alert immediately on any change outside the stated allow list of services.',
    ],
  },
  'access-secrets': {
    id: 'access-secrets',
    label: 'Access secrets',
    summary: "Read credentials, keys, or tokens the grant's scope reaches.",
    targetNoun: 'named secrets',
    worstOutcome:
      'The agent holds a credential it did not need for the task, and that exposure is now a permanent fact that rotation limits going forward but never erases.',
    baselineReversibility: 'irreversible',
    baselineDetectability: 'silent',
    destructive: false,
    externallyVisible: false,
    containment:
      'Rotate the secret and revoke the credential immediately. The agent already holds whatever it read until the rotation completes, and rotation stops future use, not what already happened.',
    supportsDryRun: false,
    canBeMadeReversible: false,
    reversibleApproach: '',
    auditRequirements: [
      'Log every secret read by name, never by value.',
      'Alert on any secret read outside the stated allow list, and treat any read paired with network egress as an active exfiltration signal.',
    ],
  },
  'act-on-behalf': {
    id: 'act-on-behalf',
    label: 'Act on behalf of a Customer',
    summary: "Take action inside the system using a Customer's own identity and authority.",
    targetNoun: 'Customer records',
    worstOutcome:
      "The agent takes an action the Customer never asked for, and it lands in that Customer's own account history indistinguishable from something they did themselves.",
    baselineReversibility: 'partial',
    baselineDetectability: 'delayed',
    destructive: false,
    externallyVisible: true,
    containment:
      "Revoke the impersonation grant immediately. Actions already taken under the Customer's identity stand until someone reviews and reverses them one by one.",
    supportsDryRun: true,
    canBeMadeReversible: true,
    reversibleApproach:
      "tag every impersonated action distinctly in the audit log so it can be found and reviewed separately from the Customer's own actions",
    auditRequirements: [
      "Log every impersonated action tagged separately from the Customer's own activity.",
      'Alert when an impersonated action is irreversible or financial.',
    ],
  },
};

/** Capabilities where a rate or amount ceiling is a meaningful lever. */
const RATE_RELEVANT = new Set<CapabilityId>([
  'run-shell',
  'network-egress',
  'send-email',
  'call-internal-api',
  'spend-money',
  'delete',
]);

/* ------------------------------------------------------------------ *
 * Grant configuration
 *
 * PRD workflow step 3: "It proposes the narrowest grant that still
 * works: scoping by path, by rate, by amount ceiling, by allow list,
 * by requiring confirmation, by dry run first, by making it reversible
 * instead of forbidden." scope covers path and allow list, ceiling
 * covers rate and amount, the remaining three are their own toggles.
 * ------------------------------------------------------------------ */
export interface CapabilityConfig {
  /** Free text allow list. Empty, "*", or a word like "all" reads as wildcard. */
  scope: string;
  /** Free text rate or amount ceiling. Empty means unbounded. */
  ceiling: string;
  requiresConfirmation: boolean;
  dryRunFirst: boolean;
  /** Claims a real reversibility mechanism is in place for this grant. */
  reversibleOverride: boolean;
}

export function defaultConfig(): CapabilityConfig {
  return {
    scope: '',
    ceiling: '',
    requiresConfirmation: false,
    dryRunFirst: false,
    reversibleOverride: false,
  };
}

export interface PlannerState {
  /** What the agent must accomplish. Free text. */
  mission: string;
  selected: Record<CapabilityId, boolean>;
  configs: Record<CapabilityId, CapabilityConfig>;
  scenarioId: string;
}

const WILDCARD_TOKENS = new Set(['*', 'all', 'any', 'everything', 'anything']);

/**
 * PRD acceptance criterion: "Wildcard access is clearly surfaced." An
 * unstated scope is treated the same as an explicit wildcard, because
 * a grant nobody bounded behaves exactly like one that says "*".
 */
export function isWildcardScope(scope: string): boolean {
  const trimmed = scope.trim().toLowerCase();
  return trimmed.length === 0 || WILDCARD_TOKENS.has(trimmed);
}

/* ------------------------------------------------------------------ *
 * Blast radius
 *
 * PRD workflow step 2: "Per capability the tool computes blast radius:
 * what is the worst outcome if this fires wrongly, is it reversible,
 * is it detectable, and how fast could it be stopped."
 *
 * Deterministic on purpose. The same trait and the same config always
 * produce the same severity, because a blast radius that moved with
 * anything other than stated facts would be a guess wearing a number.
 * ------------------------------------------------------------------ */
const REVERSIBILITY_SCORE: Record<Reversibility, number> = {
  reversible: 0,
  partial: 1,
  irreversible: 2,
};

const DETECTABILITY_SCORE: Record<Detectability, number> = {
  immediate: 0,
  delayed: 1,
  silent: 2,
};

/** Improving reversibility moves one step, it never jumps straight to reversible. */
const REVERSIBILITY_STEP_UP: Record<Reversibility, Reversibility> = {
  irreversible: 'partial',
  partial: 'reversible',
  reversible: 'reversible',
};

export function effectiveReversibility(
  trait: CapabilityTrait,
  config: CapabilityConfig,
): Reversibility {
  if (!config.reversibleOverride || !trait.canBeMadeReversible) {
    return trait.baselineReversibility;
  }
  return REVERSIBILITY_STEP_UP[trait.baselineReversibility];
}

export interface BlastRadius {
  reversibility: Reversibility;
  detectability: Detectability;
  destructive: boolean;
  externallyVisible: boolean;
  severity: Severity;
  /**
   * True when the raw score computed low but the capability is
   * destructive or externally visible, so the severity was forced up.
   * PRD acceptance criterion: "Destructive and externally visible
   * actions cannot be marked low risk without a warning." This is the
   * flag that warningsFor turns into that warning.
   */
  forcedFromLow: boolean;
  worstOutcome: string;
  containment: string;
}

export function computeBlastRadius(
  trait: CapabilityTrait,
  config: CapabilityConfig,
): BlastRadius {
  const reversibility = effectiveReversibility(trait, config);
  const detectability = trait.baselineDetectability;

  let score = REVERSIBILITY_SCORE[reversibility] + DETECTABILITY_SCORE[detectability];
  if (trait.destructive) score += 1;
  if (trait.externallyVisible) score += 1;

  let severity: Severity = score <= 1 ? 'low' : score <= 3 ? 'medium' : score <= 4 ? 'high' : 'critical';

  let forcedFromLow = false;
  if (severity === 'low' && (trait.destructive || trait.externallyVisible)) {
    severity = 'medium';
    forcedFromLow = true;
  }

  return {
    reversibility,
    detectability,
    destructive: trait.destructive,
    externallyVisible: trait.externallyVisible,
    severity,
    forcedFromLow,
    worstOutcome: trait.worstOutcome,
    containment: trait.containment,
  };
}

/* ------------------------------------------------------------------ *
 * Recommendations
 *
 * PRD workflow step 3, the least privilege proposal. Every entry
 * carries a reason, because a suggestion with no reason is a demand,
 * not design guidance.
 * ------------------------------------------------------------------ */
export interface Recommendation {
  action: string;
  reason: string;
}

export function recommendationsFor(
  trait: CapabilityTrait,
  config: CapabilityConfig,
  blast: BlastRadius,
): Recommendation[] {
  const recs: Recommendation[] = [];

  if (isWildcardScope(config.scope)) {
    recs.push({
      action: `Scope ${trait.label.toLowerCase()} to an explicit allow list: name the exact ${trait.targetNoun} this task needs.`,
      reason:
        'Wildcard access has no ceiling. A hijacked or malfunctioning grant with no boundary can reach anything, not only what the task required.',
    });
  }

  if (trait.supportsDryRun && !config.dryRunFirst) {
    recs.push({
      action: `Require a dry run first: list what ${trait.label.toLowerCase()} would do, and execute only after that list is reviewed.`,
      reason:
        'A preview that a human or a check can reject costs nothing when the action is correct, and it catches the case when it is not.',
    });
  }

  if (trait.canBeMadeReversible && !config.reversibleOverride && blast.reversibility !== 'reversible') {
    recs.push({
      action: `Make this reversible instead of forbidding it: ${trait.reversibleApproach}.`,
      reason:
        'A capability that can be undone is a smaller grant than the same capability with no way back, even though both are technically granted.',
    });
  }

  if (!config.requiresConfirmation && (blast.severity === 'high' || blast.severity === 'critical')) {
    recs.push({
      action: `Require confirmation before ${trait.label.toLowerCase()} fires.`,
      reason: `This capability scored ${blast.severity} blast radius. A human checkpoint is the cheapest control available before the worst case happens.`,
    });
  }

  if (RATE_RELEVANT.has(trait.id) && config.ceiling.trim() === '') {
    recs.push({
      action: `Set an explicit ceiling: a rate or amount limit on ${trait.label.toLowerCase()}, not an unbounded allowance.`,
      reason:
        'Even a correctly scoped grant is unbounded in volume until a ceiling caps how much of it can happen before anyone notices.',
    });
  }

  return recs;
}

/* ------------------------------------------------------------------ *
 * Warnings
 *
 * Distinct from recommendations: a warning names a condition that must
 * change, not one worth considering.
 * ------------------------------------------------------------------ */
export interface Warning {
  id: string;
  severity: 'warning' | 'critical';
  message: string;
}

export function warningsFor(
  trait: CapabilityTrait,
  config: CapabilityConfig,
  blast: BlastRadius,
): Warning[] {
  const warnings: Warning[] = [];

  if (blast.forcedFromLow) {
    warnings.push({
      id: `${trait.id}-forced-from-low`,
      severity: 'critical',
      message: `${trait.label} is destructive or externally visible. It cannot be treated as low risk regardless of how the raw score computes.`,
    });
  }

  if (isWildcardScope(config.scope)) {
    warnings.push({
      id: `${trait.id}-wildcard`,
      severity: 'warning',
      message: `${trait.label} has wildcard access${config.scope.trim() ? `, stated as "${config.scope.trim()}"` : ', with no scope stated'}. Nothing bounds what this grant can reach.`,
    });
  }

  // PRD is about capability design, not any one grant's paperwork, so
  // this is the property the tool enforces without exception: a
  // capability nobody would notice misfiring, and that cannot be
  // undone once it does, must never be one step away from firing.
  if (blast.reversibility === 'irreversible' && blast.detectability === 'silent' && !config.requiresConfirmation) {
    warnings.push({
      id: `${trait.id}-mandatory-confirmation`,
      severity: 'critical',
      message: `${trait.label} cannot be undone and would not be noticed on its own. It must require confirmation before it fires.`,
    });
  }

  return warnings;
}

/* ------------------------------------------------------------------ *
 * Dangerous combinations
 *
 * PRD workflow step 4: "It flags dangerous combinations explicitly.
 * ... These compound risks are the real finding and the tool must name
 * them." Three named combinations, each testable as present when both
 * parts are present and absent when only one is.
 * ------------------------------------------------------------------ */
export interface ComboFinding {
  id: string;
  name: string;
  message: string;
  involves: CapabilityId[];
}

interface ComboContext {
  selected: Set<CapabilityId>;
  configs: Record<CapabilityId, CapabilityConfig>;
  blast: Partial<Record<CapabilityId, BlastRadius>>;
}

interface ComboRule {
  id: string;
  name: string;
  message: string;
  involves: CapabilityId[];
  test: (ctx: ComboContext) => boolean;
}

const COMBO_RULES: ComboRule[] = [
  {
    id: 'exfiltration',
    name: 'Exfiltration path',
    involves: ['access-secrets', 'network-egress'],
    message:
      'Access to secrets plus network egress lets the agent read a credential and send it anywhere the network reaches. Treat this as one exfiltration risk, not two separate line items.',
    test: (ctx) => ctx.selected.has('access-secrets') && ctx.selected.has('network-egress'),
  },
  {
    id: 'arbitrary-execution',
    name: 'Arbitrary code execution',
    involves: ['run-shell', 'network-egress'],
    message:
      'Shell access plus network egress means the agent can fetch and run anything the network can reach, not only the commands you had in mind. Treat this as arbitrary code execution.',
    test: (ctx) => ctx.selected.has('run-shell') && ctx.selected.has('network-egress'),
  },
  {
    id: 'data-loss',
    name: 'Unconfirmed irreversible write',
    involves: ['write-files', 'delete'],
    message:
      'A write or delete grant with no confirmation step and no reversibility mechanism means one wrong action destroys data with nothing standing in the way and nothing to undo it.',
    test: (ctx) =>
      (['write-files', 'delete'] as CapabilityId[]).some((id) => {
        const b = ctx.blast[id];
        return (
          ctx.selected.has(id) &&
          !ctx.configs[id].requiresConfirmation &&
          b?.reversibility === 'irreversible'
        );
      }),
  },
];

export function findCombos(
  selected: Set<CapabilityId>,
  configs: Record<CapabilityId, CapabilityConfig>,
  blast: Partial<Record<CapabilityId, BlastRadius>>,
): ComboFinding[] {
  const ctx: ComboContext = { selected, configs, blast };
  return COMBO_RULES.filter((rule) => rule.test(ctx)).map((rule) => ({
    id: rule.id,
    name: rule.name,
    message: rule.message,
    involves: rule.involves,
  }));
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */
export interface CapabilityFinding {
  id: CapabilityId;
  label: string;
  summary: string;
  config: CapabilityConfig;
  blast: BlastRadius;
  wildcard: boolean;
  recommendations: Recommendation[];
  warnings: Warning[];
  /** What remains possible even after every recommendation is applied. */
  whatRemainsPossible: string;
}

export interface AuditEntry {
  id: CapabilityId;
  label: string;
  log: string[];
}

export interface PlannerAnalysis {
  mission: string;
  findings: CapabilityFinding[];
  combos: ComboFinding[];
  auditLog: AuditEntry[];
  severityCounts: Record<Severity, number>;
}

export function analyze(state: PlannerState): PlannerAnalysis {
  const selectedIds = CAPABILITY_IDS.filter((id) => state.selected[id]);
  const selectedSet = new Set(selectedIds);

  const blastMap: Partial<Record<CapabilityId, BlastRadius>> = {};
  for (const id of selectedIds) {
    blastMap[id] = computeBlastRadius(CAPABILITIES[id], state.configs[id]);
  }

  const findings: CapabilityFinding[] = selectedIds.map((id) => {
    const trait = CAPABILITIES[id];
    const config = state.configs[id];
    const blast = blastMap[id]!;
    return {
      id,
      label: trait.label,
      summary: trait.summary,
      config,
      blast,
      wildcard: isWildcardScope(config.scope),
      recommendations: recommendationsFor(trait, config, blast),
      warnings: warningsFor(trait, config, blast),
      whatRemainsPossible: `Even scoped and confirmed, this grant still allows: ${trait.worstOutcome}`,
    };
  });

  const combos = findCombos(selectedSet, state.configs, blastMap);

  const auditLog: AuditEntry[] = selectedIds.map((id) => ({
    id,
    label: CAPABILITIES[id].label,
    log: CAPABILITIES[id].auditRequirements,
  }));

  const severityCounts: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) severityCounts[f.blast.severity] += 1;

  return { mission: state.mission, findings, combos, auditLog, severityCounts };
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * PRD acceptance criterion: "Includes a realistic email and calendar
 * agent sample." That one ships plus two more, each chosen to teach a
 * different lesson: a partially scoped first draft, a worst case that
 * trips all three named combinations, and a grant that is actually
 * scoped, to show that scoping narrows exposure, it does not remove it.
 * ------------------------------------------------------------------ */
export interface Sample {
  id: string;
  name: string;
  teaches: string;
  mission: string;
  selected: CapabilityId[];
  configs: Partial<Record<CapabilityId, Partial<CapabilityConfig>>>;
}

export const SAMPLES: Sample[] = [
  {
    id: 'email-calendar-assistant',
    name: 'Email and calendar assistant',
    teaches:
      'A first draft grant with a wildcard file scope and no send ceiling. Fixing the wildcard and adding a ceiling is the actual work of least privilege here, not forbidding the agent from doing its job.',
    mission:
      "Read the user's saved draft replies, send email to contacts already in their address book, and create or move calendar events through the internal calendar service.",
    selected: ['read-files', 'send-email', 'call-internal-api', 'access-secrets'],
    configs: {
      'read-files': { scope: '*' },
      'send-email': {
        scope: "contacts already saved in the user's address book",
        dryRunFirst: true,
      },
      'call-internal-api': {
        scope: 'the calendar service, read and create event endpoints only',
        reversibleOverride: true,
      },
      'access-secrets': { scope: 'the mailbox OAuth token only' },
    },
  },
  {
    id: 'cleanup-agent-worst-case',
    name: 'Autonomous cleanup agent',
    teaches:
      'All three named dangerous combinations at once: secrets plus egress is exfiltration, shell plus egress is arbitrary code execution, and an unconfirmed irreversible delete is data loss. Each capability alone might look manageable. Granted together with no scoping, they compound.',
    mission:
      'Find files that look unused, free disk space by deleting them, and notify the team by whatever channel is fastest.',
    selected: ['delete', 'run-shell', 'network-egress', 'access-secrets'],
    configs: {
      delete: { scope: '*' },
      'run-shell': { scope: '*' },
      'network-egress': { scope: '*' },
      'access-secrets': { scope: '*' },
    },
  },
  {
    id: 'support-refund-agent',
    name: 'Support refund agent',
    teaches:
      'A grant that is actually scoped: named endpoints, a stated ceiling, and confirmation on the parts that are irreversible. The matrix still states plainly what remains possible. Good scoping narrows exposure. It does not remove it.',
    mission:
      "Review a support ticket, and if it qualifies, issue a refund to the ticket's linked Customer account through the billing service.",
    selected: ['act-on-behalf', 'call-internal-api', 'spend-money'],
    configs: {
      'act-on-behalf': {
        scope: "the ticket's linked Customer account only",
        requiresConfirmation: true,
        reversibleOverride: true,
      },
      'call-internal-api': {
        scope: 'the billing service refund endpoint only',
        ceiling: '10 calls per hour',
        reversibleOverride: true,
      },
      'spend-money': {
        scope: 'refund issuance on qualifying tickets only',
        ceiling: '$50 per transaction, $200 per day',
        requiresConfirmation: true,
        dryRunFirst: true,
        reversibleOverride: true,
      },
    },
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

function buildState(mission: string, selected: CapabilityId[], configs: Sample['configs']): PlannerState {
  const selectedMap = {} as Record<CapabilityId, boolean>;
  const configMap = {} as Record<CapabilityId, CapabilityConfig>;
  for (const id of CAPABILITY_IDS) {
    selectedMap[id] = selected.includes(id);
    configMap[id] = { ...defaultConfig(), ...(configs[id] ?? {}) };
  }
  return { mission, selected: selectedMap, configs: configMap, scenarioId: '' };
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */
export function emptyState(): PlannerState {
  const state = buildState('', [], {});
  state.scenarioId = SAMPLES[0].id;
  return state;
}

export function sampleState(id: string = SAMPLES[0].id): PlannerState {
  const sample = getSample(id) ?? SAMPLES[0];
  const state = buildState(sample.mission, sample.selected, sample.configs);
  state.scenarioId = sample.id;
  return state;
}

export function reset(): PlannerState {
  return emptyState();
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: PlannerState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const anySelected = CAPABILITY_IDS.some((id) => state.selected[id]);
  if (!anySelected) {
    issues.push({
      field: 'capabilities',
      message: 'Select at least one capability, or load a sample.',
      severity: 'error',
    });
    return issues;
  }
  if (!state.mission.trim()) {
    issues.push({
      field: 'mission',
      message:
        'Nothing states what the agent must accomplish. Blast radius is easier to judge against a stated goal.',
      severity: 'warning',
    });
  }
  return issues;
}

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: PlannerState, format: ExportFormat): string {
  const analysis = analyze(state);

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, Permission Planner',
        note:
          'Design guidance, not legal or security certification. Least privilege is a direction, not a finished state, and no row here is a guarantee.',
        mission: analysis.mission,
        findings: analysis.findings,
        dangerousCombinations: analysis.combos,
        auditRequirements: analysis.auditLog,
      },
      null,
      2,
    );
  }

  const matrixRows = analysis.findings.map((f) => {
    const scope = f.wildcard ? 'WILDCARD' : f.config.scope.trim() || '(unscoped)';
    return `| ${f.label} | ${SEVERITY_LABELS[f.blast.severity]} | ${f.blast.reversibility} | ${f.blast.detectability} | ${scope} | ${f.config.requiresConfirmation ? 'yes' : 'no'} |`;
  });

  const comboLines = analysis.combos.length
    ? analysis.combos.map((c, i) => `${i + 1}. ${c.name}. ${c.message}`).join('\n')
    : 'None of the three named compound risks matched this configuration. That states what did not match, not that the configuration is free of risk.';

  const auditLines = analysis.auditLog.length
    ? analysis.auditLog
        .map((a) => `### ${a.label}\n\n${a.log.map((line, i) => `${i + 1}. ${line}`).join('\n')}`)
        .join('\n\n')
    : 'No capability selected.';

  return [
    '# Permission Planner report',
    '',
    'Design guidance, not legal or security certification.',
    '',
    analysis.mission ? `Mission: ${analysis.mission}` : 'No mission stated.',
    '',
    '## Permission matrix',
    '',
    '| Capability | Severity | Reversibility | Detectability | Scope | Confirmation required |',
    '| --- | --- | --- | --- | --- | --- |',
    ...matrixRows,
    '',
    '## What remains possible',
    '',
    ...analysis.findings.map((f, i) => `${i + 1}. ${f.label}. ${f.whatRemainsPossible}`),
    '',
    '## Dangerous combinations',
    '',
    comboLines,
    '',
    '## Audit and alerting',
    '',
    auditLines,
    '',
  ].join('\n');
}

export function filename(_state: PlannerState, _format: ExportFormat): string {
  return 'permission-planner-report';
}
