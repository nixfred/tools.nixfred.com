/**
 * Tool UI kit barrel.
 *
 * The shared component surface every tool builds against, per the
 * 03-SHARED-PLATFORM.md requirement for "consistent input, result,
 * assumption, help, warning, and export components".
 *
 * A tool should import from here rather than reaching for individual
 * files, so that the kit's surface stays reviewable and a component can
 * be relocated without touching every tool.
 *
 * These are Astro components, so they are imported for rendering, not
 * called as functions.
 */

export { default as Field } from './Field.astro';
export { default as ResultPanel } from './ResultPanel.astro';
export { default as AssumptionList } from './AssumptionList.astro';
export { default as HelpNote } from './HelpNote.astro';
export { default as WarningNote } from './WarningNote.astro';
export { default as ExportBar } from './ExportBar.astro';
export { default as EmptyState } from './EmptyState.astro';
export { default as PrivacyNotice } from './PrivacyNotice.astro';
export { default as ErrorBoundary } from './ErrorBoundary.astro';
