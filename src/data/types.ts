/**
 * Registry and tool-module contracts.
 *
 * Source of truth: tools-nixfred-prds/03-SHARED-PLATFORM.md ("Registry
 * contract" and "Tool-module contract") and 01-INFORMATION-ARCHITECTURE.md
 * ("Categories", "Tool states").
 *
 * This file is a CONTRACT. A tool PRD may not alter it. Per
 * 02-BUILD-CONTROL.md, a tool implementation that needs a change here
 * must propose the change and stop.
 */

/** 01-INFORMATION-ARCHITECTURE.md: categories are metadata, never page sections. */
export const CATEGORIES = [
  'Design',
  'Build',
  'Evaluate',
  'Operate',
  'Understand',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * 01-INFORMATION-ARCHITECTURE.md, "Tool states".
 *
 *  released    visible and usable
 *  beta        visible with a clear badge
 *  coming-soon optional on landing page, never linked as usable
 *  hidden      absent from public navigation
 *
 * No route is generated for `hidden` or `coming-soon`. Only `released`
 * and `beta` are actionable.
 */
export const TOOL_STATUSES = ['released', 'beta', 'coming-soon', 'hidden'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/**
 * How sensitive the tool's input is expected to be. Drives which
 * surfaces show the privacy notice, and blocks share-by-URL for
 * anything above `low` (03-SHARED-PLATFORM.md: "URL-safe share state
 * only for small, non-sensitive inputs").
 */
export const INPUT_SENSITIVITIES = ['none', 'low', 'medium', 'high'] as const;
export type InputSensitivity = (typeof INPUT_SENSITIVITIES)[number];

/** A single entry in the tool registry. Every field is required. */
export interface ToolEntry {
  /** URL-safe identifier. Must match `route` as /tools/{slug}. */
  slug: string;
  /** Display name. */
  name: string;
  /** One sentence describing the OUTCOME, not the mechanism. */
  shortDescription: string;
  /** Primary category. Exactly one. */
  category: Category;
  /** Additional search keywords. Lowercase. */
  tags: string[];
  /** Lifecycle state. Controls routing and landing-page treatment. */
  status: ToolStatus;
  /** Semver of the tool module itself, not the site. */
  version: string;
  /** Key into the icon set. Never a path or an import. */
  iconKey: string;
  /** Expected sensitivity of user input. Gates share-by-URL. */
  inputSensitivity: InputSensitivity;
  /** Whether the tool ships a deterministic sample workflow. */
  supportsSample: boolean;
  /** Whether the tool ships an export adapter. */
  supportsExport: boolean;
  /** Canonical route. Always /tools/{slug}. */
  route: string;
  /** The PRD that authorizes this tool. Traceability for build control. */
  prdId: string;
}

/**
 * Tool-module contract (03-SHARED-PLATFORM.md).
 *
 * A released tool supplies this alongside its route. The platform
 * never reaches into a tool's internals; it only reads this shape.
 * Generic over the tool's own state so a tool keeps its types.
 */
export interface ToolModule<TState = unknown> {
  /** Must match a registry entry's slug. */
  slug: string;
  /** The registry entry this module fulfills. */
  meta: ToolEntry;
  /** State shown before the user has done anything. */
  emptyState: () => TState;
  /** Deterministic sample state. Required when supportsSample is true. */
  sampleState?: () => TState;
  /** Returns [] when valid. Never throws. */
  validate: (state: TState) => ValidationIssue[];
  /** Returns state to its empty form. */
  reset: () => TState;
  /** Serializes results. Required when supportsExport is true. */
  exportAdapter?: ExportAdapter<TState>;
}

export interface ValidationIssue {
  /** Field or block the issue attaches to. */
  field: string;
  /** Human-readable, specific, and actionable. */
  message: string;
  severity: 'error' | 'warning';
}

export interface ExportAdapter<TState> {
  formats: Array<'json' | 'csv' | 'markdown'>;
  serialize: (state: TState, format: 'json' | 'csv' | 'markdown') => string;
  filename: (state: TState, format: 'json' | 'csv' | 'markdown') => string;
}

/** Only these states produce a public route or a usable link. */
export const ACTIONABLE_STATUSES: ToolStatus[] = ['released', 'beta'];

export function isActionable(tool: ToolEntry): boolean {
  return ACTIONABLE_STATUSES.includes(tool.status);
}

/** Hidden tools never appear in any public surface. */
export function isPublic(tool: ToolEntry): boolean {
  return tool.status !== 'hidden';
}

/**
 * Validates a registry entry against the contract. Used by the
 * registry itself at module load and by tests/check-registry.mjs.
 * Returns [] when the entry is well formed.
 */
export function validateToolEntry(tool: ToolEntry): string[] {
  const errors: string[] = [];
  const req = (field: keyof ToolEntry) => {
    const v = tool[field];
    if (v === undefined || v === null || v === '') {
      errors.push(`${tool.slug || '(no slug)'}: missing required field "${field}"`);
    }
  };

  (
    [
      'slug',
      'name',
      'shortDescription',
      'category',
      'status',
      'version',
      'iconKey',
      'inputSensitivity',
      'route',
      'prdId',
    ] as Array<keyof ToolEntry>
  ).forEach(req);

  if (tool.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(tool.slug)) {
    errors.push(`${tool.slug}: slug must be lowercase kebab-case`);
  }
  if (tool.route !== `/tools/${tool.slug}`) {
    errors.push(`${tool.slug}: route must be "/tools/${tool.slug}", got "${tool.route}"`);
  }
  if (tool.category && !CATEGORIES.includes(tool.category)) {
    errors.push(`${tool.slug}: unknown category "${tool.category}"`);
  }
  if (tool.status && !TOOL_STATUSES.includes(tool.status)) {
    errors.push(`${tool.slug}: unknown status "${tool.status}"`);
  }
  if (tool.inputSensitivity && !INPUT_SENSITIVITIES.includes(tool.inputSensitivity)) {
    errors.push(`${tool.slug}: unknown inputSensitivity "${tool.inputSensitivity}"`);
  }
  if (!Array.isArray(tool.tags)) {
    errors.push(`${tool.slug}: tags must be an array`);
  }
  if (tool.version && !/^\d+\.\d+\.\d+$/.test(tool.version)) {
    errors.push(`${tool.slug}: version must be semver, got "${tool.version}"`);
  }
  return errors;
}
