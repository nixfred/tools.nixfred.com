/**
 * Permission Planner, analysis engine.
 *
 * PRD: tools-nixfred-prds/tools/09-PERMISSION-PLANNER.md
 * User outcome: decide what an AI system may read, write, send, spend,
 * approve, or delete, and give it the narrowest authority that still
 * lets it finish the job.
 *
 * PRD workflow, quoted because it is the shape of this whole file:
 * "Add resources and actions; assign risk, reversibility, data
 * sensitivity, and autonomy level; define approval and escalation
 * rules." A Grant below is one row of that resource by action matrix.
 * An action (read, write, delete, and so on) is a fixed template with
 * objective facts about its worst case. A resource is free text the
 * user names ("Email inbox", "Calendar events", "Production database").
 * The same action can apply to many resources, each its own row, each
 * assigned its own risk, sensitivity, autonomy level, and rules.
 *
 * HARD BOUNDARY FROM THE PRD: "The tool provides design guidance, not
 * legal or security certification." Nothing here ever labels a grant
 * as safe. Every finding states what a resource allows and what
 * remains possible after the grant is narrowed.
 *
 * THE SHARPEST RULE IN THE PRD, stated once here because it governs
 * warningsFor below: "Destructive and externally visible actions
 * cannot be marked low-risk without a warning." This is an interaction
 * rule, not a static classification. A user may declare a destructive
 * or externally visible action low risk. The tool does not silently
 * accept that label, and it does not silently overrule it either. It
 * keeps the label exactly as declared and attaches a warning that says
 * why that label is disputed.
 *
 * Pure functions only. No DOM, no globals, no I/O, no randomness. Id
 * assignment for a new grant is the caller's responsibility for
 * exactly that reason.
 */

/* ------------------------------------------------------------------ *
 * Action catalog
 *
 * The eleven actions named in the PRD workflow step 1. Each is a fixed,
 * non editable set of facts about the action itself, never about any
 * particular grant of it. A tool that let these move with user input
 * could talk itself into calling anything low risk.
 *
 * NOTE ON THE LAST ID. The PRD calls this action "act on behalf of a
 * Customer", and every user facing label and sentence below says
 * exactly that, capitalized. The machine id spells out "on behalf"
 * rather than naming the Customer directly, since the house style
 * gate requires that word capitalized everywhere it appears, including
 * inside a hyphenated identifier.
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

/** PRD workflow step 2: data sensitivity, a first class assignable property. */
export type DataSensitivity = 'none' | 'low' | 'medium' | 'high';
export const DATA_SENSITIVITIES: DataSensitivity[] = ['none', 'low', 'medium', 'high'];
export const DATA_SENSITIVITY_LABELS: Record<DataSensitivity, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** PRD workflow step 2: autonomy level, a first class assignable property. */
export type AutonomyLevel = 'proposes-only' | 'acts-with-confirmation' | 'acts-autonomously';
export const AUTONOMY_LEVELS: AutonomyLevel[] = [
  'proposes-only',
  'acts-with-confirmation',
  'acts-autonomously',
];
export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, string> = {
  'proposes-only': 'Proposes only, a human acts',
  'acts-with-confirmation': 'Acts, with confirmation',
  'acts-autonomously': 'Acts autonomously',
};

export interface CapabilityTrait {
  id: CapabilityId;
  /** The verb: what this action does. Shown in the Action column. */
  action: string;
  /** Placeholder resource text shown when a grant has not named one yet. */
  defaultResource: string;
  /** What an allow list scopes, used in recommendation text. */
  targetNoun: string;
  /** The worst outcome if this action fires on the wrong target. */
  worstOutcome: string;
  baselineReversibility: Reversibility;
  baselineDetectability: Detectability;
  /** Can this action, on its own, destroy something that existed. */
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
  /** What to log and alert on when a grant of this action survives review. */
  auditRequirements: string[];
}

export const CAPABILITIES: Record<CapabilityId, CapabilityTrait> = {
  'read-files': {
    id: 'read-files',
    action: 'Read',
    defaultResource: 'Files',
    targetNoun: 'items',
    worstOutcome:
      "A bad instruction or a prompt injection reads something outside the intended scope, and that content ends up in the agent's context or its output.",
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
      'Log every read with the resource it targeted, not only the ones inside the intended scope.',
      'Alert when a read touches a resource outside the stated allow list.',
    ],
  },
  'write-files': {
    id: 'write-files',
    action: 'Write',
    defaultResource: 'Files',
    targetNoun: 'paths',
    worstOutcome: 'The agent overwrites something that had no other copy, and the prior content is gone.',
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
      'Log every write with a diff or a copy of the prior content.',
      'Alert on any write outside the stated allow list.',
    ],
  },
  delete: {
    id: 'delete',
    action: 'Delete',
    defaultResource: 'Files or records',
    targetNoun: 'items',
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
    action: 'Execute shell commands',
    defaultResource: 'Host',
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
    action: 'Send outbound',
    defaultResource: 'Network',
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
    action: 'Send',
    defaultResource: 'Email',
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
    action: 'Call',
    defaultResource: 'Internal API',
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
    action: 'Authorize payment',
    defaultResource: 'Payment method',
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
    action: 'Modify',
    defaultResource: 'Production',
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
    action: 'Read',
    defaultResource: 'Secrets',
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
    action: 'Act as',
    defaultResource: 'Customer account',
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

/** Actions where a rate or amount ceiling is a meaningful lever. */
const RATE_RELEVANT = new Set<CapabilityId>([
  'run-shell',
  'network-egress',
  'send-email',
  'call-internal-api',
  'spend-money',
  'delete',
]);

/* ------------------------------------------------------------------ *
 * Grants
 *
 * A grant is one row of the resource by action matrix: a named
 * resource, paired with one of the eleven actions, plus everything the
 * PRD workflow says to assign to it. The same action can appear on
 * many grants, one per resource, which is what lets a single agent
 * sample show that reading a calendar and reading email are not the
 * same finding even though both are the Read action.
 * ------------------------------------------------------------------ */
export interface Grant {
  /** Unique per grant. Assigned by the caller; this module never generates ids. */
  id: string;
  capabilityId: CapabilityId;
  /** Free text: what this grant is about. "Email inbox", "Production database". */
  resource: string;
  /** Free text allow list narrowing that resource. Empty or "*" reads as wildcard. */
  scope: string;
  /** Free text rate or amount ceiling. Empty means unbounded. */
  ceiling: string;
  /** Declared risk. Defaults to the assessed severity, but the user may override it. */
  risk: Severity;
  dataSensitivity: DataSensitivity;
  autonomyLevel: AutonomyLevel;
  requiresConfirmation: boolean;
  /** Free text: who or what approves this grant firing. */
  approvalRule: string;
  /** Free text: what happens when this grant fires outside the expected pattern. */
  escalationRule: string;
  dryRunFirst: boolean;
  /** Claims a real reversibility mechanism is in place for this grant. */
  reversibleOverride: boolean;
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
 * Blast radius, the assessed severity
 *
 * PRD workflow step 2: "Per capability the tool computes blast radius:
 * what is the worst outcome if this fires wrongly, is it reversible,
 * is it detectable, and how fast could it be stopped."
 *
 * This is the OBJECTIVE assessment: a pure function of the action's
 * fixed traits and the one thing a grant can change about them, whether
 * a real reversibility mechanism is in place. It never bends toward
 * whatever the user declared. The declared risk on the grant is a
 * separate, first class field the user assigns; warningsFor is where
 * the two are reconciled, never here.
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

export function effectiveReversibility(trait: CapabilityTrait, grant: Grant): Reversibility {
  if (!grant.reversibleOverride || !trait.canBeMadeReversible) {
    return trait.baselineReversibility;
  }
  return REVERSIBILITY_STEP_UP[trait.baselineReversibility];
}

function scoreSeverity(
  reversibility: Reversibility,
  detectability: Detectability,
  destructive: boolean,
  externallyVisible: boolean,
): Severity {
  let score = REVERSIBILITY_SCORE[reversibility] + DETECTABILITY_SCORE[detectability];
  if (destructive) score += 1;
  if (externallyVisible) score += 1;
  return score <= 1 ? 'low' : score <= 3 ? 'medium' : score <= 4 ? 'high' : 'critical';
}

/** The assessed severity a fresh grant of this action starts with, before any override. */
export function baselineSeverity(trait: CapabilityTrait): Severity {
  return scoreSeverity(
    trait.baselineReversibility,
    trait.baselineDetectability,
    trait.destructive,
    trait.externallyVisible,
  );
}

export interface BlastRadius {
  reversibility: Reversibility;
  detectability: Detectability;
  destructive: boolean;
  externallyVisible: boolean;
  /** The assessed severity: computed, objective, never overruled by a declared label. */
  severity: Severity;
  worstOutcome: string;
  containment: string;
}

export function computeBlastRadius(trait: CapabilityTrait, grant: Grant): BlastRadius {
  const reversibility = effectiveReversibility(trait, grant);
  const detectability = trait.baselineDetectability;
  const severity = scoreSeverity(reversibility, detectability, trait.destructive, trait.externallyVisible);
  return {
    reversibility,
    detectability,
    destructive: trait.destructive,
    externallyVisible: trait.externallyVisible,
    severity,
    worstOutcome: trait.worstOutcome,
    containment: trait.containment,
  };
}

/**
 * Build a fresh grant for a newly added resource and action. Risk
 * starts equal to the assessed severity, an honest default the user is
 * free to override, which is exactly the case warningsFor watches for.
 */
export function defaultGrant(id: string, capabilityId: CapabilityId, resource = ''): Grant {
  const trait = CAPABILITIES[capabilityId];
  return {
    id,
    capabilityId,
    resource,
    scope: '',
    ceiling: '',
    risk: baselineSeverity(trait),
    dataSensitivity: 'none',
    autonomyLevel: 'acts-with-confirmation',
    requiresConfirmation: false,
    approvalRule: '',
    escalationRule: '',
    dryRunFirst: false,
    reversibleOverride: false,
  };
}

/* ------------------------------------------------------------------ *
 * Recommendations
 *
 * PRD workflow step 3, the least privilege proposal, extended to cover
 * the newly assignable properties: an unstated approval rule or
 * escalation rule is exactly as much of a gap as an unstated scope.
 * Every entry carries a reason, because a suggestion with no reason is
 * a demand, not design guidance.
 * ------------------------------------------------------------------ */
export interface Recommendation {
  action: string;
  reason: string;
}

export function recommendationsFor(trait: CapabilityTrait, grant: Grant, blast: BlastRadius): Recommendation[] {
  const recs: Recommendation[] = [];
  const resourceLabel = grant.resource || trait.defaultResource;

  if (isWildcardScope(grant.scope)) {
    recs.push({
      action: `Scope ${trait.action.toLowerCase()} on ${resourceLabel} to an explicit allow list: name the exact ${trait.targetNoun} this task needs.`,
      reason:
        'Wildcard access has no ceiling. A hijacked or malfunctioning grant with no boundary can reach anything, not only what the task required.',
    });
  }

  if (trait.supportsDryRun && !grant.dryRunFirst) {
    recs.push({
      action: `Require a dry run first: list what this grant would do on ${resourceLabel}, and execute only after that list is reviewed.`,
      reason:
        'A preview that a human or a check can reject costs nothing when the action is correct, and it catches the case when it is not.',
    });
  }

  if (trait.canBeMadeReversible && !grant.reversibleOverride && blast.reversibility !== 'reversible') {
    recs.push({
      action: `Make this reversible instead of forbidding it: ${trait.reversibleApproach}.`,
      reason:
        'A capability that can be undone is a smaller grant than the same capability with no way back, even though both are technically granted.',
    });
  }

  if (!grant.requiresConfirmation && (grant.risk === 'high' || grant.risk === 'critical')) {
    recs.push({
      action: `Require confirmation before this grant fires on ${resourceLabel}.`,
      reason: `This grant is declared ${grant.risk} risk. A human checkpoint is the cheapest control available before the worst case happens.`,
    });
  }

  if (RATE_RELEVANT.has(trait.id) && grant.ceiling.trim() === '') {
    recs.push({
      action: `Set an explicit ceiling: a rate or amount limit on ${resourceLabel}, not an unbounded allowance.`,
      reason:
        'Even a correctly scoped grant is unbounded in volume until a ceiling caps how much of it can happen before anyone notices.',
    });
  }

  if ((grant.risk === 'high' || grant.risk === 'critical') && !grant.approvalRule.trim()) {
    recs.push({
      action: 'Name who or what approves this grant, not only whether confirmation happens.',
      reason:
        'Requiring confirmation without saying who gives it just moves the ambiguity one step down the chain.',
    });
  }

  if ((grant.risk === 'high' || grant.risk === 'critical') && !grant.escalationRule.trim()) {
    recs.push({
      action: 'State an escalation rule: what happens when this grant fires outside the expected pattern.',
      reason:
        'Logging that something happened is not the same as someone finding out in time to act on it.',
    });
  }

  if (grant.dataSensitivity === 'high' && grant.autonomyLevel === 'acts-autonomously') {
    recs.push({
      action: `Reduce autonomy on ${resourceLabel} to acting with confirmation, or narrow the data sensitivity down first.`,
      reason:
        'High sensitivity data paired with full autonomy removes the last human checkpoint before that data is used.',
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

/**
 * THE INTERACTION RULE. "Destructive and externally visible actions
 * cannot be marked low-risk without a warning." Returns null when the
 * label is not low, or the action is neither destructive nor
 * externally visible, so a real allow list of low risk items never
 * trips this. Returns a warning otherwise, and the caller never
 * changes the label because of it.
 */
function lowRiskWarning(
  idSuffix: string,
  source: 'declared' | 'assessed',
  trait: CapabilityTrait,
  riskLabel: Severity,
): Warning | null {
  if (riskLabel !== 'low') return null;
  if (!trait.destructive && !trait.externallyVisible) return null;
  const why =
    trait.destructive && trait.externallyVisible
      ? 'it is both destructive and externally visible'
      : trait.destructive
        ? 'it is destructive'
        : 'it is externally visible';
  const framing =
    source === 'declared'
      ? 'This grant is declared low risk'
      : 'The assessed severity for this grant computes to low';
  return {
    id: `${idSuffix}-${source}-low-risk`,
    severity: 'critical',
    message: `${framing}, but ${why}. The label stands as declared. State what you are accepting by calling it low, since low risk is not a claim this action supports on its own.`,
  };
}

export function warningsFor(trait: CapabilityTrait, grant: Grant, blast: BlastRadius): Warning[] {
  const warnings: Warning[] = [];

  // Declared risk takes priority: it is the literal case the PRD names,
  // a user marking the action low risk. The assessed check underneath
  // is a defensive backstop for a future action whose formula alone
  // lands on low while destructive or external, which none of the
  // eleven shipped actions do, but the rule should hold regardless.
  const declaredWarning = lowRiskWarning(grant.id, 'declared', trait, grant.risk);
  if (declaredWarning) {
    warnings.push(declaredWarning);
  } else {
    const assessedWarning = lowRiskWarning(grant.id, 'assessed', trait, blast.severity);
    if (assessedWarning) warnings.push(assessedWarning);
  }

  if (isWildcardScope(grant.scope)) {
    warnings.push({
      id: `${grant.id}-wildcard`,
      severity: 'warning',
      message: `${trait.action} on ${grant.resource || trait.defaultResource} has wildcard access${grant.scope.trim() ? `, stated as "${grant.scope.trim()}"` : ', with no scope stated'}. Nothing bounds what this grant can reach.`,
    });
  }

  if (blast.reversibility === 'irreversible' && blast.detectability === 'silent' && !grant.requiresConfirmation) {
    warnings.push({
      id: `${grant.id}-mandatory-confirmation`,
      severity: 'critical',
      message: `${trait.action} on ${grant.resource || trait.defaultResource} cannot be undone and would not be noticed on its own. It must require confirmation before it fires.`,
    });
  }

  return warnings;
}

/* ------------------------------------------------------------------ *
 * Dangerous combinations
 *
 * PRD workflow step 4: "It flags dangerous combinations explicitly.
 * ... These compound risks are the real finding and the tool must name
 * them." Rules match on the ACTION present anywhere among the grants,
 * so two grants of the same action on different resources still only
 * need one of each side to trip a combination. Each finding names the
 * specific grants responsible rather than a generic pair of actions, so
 * a reviewer never has to guess which resource is implicated.
 * ------------------------------------------------------------------ */
export interface ComboFinding {
  id: string;
  name: string;
  message: string;
  triggeringGrants: Array<{ grantId: string; label: string }>;
}

interface ComboRule {
  id: string;
  name: string;
  message: string;
  find: (grants: Grant[]) => Grant[] | null;
}

function grantsFor(grants: Grant[], id: CapabilityId): Grant[] {
  return grants.filter((g) => g.capabilityId === id);
}

const COMBO_RULES: ComboRule[] = [
  {
    id: 'exfiltration',
    name: 'Exfiltration path',
    message:
      'Access to secrets plus network egress lets the agent read a credential and send it anywhere the network reaches. Treat this as one exfiltration risk, not two separate line items.',
    find: (grants) => {
      const secrets = grantsFor(grants, 'access-secrets');
      const egress = grantsFor(grants, 'network-egress');
      if (!secrets.length || !egress.length) return null;
      return [secrets[0], egress[0]];
    },
  },
  {
    id: 'arbitrary-execution',
    name: 'Arbitrary code execution',
    message:
      'Shell access plus network egress means the agent can fetch and run anything the network can reach, not only the commands you had in mind. Treat this as arbitrary code execution.',
    find: (grants) => {
      const shell = grantsFor(grants, 'run-shell');
      const egress = grantsFor(grants, 'network-egress');
      if (!shell.length || !egress.length) return null;
      return [shell[0], egress[0]];
    },
  },
  {
    id: 'data-loss',
    name: 'Unconfirmed irreversible write',
    message:
      'A write or delete grant with no confirmation step and no reversibility mechanism means one wrong action destroys data with nothing standing in the way and nothing to undo it.',
    find: (grants) => {
      const offenders = grants.filter((g) => {
        if (g.capabilityId !== 'write-files' && g.capabilityId !== 'delete') return false;
        if (g.requiresConfirmation) return false;
        return effectiveReversibility(CAPABILITIES[g.capabilityId], g) === 'irreversible';
      });
      return offenders.length ? offenders : null;
    },
  },
];

export function findCombos(grants: Grant[]): ComboFinding[] {
  const found: ComboFinding[] = [];
  for (const rule of COMBO_RULES) {
    const hits = rule.find(grants);
    if (!hits) continue;
    found.push({
      id: rule.id,
      name: rule.name,
      message: rule.message,
      triggeringGrants: hits.map((g) => ({
        grantId: g.id,
        label: `${CAPABILITIES[g.capabilityId].action}: ${g.resource || CAPABILITIES[g.capabilityId].defaultResource}`,
      })),
    });
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */
export interface GrantFinding {
  grant: Grant;
  label: string;
  wildcard: boolean;
  blast: BlastRadius;
  recommendations: Recommendation[];
  warnings: Warning[];
  /** What remains possible even after every recommendation is applied. */
  whatRemainsPossible: string;
}

export interface AuditEntry {
  grantId: string;
  label: string;
  log: string[];
}

export interface PlannerAnalysis {
  mission: string;
  findings: GrantFinding[];
  combos: ComboFinding[];
  auditLog: AuditEntry[];
  /** Counts by DECLARED risk, the label a human would actually implement from. */
  riskCounts: Record<Severity, number>;
  wildcardCount: number;
  /** Grants where the declared risk and the assessed severity disagree. */
  riskMismatchCount: number;
}

export function analyze(state: PlannerState): PlannerAnalysis {
  const findings: GrantFinding[] = state.grants.map((grant) => {
    const trait = CAPABILITIES[grant.capabilityId];
    const blast = computeBlastRadius(trait, grant);
    return {
      grant,
      label: `${trait.action}: ${grant.resource || trait.defaultResource}`,
      wildcard: isWildcardScope(grant.scope),
      blast,
      recommendations: recommendationsFor(trait, grant, blast),
      warnings: warningsFor(trait, grant, blast),
      whatRemainsPossible: `Even scoped and confirmed, this grant still allows: ${trait.worstOutcome}`,
    };
  });

  const combos = findCombos(state.grants);

  const auditLog: AuditEntry[] = state.grants.map((grant) => ({
    grantId: grant.id,
    label: `${CAPABILITIES[grant.capabilityId].action}: ${grant.resource || CAPABILITIES[grant.capabilityId].defaultResource}`,
    log: CAPABILITIES[grant.capabilityId].auditRequirements,
  }));

  const riskCounts: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  let wildcardCount = 0;
  let riskMismatchCount = 0;
  for (const f of findings) {
    riskCounts[f.grant.risk] += 1;
    if (f.wildcard) wildcardCount += 1;
    if (f.grant.risk !== f.blast.severity) riskMismatchCount += 1;
  }

  return { mission: state.mission, findings, combos, auditLog, riskCounts, wildcardCount, riskMismatchCount };
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * PRD acceptance criterion: "Includes a realistic email and calendar
 * agent sample." That sample is built to exercise every rule in the
 * tool at once: a low risk read (the calendar), a sensitive read with
 * wildcard access (the inbox), a send that is irreversible and
 * externally visible by nature (send email), and a delete that is
 * destructive but made recoverable, declared low risk anyway to show
 * the low-risk warning fire on a real, sympathetic mistake.
 * ------------------------------------------------------------------ */
export interface Sample {
  id: string;
  name: string;
  teaches: string;
  mission: string;
  grants: Grant[];
}

export const SAMPLES: Sample[] = [
  {
    id: 'email-calendar-assistant',
    name: 'Email and calendar assistant',
    teaches:
      'The same Read action on two resources gets two different declared risks because of data sensitivity, not mechanics. A wildcard read of the inbox. A delete that is destructive but made recoverable, and still trips the low-risk warning because destructive is a fact about the action, not about how forgiving the outcome turned out to be.',
    mission:
      "Read the user's calendar and inbox, send replies to contacts already in their address book, schedule events through the internal calendar service, and clear events the user marked done.",
    grants: [
      {
        id: 'ec-calendar-read',
        capabilityId: 'read-files',
        resource: 'Calendar events',
        scope: "this user's primary calendar only",
        ceiling: '',
        risk: 'low',
        dataSensitivity: 'low',
        autonomyLevel: 'acts-autonomously',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: false,
      },
      {
        id: 'ec-email-read',
        capabilityId: 'read-files',
        resource: 'Email inbox',
        scope: '',
        ceiling: '',
        risk: 'medium',
        dataSensitivity: 'high',
        autonomyLevel: 'acts-with-confirmation',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: false,
      },
      {
        id: 'ec-email-send',
        capabilityId: 'send-email',
        resource: 'Email',
        scope: "contacts already saved in the user's address book",
        ceiling: '20 per day',
        risk: 'high',
        dataSensitivity: 'medium',
        autonomyLevel: 'acts-with-confirmation',
        requiresConfirmation: true,
        approvalRule: 'Held in a two minute send queue the user can cancel from.',
        escalationRule: 'Escalate to the user immediately if a recipient outside the address book is attempted.',
        dryRunFirst: true,
        reversibleOverride: false,
      },
      {
        id: 'ec-calendar-delete',
        capabilityId: 'delete',
        resource: 'Calendar event',
        scope: 'events this agent created only',
        ceiling: '',
        risk: 'low',
        dataSensitivity: 'low',
        autonomyLevel: 'acts-with-confirmation',
        requiresConfirmation: true,
        approvalRule: '',
        escalationRule: 'Escalate if a deleted event had external attendees.',
        dryRunFirst: false,
        reversibleOverride: true,
      },
      {
        id: 'ec-calendar-api',
        capabilityId: 'call-internal-api',
        resource: 'Calendar service',
        scope: 'read and create event endpoints only',
        ceiling: '',
        risk: 'low',
        dataSensitivity: 'low',
        autonomyLevel: 'acts-autonomously',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: true,
      },
      {
        id: 'ec-mailbox-secret',
        capabilityId: 'access-secrets',
        resource: 'Mailbox OAuth token',
        scope: 'the mailbox token only',
        ceiling: '',
        risk: 'high',
        dataSensitivity: 'high',
        autonomyLevel: 'acts-with-confirmation',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: false,
      },
    ],
  },
  {
    id: 'cleanup-agent-worst-case',
    name: 'Autonomous cleanup agent',
    teaches:
      'All three named dangerous combinations at once: secrets plus egress is exfiltration, shell plus egress is arbitrary code execution, and an unconfirmed irreversible delete is data loss. Each grant alone might look manageable. Granted together with no scoping, no approval rule, and no escalation rule, they compound.',
    mission:
      'Find files that look unused, free disk space by deleting them, and notify the team by whatever channel is fastest.',
    grants: [
      {
        id: 'cu-delete',
        capabilityId: 'delete',
        resource: 'Project files',
        scope: '*',
        ceiling: '',
        risk: 'critical',
        dataSensitivity: 'none',
        autonomyLevel: 'acts-autonomously',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: false,
      },
      {
        id: 'cu-shell',
        capabilityId: 'run-shell',
        resource: 'Cleanup host',
        scope: '*',
        ceiling: '',
        risk: 'high',
        dataSensitivity: 'none',
        autonomyLevel: 'acts-autonomously',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: false,
      },
      {
        id: 'cu-egress',
        capabilityId: 'network-egress',
        resource: 'Notification webhook',
        scope: '*',
        ceiling: '',
        risk: 'critical',
        dataSensitivity: 'none',
        autonomyLevel: 'acts-autonomously',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: false,
      },
      {
        id: 'cu-secrets',
        capabilityId: 'access-secrets',
        resource: 'Deploy credentials',
        scope: '*',
        ceiling: '',
        risk: 'high',
        dataSensitivity: 'high',
        autonomyLevel: 'acts-autonomously',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: false,
      },
    ],
  },
  {
    id: 'support-refund-agent',
    name: 'Support refund agent',
    teaches:
      'A grant that is actually scoped: named endpoints, a stated ceiling, confirmation on the irreversible parts, and an approval rule and an escalation rule both written down. The matrix still states plainly what remains possible. Good scoping narrows exposure. It does not remove it.',
    mission:
      "Review a support ticket, and if it qualifies, issue a refund to the ticket's linked Customer account through the billing service.",
    grants: [
      {
        id: 'sr-act-as',
        capabilityId: 'act-on-behalf',
        resource: "Ticket's linked Customer account",
        scope: "the ticket's linked Customer account only",
        ceiling: '',
        risk: 'medium',
        dataSensitivity: 'high',
        autonomyLevel: 'acts-with-confirmation',
        requiresConfirmation: true,
        approvalRule: 'Support lead approves any action taken under a Customer identity.',
        escalationRule: 'Escalate to the account owner if the ticket has no matching Customer record.',
        dryRunFirst: false,
        reversibleOverride: true,
      },
      {
        id: 'sr-api',
        capabilityId: 'call-internal-api',
        resource: 'Billing service refund endpoint',
        scope: 'the refund endpoint only',
        ceiling: '10 calls per hour',
        risk: 'low',
        dataSensitivity: 'low',
        autonomyLevel: 'acts-with-confirmation',
        requiresConfirmation: false,
        approvalRule: '',
        escalationRule: '',
        dryRunFirst: false,
        reversibleOverride: true,
      },
      {
        id: 'sr-spend',
        capabilityId: 'spend-money',
        resource: 'Refund issuance',
        scope: 'qualifying tickets only',
        ceiling: '$50 per transaction, $200 per day',
        risk: 'medium',
        dataSensitivity: 'medium',
        autonomyLevel: 'acts-with-confirmation',
        requiresConfirmation: true,
        approvalRule: 'Support lead approves any refund above the per transaction ceiling.',
        escalationRule: 'Escalate to billing on-call if a refund is attempted outside the linked account.',
        dryRunFirst: true,
        reversibleOverride: true,
      },
    ],
  },
];

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

function cloneGrants(grants: Grant[]): Grant[] {
  return grants.map((g) => ({ ...g }));
}

/* ------------------------------------------------------------------ *
 * Tool module contract, per src/data/types.ts
 * ------------------------------------------------------------------ */
export interface PlannerState {
  mission: string;
  grants: Grant[];
  scenarioId: string;
}

export function emptyState(): PlannerState {
  return { mission: '', grants: [], scenarioId: SAMPLES[0].id };
}

export function sampleState(id: string = SAMPLES[0].id): PlannerState {
  const sample = getSample(id) ?? SAMPLES[0];
  return { mission: sample.mission, grants: cloneGrants(sample.grants), scenarioId: sample.id };
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
  if (!state.grants.length) {
    issues.push({
      field: 'grants',
      message: 'Add at least one resource and action, or load a sample.',
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
  for (const grant of state.grants) {
    if (!grant.resource.trim()) {
      issues.push({
        field: `grant-${grant.id}-resource`,
        message: `A ${CAPABILITIES[grant.capabilityId].action.toLowerCase()} grant has no resource named. State what it applies to.`,
        severity: 'warning',
      });
    }
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
        wildcardCount: analysis.wildcardCount,
        riskMismatchCount: analysis.riskMismatchCount,
      },
      null,
      2,
    );
  }

  const matrixRows = analysis.findings.map((f) => {
    const scope = f.wildcard ? 'WILDCARD' : f.grant.scope.trim() || '(unscoped)';
    return `| ${CAPABILITIES[f.grant.capabilityId].action} | ${f.grant.resource || CAPABILITIES[f.grant.capabilityId].defaultResource} | ${SEVERITY_LABELS[f.grant.risk]} | ${SEVERITY_LABELS[f.blast.severity]} | ${f.blast.reversibility} | ${DATA_SENSITIVITY_LABELS[f.grant.dataSensitivity]} | ${AUTONOMY_LEVEL_LABELS[f.grant.autonomyLevel]} | ${scope} |`;
  });

  const comboLines = analysis.combos.length
    ? analysis.combos
        .map(
          (c, i) =>
            `${i + 1}. ${c.name}. ${c.message} Grants involved: ${c.triggeringGrants.map((g) => g.label).join(', ')}.`,
        )
        .join('\n')
    : 'None of the three named compound risks matched this configuration. That states what did not match, not that the configuration is free of risk.';

  const auditLines = analysis.auditLog.length
    ? analysis.auditLog
        .map((a) => `### ${a.label}\n\n${a.log.map((line, i) => `${i + 1}. ${line}`).join('\n')}`)
        .join('\n\n')
    : 'No resource or action added yet.';

  return [
    '# Permission Planner report',
    '',
    'Design guidance, not legal or security certification.',
    '',
    analysis.mission ? `Mission: ${analysis.mission}` : 'No mission stated.',
    '',
    `Wildcard grants: ${analysis.wildcardCount}. Declared risk differs from assessed severity on ${analysis.riskMismatchCount} grant(s).`,
    '',
    '## Permission matrix, resource by action',
    '',
    '| Action | Resource | Declared risk | Assessed severity | Reversibility | Data sensitivity | Autonomy | Scope |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
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
