/**
 * Local project persistence with schema versioning.
 *
 * 03-SHARED-PLATFORM.md requires "Local project persistence with
 * schema versioning" and its acceptance criterion "Stored data
 * includes a version and can be cleared globally." Every tool saves
 * its own working state to localStorage so a visitor's work survives
 * a reload without any server ever seeing it (00-PRODUCT-VISION.md
 * principle 8: "No user input leaves the browser unless the
 * interface explicitly says so"). Schema versioning exists because a
 * tool's state shape will change across releases; a record saved
 * under an older shape must be upgraded in place or clearly set
 * aside, never silently misread as the current shape, which would
 * corrupt a tool's UI in a way that looks like a bug in the tool
 * rather than in the stored data.
 *
 * This module owns ONLY the storage mechanics: namespacing,
 * envelope, versioning, migration dispatch, and error containment.
 * It has no opinion about what any tool's state looks like (T is
 * generic and unconstrained) and carries no tool logic, per
 * 02-BUILD-CONTROL.md.
 */

/**
 * Every key this module writes lives under this prefix, and clearAll
 * removes exactly this prefix and nothing else. Keeping the prefix a
 * single exported constant means "which keys are ours" is defined in
 * one place instead of duplicated across save/remove/clearAll.
 */
export const STORAGE_PREFIX = 'nfw:';

/** Segment marking a quarantined record's key, distinct from any
 * real toolSlug so it can never collide with one. */
const QUARANTINE_SEGMENT = '__quarantine__';

/**
 * The envelope every persisted value is wrapped in. Tools never see
 * this shape directly; save() builds it and load() unwraps it. The
 * envelope carries exactly the metadata needed to detect and migrate
 * a stale shape without the tool having to parse its own history.
 */
export interface StoredRecord<T> {
  schemaVersion: number;
  savedAt: string;
  toolSlug: string;
  data: T;
}

/**
 * Lightweight metadata about a stored record, without the cost or
 * risk of running it through migration. Backs a "your saved
 * projects" picker that needs schemaVersion and savedAt for every
 * record up front; running full load() on every entry just to render
 * a list would waste work and would rewrite storage as a side effect
 * of merely listing it.
 */
export interface StoredSummary {
  key: string;
  schemaVersion: number;
  savedAt: string;
  /** False when the record exists but its envelope could not be
   * parsed. Per the "never silently dropped" rule this still appears
   * in the list instead of vanishing; a caller can offer to remove
   * it explicitly instead of it just disappearing from view. */
  readable: boolean;
}

export type PersistFailureReason =
  | 'unavailable'
  | 'quota-exceeded'
  | 'parse-error'
  | 'unmigratable'
  | 'write-error';

/**
 * Every read or write returns this instead of throwing, so a tool
 * can show the visitor "your data could not be saved" instead of an
 * uncaught exception. Nothing in this module throws across its
 * public boundary.
 */
export type PersistResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PersistFailureReason; detail: string };

/**
 * A single upgrade step: takes the previous shape (typed unknown,
 * because the previous shape is by definition not the tool's current
 * type) and returns the next version's shape. Keyed by the version it
 * upgrades FROM in registerMigrations, so migrating a v1 record runs
 * the v1 step, a v2 record runs the v2 step, and so on until
 * schemaVersion reaches currentVersion.
 */
export type MigrationStep = (old: unknown) => unknown;

/**
 * A tool's full upgrade path, one step per version boundary. Passed
 * to registerMigrations as a single table rather than one call per
 * step, so a tool's whole migration history stays legible in one
 * place in its own module.
 */
export type MigrationTable = Record<number, MigrationStep>;

const migrationRegistry = new Map<string, MigrationTable>();

/**
 * Registers a tool's upgrade path. Call this once, at tool module
 * load, before any load() call for that tool can rely on it.
 * Re-registering the same toolSlug replaces its table; a tool's
 * migrations are the ground truth for that tool, not additive across
 * calls.
 */
export function registerMigrations(toolSlug: string, table: MigrationTable): void {
  migrationRegistry.set(toolSlug, table);
}

/**
 * True only when a real, reachable localStorage exists. Astro
 * prerenders this module on the server (SSR build), where `window`
 * is undefined; some browser contexts (locked-down iframes, certain
 * privacy modes) define `window` but throw on touching
 * `localStorage` itself. Both cases are treated as "unavailable"
 * rather than crashing the build or the page.
 */
function isBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function unavailable<T>(): PersistResult<T> {
  return {
    ok: false,
    reason: 'unavailable',
    detail: 'localStorage is not available (server render, or storage blocked in this browser context)',
  };
}

function storageKey(toolSlug: string, key: string): string {
  return `${STORAGE_PREFIX}${toolSlug}:${key}`;
}

function quarantineKey(toolSlug: string, key: string): string {
  return `${STORAGE_PREFIX}${QUARANTINE_SEGMENT}:${toolSlug}:${key}:${Date.now()}`;
}

function isStoredRecordShape(value: unknown): value is StoredRecord<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.schemaVersion === 'number' &&
    typeof v.savedAt === 'string' &&
    typeof v.toolSlug === 'string' &&
    'data' in v
  );
}

/**
 * Sets a record aside instead of leaving it live under its normal
 * key, and never lets a storage failure while quarantining escalate
 * into a thrown exception: the caller of load() already receives a
 * typed failure either way, so the original data is never mistaken
 * for valid regardless of whether this best-effort copy succeeds.
 */
function quarantine(toolSlug: string, key: string, raw: string, reason: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(
      quarantineKey(toolSlug, key),
      JSON.stringify({ quarantinedAt: new Date().toISOString(), reason, raw }),
    );
    window.localStorage.removeItem(storageKey(toolSlug, key));
  } catch {
    // Best-effort: if storage is too full to even write the
    // quarantine copy, the load() caller still gets a typed failure
    // and the stale record is simply left where it was.
  }
}

/**
 * Saves data under a tool-namespaced key, wrapped in the versioned
 * envelope. SSR safe: on the server this is a typed no-op rather
 * than a crash, since Astro's build imports this module without ever
 * having a browser to write to.
 */
export function save<T>(
  toolSlug: string,
  key: string,
  data: T,
  schemaVersion: number,
): PersistResult<void> {
  if (!isBrowser()) return unavailable();

  const record: StoredRecord<T> = {
    schemaVersion,
    savedAt: new Date().toISOString(),
    toolSlug,
    data,
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch (err) {
    return { ok: false, reason: 'write-error', detail: `state could not be serialized: ${String(err)}` };
  }

  try {
    window.localStorage.setItem(storageKey(toolSlug, key), serialized);
    return { ok: true, value: undefined };
  } catch (err) {
    // QuotaExceededError is a DOMException in every evergreen
    // browser; it is caught here so it never unwinds into a tool's
    // save button handler, which by this module's contract must
    // never see a thrown exception.
    const isQuota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return { ok: false, reason: isQuota ? 'quota-exceeded' : 'write-error', detail: String(err) };
  }
}

/**
 * Loads data for a tool, migrating it forward to currentVersion when
 * an upgrade path is registered for every version boundary in
 * between, and quarantining it (never discarding it) when the path
 * is incomplete or the record is newer than this build understands.
 * Returns { ok: true, value: null } when nothing is stored yet; that
 * is a normal empty state, not a failure.
 */
export function load<T>(
  toolSlug: string,
  key: string,
  currentVersion: number,
): PersistResult<T | null> {
  if (!isBrowser()) return unavailable();

  const raw = window.localStorage.getItem(storageKey(toolSlug, key));
  if (raw === null) {
    return { ok: true, value: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    quarantine(toolSlug, key, raw, `unparsable JSON: ${String(err)}`);
    return {
      ok: false,
      reason: 'parse-error',
      detail: `stored record for "${toolSlug}:${key}" was not valid JSON and has been quarantined`,
    };
  }

  if (!isStoredRecordShape(parsed)) {
    quarantine(toolSlug, key, raw, 'parsed value did not match the StoredRecord envelope');
    return {
      ok: false,
      reason: 'parse-error',
      detail: `stored record for "${toolSlug}:${key}" did not match the expected envelope and has been quarantined`,
    };
  }

  const { schemaVersion, data } = parsed;

  if (schemaVersion === currentVersion) {
    return { ok: true, value: data as T };
  }

  if (schemaVersion > currentVersion) {
    quarantine(
      toolSlug,
      key,
      raw,
      `stored schemaVersion ${schemaVersion} is newer than currentVersion ${currentVersion}; refusing to downgrade`,
    );
    return {
      ok: false,
      reason: 'unmigratable',
      detail: `record is from a newer schema (v${schemaVersion}) than this build expects (v${currentVersion}); it has been quarantined`,
    };
  }

  const table = migrationRegistry.get(toolSlug);
  let migrated: unknown = data;
  for (let v = schemaVersion; v < currentVersion; v++) {
    const step = table?.[v];
    if (!step) {
      quarantine(toolSlug, key, raw, `no migration registered for step v${v} -> v${v + 1}`);
      return {
        ok: false,
        reason: 'unmigratable',
        detail: `no migration from v${v} to v${v + 1} is registered for "${toolSlug}"; the record has been quarantined instead of misread as the current shape`,
      };
    }
    migrated = step(migrated);
  }

  // The now-migrated record replaces the old one at rest, so the
  // next load is a straight version match instead of re-running the
  // same migration chain on every read. The re-save is best effort:
  // if it fails (e.g. quota) the caller still gets the correctly
  // migrated in-memory value this call.
  save(toolSlug, key, migrated as T, currentVersion);
  return { ok: true, value: migrated as T };
}

/**
 * Deletes a single stored record for a tool. Succeeds even when
 * nothing was stored under that key, since the end state a caller
 * wants ("this key holds nothing") already holds.
 */
export function remove(toolSlug: string, key: string): PersistResult<void> {
  if (!isBrowser()) return unavailable();
  try {
    window.localStorage.removeItem(storageKey(toolSlug, key));
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, reason: 'write-error', detail: String(err) };
  }
}

/**
 * Lists every record saved for one tool, as summaries only. This
 * never runs migration and never rewrites storage; it exists purely
 * so a "your saved projects" surface can render without the cost or
 * side effects of a full load() per entry.
 */
export function listForTool(toolSlug: string): PersistResult<StoredSummary[]> {
  if (!isBrowser()) return unavailable();

  const prefix = storageKey(toolSlug, '');
  const summaries: StoredSummary[] = [];

  for (let i = 0; i < window.localStorage.length; i++) {
    const fullKey = window.localStorage.key(i);
    if (!fullKey || !fullKey.startsWith(prefix)) continue;

    const recordKey = fullKey.slice(prefix.length);
    const raw = window.localStorage.getItem(fullKey);
    if (raw === null) continue;

    try {
      const parsed = JSON.parse(raw);
      if (isStoredRecordShape(parsed)) {
        summaries.push({
          key: recordKey,
          schemaVersion: parsed.schemaVersion,
          savedAt: parsed.savedAt,
          readable: true,
        });
        continue;
      }
    } catch {
      // fall through to the unreadable branch below
    }
    summaries.push({ key: recordKey, schemaVersion: -1, savedAt: '', readable: false });
  }

  return { ok: true, value: summaries };
}

/**
 * Wipes every key this module has ever written, across every tool,
 * including quarantined records (they live under the same prefix on
 * purpose). This is the mechanism behind 03-SHARED-PLATFORM.md's
 * acceptance criterion "Stored data ... can be cleared globally":
 * one call, one prefix, nothing outside it touched. Returns the
 * count of keys removed so a "data cleared" confirmation can say
 * something concrete instead of a bare acknowledgement.
 */
export function clearAll(): PersistResult<number> {
  if (!isBrowser()) return unavailable();

  const toRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(STORAGE_PREFIX)) toRemove.push(k);
  }

  try {
    toRemove.forEach((k) => window.localStorage.removeItem(k));
    return { ok: true, value: toRemove.length };
  } catch (err) {
    return { ok: false, reason: 'write-error', detail: String(err) };
  }
}
