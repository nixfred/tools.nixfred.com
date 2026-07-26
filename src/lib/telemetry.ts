/**
 * Telemetry.
 *
 * 03-SHARED-PLATFORM.md: "Lightweight event hooks that do not capture
 * pasted content."
 *
 * THE DESIGN RULE: this module is structurally incapable of carrying
 * user content, and that is enforced by the type system and a runtime
 * guard rather than by a comment asking future authors to be careful.
 * A comment is a request. A closed string union is a wall.
 *
 * There is no free-form string field anywhere in an event payload. The
 * only strings permitted are drawn from a fixed vocabulary declared in
 * this file. Numbers and booleans pass freely, because a count or a
 * flag cannot leak a prompt.
 *
 * There is also NO TRANSPORT, and you must not add one. A network sink
 * would violate 00-PRODUCT-VISION.md principle 8 ("No user input leaves
 * the browser unless the interface explicitly says so") and would be
 * caught by tests/check-safety.sh, which greps the built output for
 * fetch and XMLHttpRequest. The default sink is a no-op. In development
 * a console sink can be attached by hand for debugging.
 */

/**
 * The complete vocabulary of event names. Adding an event means adding
 * it here, which makes the set of things this site can observe
 * reviewable in one place.
 */
export const EVENT_NAMES = [
  'tool.opened',
  'tool.sample_loaded',
  'tool.reset',
  'tool.validated',
  'tool.exported',
  'catalog.searched',
  'catalog.filtered',
  'catalog.cleared',
  'storage.saved',
  'storage.cleared',
  'storage.quota_exceeded',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * The complete vocabulary of string VALUES a payload may carry. If a
 * value is not in this list, it cannot be sent. This is the mechanism
 * that makes content capture impossible: a pasted prompt, a filename, a
 * Customer name, or a log line is by definition not a member of this
 * union.
 */
export const EVENT_TOKENS = [
  // Categories, mirroring src/data/types.ts CATEGORIES.
  'Design',
  'Build',
  'Evaluate',
  'Operate',
  'Understand',
  // Export formats.
  'json',
  'csv',
  'markdown',
  // Outcomes.
  'ok',
  'invalid',
  'error',
  'empty',
  // Sensitivity tiers.
  'none',
  'low',
  'medium',
  'high',
] as const;

export type EventToken = (typeof EVENT_TOKENS)[number];

/**
 * A payload value. Note what is absent: `string`. Only the closed
 * `EventToken` union, numbers, and booleans are representable.
 */
export type EventValue = EventToken | number | boolean;

export type EventPayload = Readonly<Record<string, EventValue>>;

export interface WorkbenchEvent {
  readonly name: EventName;
  readonly payload: EventPayload;
}

export type EventHandler = (event: WorkbenchEvent) => void;

const handlers = new Map<EventName, Set<EventHandler>>();

const tokenSet: ReadonlySet<string> = new Set(EVENT_TOKENS);

/**
 * Runtime backstop for the type-level guarantee.
 *
 * TypeScript types vanish at runtime, and this module can be called
 * from a plain inline script where no checking happened at all. So
 * every payload is re-validated here, and any string that is not a
 * known token is DROPPED rather than sanitized or truncated. Dropping
 * is deliberate: a truncated prompt is still a leaked prompt.
 */
function scrubPayload(payload: EventPayload): {
  clean: Record<string, EventValue>;
  dropped: string[];
} {
  const clean: Record<string, EventValue> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(payload ?? {})) {
    const type = typeof value;
    if (type === 'number' || type === 'boolean') {
      clean[key] = value as number | boolean;
      continue;
    }
    if (type === 'string' && tokenSet.has(value as string)) {
      clean[key] = value as EventToken;
      continue;
    }
    dropped.push(key);
  }

  return { clean, dropped };
}

/** Subscribe to an event. Returns an unsubscribe function. */
export function on(name: EventName, handler: EventHandler): () => void {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name)!.add(handler);
  return () => {
    handlers.get(name)?.delete(handler);
  };
}

/**
 * Emit an event. Never throws, because instrumentation must not be able
 * to break the tool it is instrumenting. A handler that throws is
 * isolated and the remaining handlers still run.
 */
export function emit(name: EventName, payload: EventPayload = {}): void {
  if (typeof window === 'undefined') return;
  if (!EVENT_NAMES.includes(name)) return;

  const { clean, dropped } = scrubPayload(payload);

  if (dropped.length && import.meta.env?.DEV) {
    // Loud in development, silent in production. A dropped key is
    // almost always a programming mistake worth seeing immediately.
    console.warn(
      `[telemetry] dropped non token payload keys on "${name}": ${dropped.join(', ')}. ` +
        'Only numbers, booleans, and declared EVENT_TOKENS may be sent.',
    );
  }

  const event: WorkbenchEvent = { name, payload: Object.freeze(clean) };

  handlers.get(name)?.forEach((handler) => {
    try {
      handler(event);
    } catch {
      // An instrumentation failure is never a user facing failure.
    }
  });
}

/** Remove every handler. Used by tests. */
export function resetHandlers(): void {
  handlers.clear();
}

/**
 * Development helper. Attaches a console sink so events are visible
 * while building a tool. Deliberately NOT called anywhere by default,
 * and deliberately not a network sink.
 */
export function attachConsoleSink(): () => void {
  const offs = EVENT_NAMES.map((name) =>
    on(name, (event) => console.info('[telemetry]', event.name, event.payload)),
  );
  return () => offs.forEach((off) => off());
}
