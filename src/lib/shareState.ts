/**
 * URL-safe share state, only for small, non-sensitive inputs.
 *
 * 03-SHARED-PLATFORM.md calls for "URL-safe share state only for
 * small, non-sensitive inputs", and 00-PRODUCT-VISION.md principle 8
 * is explicit: "No user input leaves the browser unless the
 * interface explicitly says so." A share link is exactly that
 * explicit exception, but it is also the one mechanism in this
 * codebase that deliberately puts a tool's state somewhere outside
 * the browser tab: browser history, address-bar autocomplete, chat
 * apps, and server access logs all see a shared URL verbatim. This
 * module is the choke point that decides what is allowed to make
 * that trip, and it enforces two independent limits before anything
 * is encoded: a sensitivity gate (this is a privacy boundary) and a
 * size cap (this is a compatibility boundary).
 *
 * Encoding uses hand-rolled URL-safe base64 over UTF-8 bytes rather
 * than btoa/atob, which only handle Latin1 and would corrupt
 * non-ASCII input. No external dependency is added for this; the
 * whole implementation is TextEncoder/TextDecoder (standard, present
 * in every target runtime, browser and Node/Bun build alike) plus a
 * lookup table.
 */

import type { InputSensitivity } from '../data/types';

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += B64URL_ALPHABET[(chunk >> 18) & 63];
    result += B64URL_ALPHABET[(chunk >> 12) & 63];
    result += B64URL_ALPHABET[(chunk >> 6) & 63];
    result += B64URL_ALPHABET[chunk & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i] << 16;
    result += B64URL_ALPHABET[(chunk >> 18) & 63];
    result += B64URL_ALPHABET[(chunk >> 12) & 63];
  } else if (remaining === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += B64URL_ALPHABET[(chunk >> 18) & 63];
    result += B64URL_ALPHABET[(chunk >> 12) & 63];
    result += B64URL_ALPHABET[(chunk >> 6) & 63];
  }
  return result;
}

const B64URL_LOOKUP: ReadonlyMap<string, number> = new Map(
  Array.from(B64URL_ALPHABET, (char, index) => [char, index] as const),
);

/** Returns null for any input that is not valid URL-safe base64,
 * rather than throwing or decoding it partway. */
function base64UrlToBytes(input: string): Uint8Array | null {
  if (input.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9\-_]+$/.test(input)) return null;

  const bytes: number[] = [];
  let buffer = 0;
  let bitsInBuffer = 0;
  for (const char of input) {
    const value = B64URL_LOOKUP.get(char);
    if (value === undefined) return null;
    buffer = (buffer << 6) | value;
    bitsInBuffer += 6;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      bytes.push((buffer >> bitsInBuffer) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** Sensitivity ranked so "above low" is a single numeric comparison
 * instead of an enumerated list of forbidden values that could drift
 * out of sync with data/types.ts INPUT_SENSITIVITIES. */
const SENSITIVITY_RANK: Record<InputSensitivity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export type ShareEncodeFailureReason = 'sensitivity-too-high' | 'too-large' | 'serialize-error';
export type ShareDecodeFailureReason = 'missing-param' | 'malformed' | 'parse-error';
export type ShareUnavailableReason = 'unavailable';

export type ShareEncodeResult =
  | { ok: true; value: string }
  | { ok: false; reason: ShareEncodeFailureReason | ShareUnavailableReason; detail: string };

export type ShareDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ShareDecodeFailureReason | ShareUnavailableReason; detail: string };

export type ShareUrlWriteResult =
  | { ok: true }
  | { ok: false; reason: ShareUnavailableReason; detail: string };

const DEFAULT_PARAM_NAME = 'state';

/**
 * Real-world clients (older browsers, chat apps, some proxies and
 * shorteners) truncate or mangle query strings well before any
 * formal URL length limit. This cap keeps a shared link inside the
 * range that survives a copy-paste into the widest set of tools,
 * measured on the whole `param=value` query string, not just the
 * encoded payload, since that is what actually ships in the link.
 */
const MAX_QUERY_STRING_LENGTH = 1800;

/**
 * Encodes state for a share link. Refuses in two independent cases,
 * checked in this order:
 *
 * 1. Sensitivity: anything above `low` is refused outright. This is
 *    the privacy contract from 03-SHARED-PLATFORM.md, "URL-safe
 *    share state only for small, non-sensitive inputs", and it is
 *    enforced here in code, not left to each tool to remember. A URL
 *    is copied into browser history, chat logs, and server access
 *    logs verbatim and indefinitely; there is no call site or UI
 *    affordance that makes a `medium` or `high` sensitivity tool's
 *    input safe to put there, so this gate does not take an override.
 * 2. Size: even a `low` sensitivity input can still be too big for a
 *    URL to survive real clients intact (see MAX_QUERY_STRING_LENGTH).
 *    A tool over the cap should offer local save or export instead.
 */
export function encodeShareState<T>(
  state: T,
  sensitivity: InputSensitivity,
  paramName: string = DEFAULT_PARAM_NAME,
): ShareEncodeResult {
  if (SENSITIVITY_RANK[sensitivity] > SENSITIVITY_RANK.low) {
    return {
      ok: false,
      reason: 'sensitivity-too-high',
      detail:
        `refusing to encode state into a URL: this tool's inputSensitivity is "${sensitivity}", ` +
        'and share-by-URL is restricted to "none" or "low" (03-SHARED-PLATFORM.md). This is a ' +
        'privacy boundary, not a size limit, and it does not bend per call site. Offer export or ' +
        'local save instead.',
    };
  }

  let json: string;
  try {
    json = JSON.stringify(state);
  } catch (err) {
    return { ok: false, reason: 'serialize-error', detail: `state could not be serialized to JSON: ${String(err)}` };
  }

  const encoded = bytesToBase64Url(new TextEncoder().encode(json));
  const queryString = `${encodeURIComponent(paramName)}=${encoded}`;

  if (queryString.length > MAX_QUERY_STRING_LENGTH) {
    return {
      ok: false,
      reason: 'too-large',
      detail:
        `encoded state would produce a ${queryString.length} character query string, over the ` +
        `${MAX_QUERY_STRING_LENGTH} character cap. Real-world clients (older browsers, chat apps, ` +
        'some proxies) truncate or mangle URLs beyond roughly this length, which would silently ' +
        'corrupt the shared state for whoever opens the link. Use export or local save instead.',
    };
  }

  return { ok: true, value: encoded };
}

/**
 * Decodes a previously encoded share value. Round-trip safe with
 * encodeShareState, and every failure mode, missing input, invalid
 * base64, invalid UTF-8, invalid JSON, returns a typed failure
 * instead of throwing. Decoding is all-or-nothing: JSON.parse either
 * produces a complete value or fails, so there is no code path where
 * a tampered param partially populates state.
 */
export function decodeShareState<T>(encoded: string | null | undefined): ShareDecodeResult<T> {
  if (!encoded) {
    return { ok: false, reason: 'missing-param', detail: 'no share state was present to decode' };
  }

  const bytes = base64UrlToBytes(encoded);
  if (!bytes) {
    return { ok: false, reason: 'malformed', detail: 'share parameter is not valid URL-safe base64' };
  }

  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: `decoded bytes were not valid UTF-8: ${String(err)}` };
  }

  try {
    return { ok: true, value: JSON.parse(json) as T };
  } catch (err) {
    return { ok: false, reason: 'parse-error', detail: `decoded text was not valid JSON: ${String(err)}` };
  }
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Reads a share-state query parameter from the current URL. SSR
 * safe: on the server there is no `window.location` to read, so this
 * returns a typed `unavailable` failure rather than throwing during
 * Astro's build. A parameter that is simply absent is reported by
 * decodeShareState as `missing-param`, distinct from this function's
 * own `unavailable`, so a caller can tell "there was never a link"
 * apart from "this ran somewhere without a URL at all".
 */
export function readShareStateFromUrl<T>(paramName: string = DEFAULT_PARAM_NAME): ShareDecodeResult<T> {
  if (!isBrowser()) {
    return { ok: false, reason: 'unavailable', detail: 'window is not available (server render)' };
  }
  const params = new URLSearchParams(window.location.search);
  return decodeShareState<T>(params.get(paramName));
}

/**
 * Writes, or with `encoded: null`, clears a share-state query
 * parameter on the current URL using history.replaceState, so
 * copying the address bar produces a shareable link without a
 * navigation, reload, or new history entry. This function does not
 * itself apply the sensitivity or size checks; callers must run
 * state through encodeShareState first and only pass its result
 * here.
 */
export function writeShareStateToUrl(
  encoded: string | null,
  paramName: string = DEFAULT_PARAM_NAME,
): ShareUrlWriteResult {
  if (!isBrowser()) {
    return { ok: false, reason: 'unavailable', detail: 'window is not available (server render)' };
  }
  const url = new URL(window.location.href);
  if (encoded === null) {
    url.searchParams.delete(paramName);
  } else {
    url.searchParams.set(paramName, encoded);
  }
  window.history.replaceState(window.history.state, '', url.toString());
  return { ok: true };
}
