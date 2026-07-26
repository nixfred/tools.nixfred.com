/**
 * AI Stack Mapper, architecture and trace engine.
 *
 * PRD: tools-nixfred-prds/tools/14-STACK-MAPPER.md
 * User outcome: draw the whole path a request takes, so an architect can
 * explain the system to a Customer or a team who has to trust it.
 *
 * BOUNDARY FROM THE PRD: "This is a design and explanation tool, not
 * infrastructure provisioning." Nothing here reaches a network, reads a
 * real system, or provisions anything. Every finding is a deterministic
 * function of the stack the user composed. The consolidation rule from
 * 01-INFORMATION-ARCHITECTURE.md folds "Inside the Request" into this
 * tool as its trace mode rather than a separate page.
 *
 * DESIGN DECISION, stated plainly because it shapes every function
 * below. The raw tool PRD describes an architecture that a user
 * "assembles," and the surrounding product PRDs describe request
 * traces that "follow the actual connections in the map." A general
 * graph editor, arbitrary edges, branching, cycles, would need its own
 * layout engine and its own notion of what a "disconnected" node means.
 * This engine instead models the composed stack as an ORDERED PATH: the
 * sequence of hops a single request visits, in the order the user
 * arranges them. That is exactly what "trace mode" and "the whole path
 * a request takes" ask for, it keeps the diagram deterministic and
 * exportable, and it keeps reordering keyboard accessible with move up
 * and move down controls instead of a drag and drop graph canvas.
 * "Invalid or disconnected" is honored within that model: an empty
 * stack, a path that does not begin at a client, and a guardrail that
 * guards a kind absent from the stack are all flagged by validate().
 *
 * Pure functions only. No DOM, no globals, no I/O.
 */

/* ------------------------------------------------------------------ *
 * Component catalog
 * ------------------------------------------------------------------ */

/** The 14 component kinds a stack is built from, per the product brief. */
export const COMPONENT_KINDS = [
  'client',
  'gateway',
  'auth',
  'rate-limiter',
  'cache',
  'retriever',
  'vector-store',
  'reranker',
  'model-provider',
  'tool-call',
  'guardrail',
  'logging',
  'evaluation-hook',
  'human-review',
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const FAILURE_MODES = ['fails-open', 'fails-closed'] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

/**
 * Static facts about a kind of component. These seed the defaults a new
 * instance is created with. Everything here is editable per instance,
 * because 00-PRODUCT-VISION.md principle 3 requires assumptions to stay
 * visible and editable rather than baked in.
 */
interface CatalogEntry {
  label: string;
  /** One sentence, plain language, said to someone who is not an engineer. */
  description: string;
  defaultSeesRawUserData: boolean;
  defaultThirdParty: boolean;
  defaultPersists: boolean;
  defaultFailureMode: FailureMode;
  /**
   * Whether this kind of hop typically performs blocking network or
   * disk I/O. Drives the "no timeout" structural flag: a hop that never
   * blocks has nothing for a missing timeout to protect against.
   */
  typicallyBlockingIO: boolean;
  /**
   * Whether this kind is normally the only path to what it does. Drives
   * the "single point of failure" structural flag.
   */
  criticalByDefault: boolean;
  /** Plain language description of what realistically goes wrong here. */
  whatCouldFail: string;
}

export const CATALOG: Record<ComponentKind, CatalogEntry> = {
  client: {
    label: 'Client',
    description: 'Where the request originates. A person or another system.',
    defaultSeesRawUserData: true,
    defaultThirdParty: false,
    defaultPersists: false,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: false,
    criticalByDefault: false,
    whatCouldFail:
      'The client can send a malformed or hostile request, or disappear mid stream before the response arrives.',
  },
  gateway: {
    label: 'Gateway',
    description: 'The front door. Routes, versions, and shapes the request before anything else sees it.',
    defaultSeesRawUserData: true,
    defaultThirdParty: false,
    defaultPersists: false,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: true,
    criticalByDefault: true,
    whatCouldFail:
      'The gateway can reject a valid request under load, or forward a request it should have blocked.',
  },
  auth: {
    label: 'Auth',
    description: 'Confirms who is asking before the request is allowed to do anything.',
    defaultSeesRawUserData: false,
    defaultThirdParty: false,
    defaultPersists: false,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: true,
    criticalByDefault: true,
    whatCouldFail:
      'Auth can wrongly deny a legitimate user, or worse, admit one it should not.',
  },
  'rate-limiter': {
    label: 'Rate limiter',
    description: 'Caps how much of the system one requester can consume.',
    defaultSeesRawUserData: false,
    defaultThirdParty: false,
    defaultPersists: false,
    defaultFailureMode: 'fails-open',
    typicallyBlockingIO: true,
    criticalByDefault: false,
    whatCouldFail:
      'The rate limiter can throttle a legitimate burst, or fail to catch actual abuse.',
  },
  cache: {
    label: 'Cache',
    description: 'Answers from a prior result instead of redoing the work.',
    defaultSeesRawUserData: true,
    defaultThirdParty: false,
    defaultPersists: true,
    defaultFailureMode: 'fails-open',
    typicallyBlockingIO: true,
    criticalByDefault: false,
    whatCouldFail:
      'The cache can return a stale answer, or a cache outage can force every request onto the slow path at once.',
  },
  retriever: {
    label: 'Retriever',
    description: 'Searches for material relevant to the request before generation.',
    defaultSeesRawUserData: true,
    defaultThirdParty: false,
    defaultPersists: false,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: true,
    criticalByDefault: true,
    whatCouldFail:
      'The retriever can return nothing relevant, or time out while the index is busy.',
  },
  'vector-store': {
    label: 'Vector store',
    description: 'Holds embeddings and returns nearest neighbors for a query vector.',
    defaultSeesRawUserData: false,
    defaultThirdParty: true,
    defaultPersists: true,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: true,
    criticalByDefault: true,
    whatCouldFail:
      'The vector store can return stale or missing matches if it falls behind the source data.',
  },
  reranker: {
    label: 'Reranker',
    description: 'Reorders retrieved candidates by estimated relevance.',
    defaultSeesRawUserData: true,
    defaultThirdParty: false,
    defaultPersists: false,
    defaultFailureMode: 'fails-open',
    typicallyBlockingIO: true,
    criticalByDefault: false,
    whatCouldFail:
      'The reranker can promote a wrong result to the top, or add latency for a small quality gain.',
  },
  'model-provider': {
    label: 'Model provider',
    description: 'Generates the response. Usually a hosted model API.',
    defaultSeesRawUserData: true,
    defaultThirdParty: true,
    defaultPersists: false,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: true,
    criticalByDefault: true,
    whatCouldFail:
      'The provider can time out, return malformed output, or be unavailable outright.',
  },
  'tool-call': {
    label: 'Tool or function call',
    description: 'Lets the model act, look something up, or reach another system.',
    defaultSeesRawUserData: true,
    defaultThirdParty: true,
    defaultPersists: false,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: true,
    criticalByDefault: false,
    whatCouldFail:
      'A tool call can fail, hang, or return output the caller is not prepared to receive.',
  },
  guardrail: {
    label: 'Guardrail',
    description: 'Filters or blocks content against a stated policy.',
    defaultSeesRawUserData: true,
    defaultThirdParty: false,
    defaultPersists: false,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: true,
    criticalByDefault: true,
    whatCouldFail:
      'A guardrail can miss what it is supposed to catch, or block something that was actually fine.',
  },
  logging: {
    label: 'Logging',
    description: 'Records what happened for audit and debugging.',
    defaultSeesRawUserData: true,
    defaultThirdParty: false,
    defaultPersists: true,
    defaultFailureMode: 'fails-open',
    typicallyBlockingIO: true,
    criticalByDefault: false,
    whatCouldFail:
      'Logging can silently drop events, or a logging outage can be mistaken for application downtime.',
  },
  'evaluation-hook': {
    label: 'Evaluation hook',
    description: 'Scores or labels the output for quality after the fact.',
    defaultSeesRawUserData: false,
    defaultThirdParty: false,
    defaultPersists: true,
    defaultFailureMode: 'fails-open',
    typicallyBlockingIO: true,
    criticalByDefault: false,
    whatCouldFail:
      'An evaluation hook can score the wrong thing, or fall behind and evaluate stale output.',
  },
  'human-review': {
    label: 'Human review',
    description: 'A person checks or approves the request before it completes.',
    defaultSeesRawUserData: true,
    defaultThirdParty: false,
    defaultPersists: false,
    defaultFailureMode: 'fails-closed',
    typicallyBlockingIO: true,
    criticalByDefault: false,
    whatCouldFail:
      'A human reviewer can be slow, unavailable, or inconsistent between reviewers.',
  },
};

/* ------------------------------------------------------------------ *
 * Stack state
 * ------------------------------------------------------------------ */

/**
 * One instance of a component in the composed stack. The four fields
 * called out in the product brief, seesRawUserData, thirdParty,
 * persists, failureMode, are the properties the acceptance criteria
 * are graded against. hasTimeout and hasFallback are additional
 * operational properties this engine needs to produce the structural
 * failure flags the brief also asks for. guards applies only when
 * kind is 'guardrail'.
 */
export interface StackComponent {
  id: string;
  kind: ComponentKind;
  /** Editable display name. Defaults to the catalog label. */
  label: string;
  seesRawUserData: boolean;
  thirdParty: boolean;
  persists: boolean;
  failureMode: FailureMode;
  hasTimeout: boolean;
  hasFallback: boolean;
  /** Only meaningful when kind === 'guardrail'. What this guardrail is meant to protect. */
  guards?: ComponentKind;
}

export interface StackMapperState {
  components: StackComponent[];
  /** Which sample is selected in the toolbar. Cosmetic only. */
  sampleId: string;
}

/** Suffix a new instance gets so ids never collide with a removed one reused later. */
function nextSuffix(kind: ComponentKind, existing: StackComponent[]): number {
  const nums = existing
    .filter((c) => c.kind === kind)
    .map((c) => {
      const match = /-(\d+)$/.exec(c.id);
      return match ? parseInt(match[1], 10) : 1;
    });
  return nums.length ? Math.max(...nums) + 1 : 1;
}

export function createComponent(kind: ComponentKind, existing: StackComponent[]): StackComponent {
  const n = nextSuffix(kind, existing);
  const catalog = CATALOG[kind];
  return {
    id: `${kind}-${n}`,
    kind,
    label: n > 1 ? `${catalog.label} ${n}` : catalog.label,
    seesRawUserData: catalog.defaultSeesRawUserData,
    thirdParty: catalog.defaultThirdParty,
    persists: catalog.defaultPersists,
    failureMode: catalog.defaultFailureMode,
    // Conservative on purpose: an unstated timeout or fallback is assumed
    // absent rather than assumed safe. The user states it if it is true.
    hasTimeout: false,
    hasFallback: false,
    guards: kind === 'guardrail' ? 'model-provider' : undefined,
  };
}

export function addComponent(state: StackMapperState, kind: ComponentKind): StackMapperState {
  return {
    ...state,
    components: [...state.components, createComponent(kind, state.components)],
  };
}

export function removeComponent(state: StackMapperState, id: string): StackMapperState {
  return { ...state, components: state.components.filter((c) => c.id !== id) };
}

export function moveComponent(
  state: StackMapperState,
  id: string,
  direction: 'up' | 'down',
): StackMapperState {
  const list = [...state.components];
  const i = list.findIndex((c) => c.id === id);
  if (i === -1) return state;
  const isUp = direction === 'up';
  const j = isUp ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return state;
  [list[i], list[j]] = [list[j], list[i]];
  return { ...state, components: list };
}

export function updateComponent(
  state: StackMapperState,
  id: string,
  patch: Partial<StackComponent>,
): StackMapperState {
  return {
    ...state,
    components: state.components.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 *
 * "Invalid or disconnected architecture is flagged" (14-STACK-MAPPER.md).
 * Within the ordered path model, invalid means: nothing composed, the
 * path does not begin where a request actually begins, or a guardrail
 * guards a kind that is not present, which is a guardrail connected to
 * nothing.
 * ------------------------------------------------------------------ */

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validate(state: StackMapperState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { components } = state;

  if (components.length === 0) {
    issues.push({
      field: 'components',
      message: 'No components composed yet. Add at least one, or load a sample stack.',
      severity: 'error',
    });
    return issues;
  }

  if (components[0].kind !== 'client') {
    issues.push({
      field: 'components.0',
      message:
        'The path does not begin at a client. Without a request origin, there is nothing for the trace to follow.',
      severity: 'warning',
    });
  }

  if (!components.some((c) => c.kind === 'model-provider')) {
    issues.push({
      field: 'components',
      message: 'No model provider is present, so nothing in this stack generates a response.',
      severity: 'warning',
    });
  }

  for (const c of components) {
    if (c.kind !== 'guardrail' || !c.guards) continue;
    if (!components.some((other) => other.kind === c.guards)) {
      issues.push({
        field: c.id,
        message: `${c.label} is set to guard ${CATALOG[c.guards].label}, but no ${CATALOG[c.guards].label} is present in the stack. This guardrail is connected to nothing.`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * Data flow analysis
 *
 * PRD: "the highest value output": which components see raw user
 * input, where it crosses a trust boundary, where it leaves the
 * building to a third party, and where it comes to rest in storage.
 * ------------------------------------------------------------------ */

export interface DataFlowAnalysis {
  /** Components that see the raw user input, in path order. */
  rawInputSeenBy: string[];
  /** Every hop that is a third party, each one a trust boundary crossing. */
  trustBoundaryCrossings: Array<{ id: string; label: string; precededBy: string | null }>;
  /** Same set as crossings here, named separately because it is a distinct question a Customer asks. */
  thirdPartyHops: string[];
  /** Where a copy of something comes to rest. */
  storagePoints: string[];
}

export function analyzeDataFlow(state: StackMapperState): DataFlowAnalysis {
  const { components } = state;
  const rawInputSeenBy = components.filter((c) => c.seesRawUserData).map((c) => c.id);
  const thirdPartyHops = components.filter((c) => c.thirdParty).map((c) => c.id);
  const storagePoints = components.filter((c) => c.persists).map((c) => c.id);

  const trustBoundaryCrossings = components
    .filter((c) => c.thirdParty)
    .map((c) => {
      const i = components.findIndex((x) => x.id === c.id);
      return { id: c.id, label: c.label, precededBy: i > 0 ? components[i - 1].label : null };
    });

  return { rawInputSeenBy, trustBoundaryCrossings, thirdPartyHops, storagePoints };
}

/* ------------------------------------------------------------------ *
 * Structural risk flags
 *
 * PRD: "Flag failure modes structurally: a component with no timeout,
 * a single point of failure with no fallback, a guardrail placed AFTER
 * the thing it is supposed to guard, and any third party hop that
 * handles raw user data."
 * ------------------------------------------------------------------ */

export const RISK_FLAG_KINDS = [
  'no-timeout',
  'single-point-of-failure',
  'guardrail-misplaced',
  'third-party-raw-data',
] as const;
export type RiskFlagKind = (typeof RISK_FLAG_KINDS)[number];

export type RiskSeverity = 'critical' | 'warning';

export interface RiskFlag {
  kind: RiskFlagKind;
  severity: RiskSeverity;
  componentId: string;
  componentLabel: string;
  message: string;
}

export function analyzeRiskFlags(state: StackMapperState): RiskFlag[] {
  const { components } = state;
  const flags: RiskFlag[] = [];

  components.forEach((c, i) => {
    const catalog = CATALOG[c.kind];

    if (catalog.typicallyBlockingIO && !c.hasTimeout) {
      flags.push({
        kind: 'no-timeout',
        severity: 'warning',
        componentId: c.id,
        componentLabel: c.label,
        message: `${c.label} has no declared timeout. A stall here can hang the whole request instead of failing fast.`,
      });
    }

    if (catalog.criticalByDefault && !c.hasFallback) {
      flags.push({
        kind: 'single-point-of-failure',
        severity: 'warning',
        componentId: c.id,
        componentLabel: c.label,
        message: `${c.label} is the only path to what it does and has no declared fallback. If it fails, the request has nowhere else to go.`,
      });
    }

    if (c.thirdParty && c.seesRawUserData) {
      flags.push({
        kind: 'third-party-raw-data',
        severity: 'critical',
        componentId: c.id,
        componentLabel: c.label,
        message: `${c.label} sees raw user input and is a third party. Raw user data leaves your infrastructure here.`,
      });
    }

    if (c.kind === 'guardrail' && c.guards) {
      const targetIndex = components.findIndex((other) => other.kind === c.guards);
      if (targetIndex !== -1 && i > targetIndex) {
        flags.push({
          kind: 'guardrail-misplaced',
          severity: 'critical',
          componentId: c.id,
          componentLabel: c.label,
          message: `${c.label} is meant to guard ${CATALOG[c.guards].label}, but it runs after ${CATALOG[c.guards].label} already executed. It cannot prevent what it exists to prevent.`,
        });
      }
    }
  });

  return flags;
}

/**
 * Plain language sentence describing how this component behaves under
 * failure, combining failureMode with the two operational properties.
 */
export function describeFailureBehavior(c: StackComponent): string {
  const catalog = CATALOG[c.kind];
  const parts: string[] = [];

  parts.push(
    c.failureMode === 'fails-open'
      ? 'Configured to fail open, so a failure here lets the request continue as if this step succeeded.'
      : 'Configured to fail closed, so a failure here stops the request rather than continuing on a false assumption.',
  );

  if (catalog.typicallyBlockingIO && !c.hasTimeout) {
    parts.push(
      'No timeout is declared, so a stall here can hang the whole request instead of failing fast.',
    );
  }

  if (catalog.criticalByDefault && !c.hasFallback) {
    parts.push(
      'No fallback is declared, and this is the only path to what it does, so its failure has nowhere else to go.',
    );
  }

  return parts.join(' ');
}

/* ------------------------------------------------------------------ *
 * Trace mode, "Inside the Request"
 *
 * 01-INFORMATION-ARCHITECTURE.md consolidation: "Inside the Request
 * becomes a trace mode inside Stack Mapper." Steps a single request
 * through the composed stack, showing what data is present, what is
 * added, what is stripped, and what could fail at each hop.
 * ------------------------------------------------------------------ */

export const DATA_TAGS = [
  'raw-input',
  'sanitized-input',
  'user-identity',
  'retrieved-context',
  'ranked-context',
  'model-output',
  'tool-result',
  'eval-score',
  'human-decision',
] as const;
export type DataTag = (typeof DATA_TAGS)[number];

export const DATA_TAG_LABELS: Record<DataTag, string> = {
  'raw-input': 'Raw user input',
  'sanitized-input': 'Sanitized input, post filter',
  'user-identity': 'Authenticated user identity',
  'retrieved-context': 'Retrieved candidate documents',
  'ranked-context': 'Reranked context',
  'model-output': 'Model generated output',
  'tool-result': 'Tool call result',
  'eval-score': 'Evaluation score',
  'human-decision': 'Human review decision',
};

/**
 * What each kind adds and removes from the data flowing through it, in
 * the ordinary case. Guardrail is handled separately below because its
 * effect, sanitizing raw input, is definitional to the kind rather than
 * a per kind catalog fact shared with anything else.
 */
const ADDS: Partial<Record<ComponentKind, DataTag[]>> = {
  client: ['raw-input'],
  auth: ['user-identity'],
  retriever: ['retrieved-context'],
  'vector-store': ['retrieved-context'],
  reranker: ['ranked-context'],
  'model-provider': ['model-output'],
  'tool-call': ['tool-result'],
  'evaluation-hook': ['eval-score'],
  'human-review': ['human-decision'],
};

const REMOVES: Partial<Record<ComponentKind, DataTag[]>> = {
  reranker: ['retrieved-context'],
};

export interface TraceHop {
  index: number;
  componentId: string;
  componentLabel: string;
  kindLabel: string;
  before: DataTag[];
  added: DataTag[];
  stripped: DataTag[];
  after: DataTag[];
  couldFail: string;
  failureBehavior: string;
  flags: RiskFlag[];
}

export function traceRequest(state: StackMapperState): TraceHop[] {
  const flags = analyzeRiskFlags(state);
  const running = new Set<DataTag>();

  return state.components.map((c, i) => {
    const before = [...running];

    let added: DataTag[] = ADDS[c.kind] ? [...(ADDS[c.kind] as DataTag[])] : [];
    let stripped: DataTag[] = REMOVES[c.kind] ? [...(REMOVES[c.kind] as DataTag[])] : [];

    // A guardrail's job is to sanitize what passes through it. That
    // holds regardless of where it sits in the path, which is exactly
    // what makes a misplaced one dangerous: it still runs, it just runs
    // too late to have protected anything before it.
    if (c.kind === 'guardrail' && running.has('raw-input')) {
      stripped = [...stripped, 'raw-input'];
      added = [...added, 'sanitized-input'];
    }

    stripped.forEach((t) => running.delete(t));
    added.forEach((t) => running.add(t));

    return {
      index: i,
      componentId: c.id,
      componentLabel: c.label,
      kindLabel: CATALOG[c.kind].label,
      before,
      added,
      stripped,
      after: [...running],
      couldFail: CATALOG[c.kind].whatCouldFail,
      failureBehavior: describeFailureBehavior(c),
      flags: flags.filter((f) => f.componentId === c.id),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Textual equivalent
 *
 * "An SVG diagram that only communicates visually fails half the
 * audience... Provide a real textual equivalent: proper title and desc
 * elements, and an ordered text description of the path that conveys
 * everything the picture does."
 * ------------------------------------------------------------------ */

function propertyPhrase(c: StackComponent): string {
  const parts: string[] = [];
  parts.push(c.seesRawUserData ? 'sees raw user input' : 'does not see raw user input');
  if (c.thirdParty) parts.push('is a third party');
  if (c.persists) parts.push('persists data');
  parts.push(c.failureMode === 'fails-open' ? 'fails open' : 'fails closed');
  return parts.join(', ');
}

/**
 * One plain sentence per component, in path order, with no leading
 * number. Rendered inside a real <ol> on the page, which supplies its
 * own numbering, and prefixed with "1." per line in the markdown
 * export, where commonmark renumbers an ordered list regardless of the
 * literal digit used. Keeping the number out of the sentence itself
 * avoids the two numbering schemes fighting each other.
 */
export function describePath(state: StackMapperState): string[] {
  const flags = analyzeRiskFlags(state);
  return state.components.map((c) => {
    const ownFlags = flags.filter((f) => f.componentId === c.id);
    const flagText = ownFlags.length
      ? ` Flagged: ${ownFlags.map((f) => f.message).join(' ')}`
      : '';
    return `${c.label}, a ${CATALOG[c.kind].label.toLowerCase()}. It ${propertyPhrase(c)}.${flagText}`;
  });
}

/* ------------------------------------------------------------------ *
 * Diagram
 *
 * Deterministic inline SVG. No external library, no network, no image
 * files. Every color is currentColor or var(--token), per house style,
 * even though the color gate only scans src/components, src/layouts,
 * and src/pages: tokens are law site wide, not only where a gate looks.
 * ------------------------------------------------------------------ */

const BOX_W = 320;
const BOX_H = 84;
const GAP_Y = 44;
const MARGIN_X = 32;
const MARGIN_Y = 32;
const STRIPE_W = 6;

export interface DiagramNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Diagram {
  svg: string;
  width: number;
  height: number;
  nodes: DiagramNode[];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Keeps a label inside its box without wrapping, which SVG text does not do on its own. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = max - 3;
  return `${s.slice(0, cut)}...`;
}

export function buildDiagram(state: StackMapperState): Diagram {
  const flags = analyzeRiskFlags(state);
  const flaggedIds = new Set(flags.map((f) => f.componentId));
  const { components } = state;

  const width = MARGIN_X * 2 + BOX_W;
  const height =
    components.length === 0
      ? MARGIN_Y * 2 + BOX_H
      : MARGIN_Y * 2 + components.length * BOX_H + (components.length - 1) * GAP_Y;

  const nodes: DiagramNode[] = components.map((c, i) => ({
    id: c.id,
    x: MARGIN_X,
    y: MARGIN_Y + i * (BOX_H + GAP_Y),
    width: BOX_W,
    height: BOX_H,
  }));

  const titleId = 'stack-diagram-title';
  const descId = 'stack-diagram-desc';
  const lastIndex = components.length - 1;
  const title = components.length
    ? `Request path through ${components.length} component${components.length === 1 ? '' : 's'}, from ${components[0].label} to ${components[lastIndex].label}.`
    : 'Empty stack. No components composed yet.';
  const desc = components.length
    ? `Ordered top to bottom. ${components
        .map((c) => c.label)
        .join(', then ')}. ${flags.length} structural flag${flags.length === 1 ? '' : 's'} across the path. A full ordered description of every hop follows this diagram as text.`
    : 'Compose a stack, or load a sample, to draw the request path.';

  const defs = `<defs><marker id="stack-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--text-dim)" /></marker></defs>`;

  const boxes = components
    .map((c, i) => {
      const n = nodes[i];
      const flagged = flaggedIds.has(c.id);
      const stroke = flagged ? 'var(--status-alert)' : 'var(--line-strong)';
      const strokeWidth = flagged ? 2 : 1;
      const label = escapeXml(truncate(c.label, 34));
      const kindLine = escapeXml(CATALOG[c.kind].label);
      const badges = [
        c.seesRawUserData ? 'raw data' : null,
        c.thirdParty ? 'third party' : null,
        c.persists ? 'persists' : null,
      ]
        .filter((b): b is string => Boolean(b))
        .join('  ·  ');
      const badgeLine = escapeXml(badges || 'no flagged properties');

      const stripe = c.thirdParty
        ? `<rect x="${n.x}" y="${n.y}" width="${STRIPE_W}" height="${n.height}" style="fill:var(--status-beta)" />`
        : '';

      return `
    <g role="img" aria-label="${escapeXml(`${c.label}, ${CATALOG[c.kind].label}. ${badges || 'no flagged properties'}.`)}">
      <rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="6" style="fill:var(--panel);stroke:${stroke};stroke-width:${strokeWidth}" />
      ${stripe}
      <text x="${n.x + 18}" y="${n.y + 28}" style="font:700 0.95rem var(--font-sans);fill:var(--text)">${label}</text>
      <text x="${n.x + 18}" y="${n.y + 47}" style="font:0.78rem var(--font-mono);fill:var(--text-faint)">${kindLine}</text>
      <text x="${n.x + 18}" y="${n.y + 67}" style="font:0.78rem var(--font-mono);fill:var(--text-dim)">${badgeLine}</text>
    </g>`;
    })
    .join('');

  const connectors = nodes
    .slice(0, -1)
    .map((n, i) => {
      const next = nodes[i + 1];
      const cx = n.x + n.width / 2;
      return `<line x1="${cx}" y1="${n.y + n.height}" x2="${cx}" y2="${next.y}" style="stroke:var(--text-dim);stroke-width:1.5" marker-end="url(#stack-arrow)" />`;
    })
    .join('');

  const svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${titleId} ${descId}" xmlns="http://www.w3.org/2000/svg"><title id="${titleId}">${escapeXml(title)}</title><desc id="${descId}">${escapeXml(desc)}</desc>${defs}${connectors}${boxes}</svg>`;

  return { svg, width, height, nodes };
}

/* ------------------------------------------------------------------ *
 * Samples
 *
 * Two realistic stacks. The first is deliberately mostly well
 * configured, so the flags it does raise are legible against a mostly
 * clean baseline. The second is a richer RAG stack with tool calls that
 * exercises all four risk flag kinds, including a guardrail placed
 * after the model it is meant to guard.
 * ------------------------------------------------------------------ */

export interface Sample {
  id: string;
  name: string;
  teaches: string;
  components: StackComponent[];
}

export const SAMPLES: Sample[] = [
  {
    id: 'simple-chat',
    name: 'Simple chat assistant',
    teaches:
      'A correctly placed guardrail next to a model provider with no timeout and no fallback, a hosted model seeing raw input, and an auth layer with no fallback.',
    components: [
      {
        id: 'client-1',
        kind: 'client',
        label: 'Client',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: false,
        hasFallback: false,
      },
      {
        id: 'gateway-1',
        kind: 'gateway',
        label: 'Gateway',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: true,
      },
      {
        id: 'auth-1',
        kind: 'auth',
        label: 'Auth',
        seesRawUserData: false,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: false,
      },
      {
        id: 'rate-limiter-1',
        kind: 'rate-limiter',
        label: 'Rate limiter',
        seesRawUserData: false,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-open',
        hasTimeout: true,
        hasFallback: false,
      },
      {
        id: 'guardrail-1',
        kind: 'guardrail',
        label: 'Input guardrail',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: true,
        guards: 'model-provider',
      },
      {
        id: 'model-provider-1',
        kind: 'model-provider',
        label: 'Model provider',
        seesRawUserData: true,
        thirdParty: true,
        persists: false,
        failureMode: 'fails-open',
        hasTimeout: false,
        hasFallback: false,
      },
      {
        id: 'logging-1',
        kind: 'logging',
        label: 'Logging',
        seesRawUserData: true,
        thirdParty: false,
        persists: true,
        failureMode: 'fails-open',
        hasTimeout: true,
        hasFallback: false,
      },
    ],
  },
  {
    id: 'rag-tools',
    name: 'RAG assistant with tool calls',
    teaches:
      'A vector store that correctly never sees raw input even though it is a third party, a retriever with no timeout, and a guardrail placed after the model and the tool call it was meant to guard.',
    components: [
      {
        id: 'client-1',
        kind: 'client',
        label: 'Client',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: false,
        hasFallback: false,
      },
      {
        id: 'gateway-1',
        kind: 'gateway',
        label: 'Gateway',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: true,
      },
      {
        id: 'auth-1',
        kind: 'auth',
        label: 'Auth',
        seesRawUserData: false,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: true,
      },
      {
        id: 'cache-1',
        kind: 'cache',
        label: 'Cache',
        seesRawUserData: true,
        thirdParty: false,
        persists: true,
        failureMode: 'fails-open',
        hasTimeout: true,
        hasFallback: false,
      },
      {
        id: 'retriever-1',
        kind: 'retriever',
        label: 'Retriever',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: false,
        hasFallback: false,
      },
      {
        id: 'vector-store-1',
        kind: 'vector-store',
        label: 'Vector store',
        seesRawUserData: false,
        thirdParty: true,
        persists: true,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: false,
      },
      {
        id: 'reranker-1',
        kind: 'reranker',
        label: 'Reranker',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-open',
        hasTimeout: true,
        hasFallback: false,
      },
      {
        id: 'model-provider-1',
        kind: 'model-provider',
        label: 'Model provider',
        seesRawUserData: true,
        thirdParty: true,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: true,
      },
      {
        id: 'tool-call-1',
        kind: 'tool-call',
        label: 'Order lookup tool',
        seesRawUserData: true,
        thirdParty: true,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: false,
      },
      {
        id: 'guardrail-1',
        kind: 'guardrail',
        label: 'Output guardrail',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: true,
        hasFallback: true,
        guards: 'model-provider',
      },
      {
        id: 'logging-1',
        kind: 'logging',
        label: 'Logging',
        seesRawUserData: true,
        thirdParty: false,
        persists: true,
        failureMode: 'fails-open',
        hasTimeout: true,
        hasFallback: false,
      },
      {
        id: 'evaluation-hook-1',
        kind: 'evaluation-hook',
        label: 'Evaluation hook',
        seesRawUserData: false,
        thirdParty: false,
        persists: true,
        failureMode: 'fails-open',
        hasTimeout: false,
        hasFallback: false,
      },
      {
        id: 'human-review-1',
        kind: 'human-review',
        label: 'Human review',
        seesRawUserData: true,
        thirdParty: false,
        persists: false,
        failureMode: 'fails-closed',
        hasTimeout: false,
        hasFallback: false,
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

export function emptyState(): StackMapperState {
  return { components: [], sampleId: SAMPLES[0].id };
}

export function sampleState(id: string = SAMPLES[0].id): StackMapperState {
  const sample = getSample(id) ?? SAMPLES[0];
  return {
    // Deep copy so editing the loaded sample never mutates the catalog above.
    components: sample.components.map((c) => ({ ...c })),
    sampleId: sample.id,
  };
}

export function reset(): StackMapperState {
  return emptyState();
}

export interface StackAnalysis {
  riskFlags: RiskFlag[];
  dataFlow: DataFlowAnalysis;
  trace: TraceHop[];
  diagram: Diagram;
  pathDescription: string[];
  validation: ValidationIssue[];
}

export function analyzeStack(state: StackMapperState): StackAnalysis {
  return {
    riskFlags: analyzeRiskFlags(state),
    dataFlow: analyzeDataFlow(state),
    trace: traceRequest(state),
    diagram: buildDiagram(state),
    pathDescription: describePath(state),
    validation: validate(state),
  };
}

export type ExportFormat = 'json' | 'markdown';

export function serialize(state: StackMapperState, format: ExportFormat): string {
  const analysis = analyzeStack(state);
  const note =
    'This maps the design as composed. It is a design and explanation tool, not infrastructure provisioning: nothing here was deployed, monitored, or verified against a running system.';

  if (format === 'json') {
    return JSON.stringify(
      {
        generatedBy: 'Nixfred AI Systems Workbench, AI Stack Mapper',
        note,
        components: state.components,
        dataFlow: analysis.dataFlow,
        riskFlags: analysis.riskFlags,
        validation: analysis.validation,
      },
      null,
      2,
    );
  }

  const { dataFlow, riskFlags, validation } = analysis;

  const boundaryLines = dataFlow.trustBoundaryCrossings.length
    ? dataFlow.trustBoundaryCrossings.map(
        (b) =>
          `1. ${b.label}, right after ${b.precededBy ?? 'the start of the path'}. This hop is a third party.`,
      )
    : ['1. No third party hops. The request never leaves your infrastructure.'];

  const storageLines = dataFlow.storagePoints.length
    ? dataFlow.storagePoints.map((id, i) => {
        const c = state.components.find((comp) => comp.id === id);
        return `1. ${c?.label ?? id}`;
      })
    : ['1. Nothing in this stack persists data.'];

  const rawInputLines = dataFlow.rawInputSeenBy.length
    ? dataFlow.rawInputSeenBy.map((id) => {
        const c = state.components.find((comp) => comp.id === id);
        return `1. ${c?.label ?? id}`;
      })
    : ['1. No component is marked as seeing raw user input.'];

  const flagLines = riskFlags.length
    ? riskFlags.map((f) => `1. ${f.componentLabel}: ${f.message}`)
    : ['1. No structural flags raised on this stack.'];

  const validationLines = validation.length
    ? validation.map((v) => `1. ${v.severity}: ${v.message}`)
    : ['1. The composed path is well formed.'];

  return [
    '# AI Stack Mapper, system description',
    '',
    note,
    '',
    '## Request path',
    '',
    ...analysis.pathDescription.map((line) => `1. ${line}`),
    '',
    '## Data flow analysis',
    '',
    '### Sees raw user input',
    '',
    ...rawInputLines,
    '',
    '### Trust boundary crossings, to a third party',
    '',
    ...boundaryLines,
    '',
    '### Comes to rest in storage',
    '',
    ...storageLines,
    '',
    '## Structural flags',
    '',
    ...flagLines,
    '',
    '## Validation',
    '',
    ...validationLines,
    '',
  ].join('\n');
}

export function filename(_state: StackMapperState, _format: ExportFormat): string {
  return 'stack-mapper-report';
}
