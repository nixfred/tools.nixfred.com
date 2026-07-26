/**
 * THE TOOL REGISTRY.
 *
 * 04-LANDING-PAGE.md: "Adding a conforming registry entry must
 * automatically place the tool in search, filters, and the grid."
 * The landing page reads this file and nothing else. Tool
 * implementations may not edit landing-page markup.
 *
 * Entries mirror the initial registry table in
 * 01-INFORMATION-ARCHITECTURE.md.
 *
 * STATUS DISCIPLINE (02-BUILD-CONTROL.md): a tool is `coming-soon`
 * until its own PRD has been implemented and accepted. Foundation
 * scope implemented 03-SHARED-PLATFORM and 04-LANDING-PAGE only, so
 * every tool below is `coming-soon` and NO tool route is generated.
 * Flipping a status to `released` without implementing that tool's
 * PRD produces a dead route and fails tests/check-links.sh.
 */

import type { ToolEntry } from './types';
import { validateToolEntry, isPublic, isActionable } from './types';
import { devFixtures } from './fixtures';

const BASE_TOOLS: ToolEntry[] = [
  {
    slug: 'prompt-lab',
    name: 'Prompt Laboratory',
    shortDescription:
      'See why a small wording change flips model behavior, by comparing prompt structures side by side.',
    category: 'Build',
    tags: ['prompt', 'instructions', 'diff', 'ambiguity', 'system prompt'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'flask',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/prompt-lab',
    prdId: 'tools/01-PROMPT-LAB',
  },
  {
    slug: 'token-planner',
    name: 'Token & Cost Planner',
    shortDescription:
      'Estimate context usage, request cost, and monthly spend with assumptions you can edit and inspect.',
    category: 'Design',
    tags: ['cost', 'tokens', 'pricing', 'budget', 'context window'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'gauge',
    inputSensitivity: 'low',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/token-planner',
    prdId: 'tools/02-TOKEN-PLANNER',
  },
  {
    slug: 'context-packer',
    name: 'Context Packer',
    shortDescription:
      'Decide what survives a finite context window, and see exactly what gets dropped or compressed.',
    category: 'Design',
    tags: ['context', 'packing', 'priority', 'truncation', 'budget'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'layers',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/context-packer',
    prdId: 'tools/03-CONTEXT-PACKER',
  },
  {
    slug: 'rag-lab',
    name: 'Retrieval Lab',
    shortDescription:
      'Watch how chunking, embedding, and ranking choices change what a retrieval system actually returns.',
    category: 'Build',
    tags: ['rag', 'retrieval', 'chunking', 'embedding', 'ranking'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'search',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: false,
    route: '/tools/rag-lab',
    prdId: 'tools/04-RAG-LAB',
  },
  {
    slug: 'model-selector',
    name: 'Model Selector',
    shortDescription:
      'Match a model to a workload using stated constraints instead of vibes or leaderboard rank.',
    category: 'Design',
    tags: ['model', 'selection', 'tradeoff', 'latency', 'cost'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'compass',
    inputSensitivity: 'low',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/model-selector',
    prdId: 'tools/05-MODEL-SELECTOR',
  },
  {
    slug: 'eval-workbench',
    name: 'Evaluation Workbench',
    shortDescription:
      'Design an evaluation that would actually catch the failure you are worried about.',
    category: 'Evaluate',
    tags: ['eval', 'testing', 'grader', 'regression', 'quality'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'checklist',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/eval-workbench',
    prdId: 'tools/06-EVAL-WORKBENCH',
  },
  {
    slug: 'workflow-decomposer',
    name: 'Workflow Decomposer',
    shortDescription:
      'Break a fuzzy business process into steps a system can actually automate, and mark the ones it cannot.',
    category: 'Design',
    tags: ['workflow', 'decomposition', 'automation', 'process', 'handoff'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'branch',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/workflow-decomposer',
    prdId: 'tools/07-WORKFLOW-DECOMPOSER',
  },
  {
    slug: 'agent-designer',
    name: 'Agent Designer',
    shortDescription:
      'Specify an agent completely enough to build it, including its tools, limits, and escalation paths.',
    category: 'Build',
    tags: ['agent', 'autonomy', 'tools', 'handoff', 'fleet', 'observability'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'robot',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/agent-designer',
    prdId: 'tools/08-AGENT-DESIGNER',
  },
  {
    slug: 'permission-planner',
    name: 'Permission Planner',
    shortDescription:
      'Give an agent the narrowest authority that still lets it finish the job.',
    category: 'Design',
    tags: ['permissions', 'authority', 'security', 'blast radius', 'approval'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'shield',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/permission-planner',
    prdId: 'tools/09-PERMISSION-PLANNER',
  },
  {
    slug: 'latency-budgeter',
    name: 'Latency Budgeter',
    shortDescription:
      'Find out which stage of your pipeline spends the most user patience, before you ship it.',
    category: 'Operate',
    tags: ['latency', 'performance', 'budget', 'pipeline', 'streaming'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'stopwatch',
    inputSensitivity: 'low',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/latency-budgeter',
    prdId: 'tools/10-LATENCY-BUDGETER',
  },
  {
    slug: 'failure-investigator',
    name: 'Failure Investigator',
    shortDescription:
      'Work backward from a bad output to the mechanism that produced it, then write the fix down.',
    category: 'Operate',
    tags: ['failure', 'incident', 'debugging', 'root cause', 'postmortem'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'magnifier',
    inputSensitivity: 'high',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/failure-investigator',
    prdId: 'tools/11-FAILURE-INVESTIGATOR',
  },
  {
    slug: 'drift-monitor',
    name: 'Drift Monitor',
    shortDescription:
      'Tell a real behavior change apart from ordinary sampling noise before you go chasing it.',
    category: 'Operate',
    tags: ['drift', 'monitoring', 'baseline', 'regression', 'noise'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'waveform',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/drift-monitor',
    prdId: 'tools/12-DRIFT-MONITOR',
  },
  {
    slug: 'signal-tester',
    name: 'Signal Tester',
    shortDescription:
      'Check whether your evaluation signal measures the thing you care about, or something adjacent to it.',
    category: 'Evaluate',
    tags: ['signal', 'metric', 'validity', 'proxy', 'measurement'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'antenna',
    inputSensitivity: 'medium',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/signal-tester',
    prdId: 'tools/13-SIGNAL-TESTER',
  },
  {
    slug: 'stack-mapper',
    name: 'AI Stack Mapper',
    shortDescription:
      'Draw the whole path a request takes, so you can explain the system to someone who has to trust it.',
    category: 'Understand',
    tags: ['architecture', 'stack', 'trace', 'request', 'explanation', 'diagram'],
    status: 'released',
    version: '0.1.0',
    iconKey: 'stack',
    inputSensitivity: 'low',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/stack-mapper',
    prdId: 'tools/14-STACK-MAPPER',
  },
];

/**
 * Featured placement. 04-LANDING-PAGE.md allows "a small ordered
 * configuration list". Order here is the order rendered.
 */
export const FEATURED_SLUGS: string[] = [
  'prompt-lab',
  'token-planner',
  'context-packer',
];

/**
 * The registry as the site sees it. Dev fixtures are merged ONLY in
 * development, which is what proves the landing page needs no change
 * to accept a new tool (04-LANDING-PAGE.md acceptance criterion 1).
 * Production output contains BASE_TOOLS and nothing else.
 */
export const TOOLS: ToolEntry[] = [
  ...BASE_TOOLS,
  ...(import.meta.env?.DEV ? devFixtures : []),
];

// Contract enforcement at module load: a malformed entry fails the
// build rather than shipping a broken card.
const registryErrors = TOOLS.flatMap(validateToolEntry);
const duplicateSlugs = TOOLS.map((t) => t.slug).filter(
  (slug, i, all) => all.indexOf(slug) !== i,
);
if (duplicateSlugs.length) {
  registryErrors.push(`duplicate slugs: ${[...new Set(duplicateSlugs)].join(', ')}`);
}
if (registryErrors.length) {
  throw new Error(`Tool registry contract violations:\n  ${registryErrors.join('\n  ')}`);
}

/** Every tool that may appear on a public surface. Excludes `hidden`. */
export const PUBLIC_TOOLS: ToolEntry[] = TOOLS.filter(isPublic);

/** Every tool that may be linked as usable. Drives getStaticPaths. */
export const ACTIONABLE_TOOLS: ToolEntry[] = TOOLS.filter(isActionable);

/** Featured entries, in configured order, skipping anything hidden. */
export const FEATURED_TOOLS: ToolEntry[] = FEATURED_SLUGS.map((slug) =>
  PUBLIC_TOOLS.find((t) => t.slug === slug),
).filter((t): t is ToolEntry => Boolean(t));

export function getTool(slug: string): ToolEntry | undefined {
  return TOOLS.find((t) => t.slug === slug);
}

/** Categories that actually have public tools, in canonical order. */
export function activeCategories(): string[] {
  const present = new Set(PUBLIC_TOOLS.map((t) => t.category));
  return ['Design', 'Build', 'Evaluate', 'Operate', 'Understand'].filter((c) =>
    present.has(c as ToolEntry['category']),
  );
}
