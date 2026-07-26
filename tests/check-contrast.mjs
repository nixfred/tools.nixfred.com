/**
 * WCAG CONTRAST GATE.
 *
 * 03-SHARED-PLATFORM.md acceptance criterion: "Shared components pass
 * keyboard and contrast checks."
 *
 * Run: bun tests/check-contrast.mjs
 *
 * This gate parses src/styles/tokens.css, resolves the token graph,
 * and computes WCAG 2.1 contrast ratios from the actual sRGB
 * luminance formula. No eyeballing, no approximation, no hardcoded
 * expected values that could drift away from the stylesheet.
 *
 * Thresholds (WCAG 2.1 AA):
 *   4.5  normal body text, SC 1.4.3
 *   3.0  large text at 24px or 18.66px bold, SC 1.4.3
 *   3.0  non text UI indicators such as status dots, category dots,
 *        focus rings, and control borders, SC 1.4.11
 * Decorative hairlines carry no requirement under 1.4.11 and are
 * reported as advisory rather than asserted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS_PATH = join(ROOT, 'src/styles/tokens.css');

/* ==================================================================
   1. PARSE tokens.css
   ================================================================== */

const source = readFileSync(TOKENS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** selector text mapped to its custom property declarations, in file order. */
const blocks = [];
for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = match[1].trim();
  const decls = new Map();
  for (const decl of match[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    decls.set(decl[1].trim(), decl[2].trim());
  }
  if (decls.size) blocks.push({ selector, decls });
}

if (!blocks.length) {
  console.log(`could not parse any custom properties from ${TOKENS_PATH}`);
  console.log('CONTRAST: UNVERIFIED');
  process.exit(1);
}

/**
 * Scope construction. Every block whose selector list contains :root
 * lands in the global scope, which is where the raw palette and the
 * chassis surface mapping both live. A named surface scope is the
 * global scope with that surface block layered on top, which is
 * exactly what the cascade does at runtime.
 */
function scopeFor(surfaceSelector) {
  const scope = new Map();
  for (const block of blocks) {
    const selectors = block.selector.split(',').map((s) => s.trim());
    const isGlobal = selectors.some((s) => s === ':root');
    const isSurface = surfaceSelector !== null && selectors.some((s) => s === surfaceSelector);
    if (isGlobal || isSurface) {
      for (const [k, v] of block.decls) scope.set(k, v);
    }
  }
  return scope;
}

const SURFACES = {
  chassis: scopeFor("[data-surface='chassis']"),
  panel: scopeFor("[data-surface='panel']"),
};

/**
 * Resolves a token to a literal value, following var() indirection.
 * The surface blocks are one level deep (--bg: var(--chassis-950)),
 * the depth cap is headroom, not license for a deeper graph.
 */
function resolve(scope, name, depth = 0) {
  if (depth > 6) return null;
  const raw = scope.get(name);
  if (raw === undefined) return null;
  const varMatch = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/i);
  if (varMatch) return resolve(scope, varMatch[1], depth + 1);
  return raw;
}

/* ==================================================================
   2. COLOR MATH
   ================================================================== */

/** Returns {r,g,b,a} with channels 0 to 255 and alpha 0 to 1, or null. */
function parseColor(value) {
  if (!value) return null;
  const v = value.trim();

  const hex = v.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }

  const fn = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (fn) {
    return {
      r: Number(fn[1]),
      g: Number(fn[2]),
      b: Number(fn[3]),
      a: fn[4] === undefined ? 1 : Number(fn[4]),
    };
  }
  return null;
}

/**
 * Simple alpha compositing in the sRGB space the browser paints in.
 * An alpha token measured on its own is meaningless, so any token
 * carrying alpha is flattened over its actual background first.
 */
function composite(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** WCAG 2.1 relative luminance, including the sRGB linearization step. */
function luminance(color) {
  const channel = (raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.1 contrast ratio. Order independent. */
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/* ------------------------------------------------------------------
   Self test of the math. The formula is the whole point of this file,
   so it is checked against three published reference values before it
   is trusted with anything. White on black is exactly 21, a color on
   itself is exactly 1, and #767676 on white is the canonical 4.54
   boundary case from the WCAG understanding documents.
   ------------------------------------------------------------------ */
const mathErrors = [];
const white = { r: 255, g: 255, b: 255, a: 1 };
const black = { r: 0, g: 0, b: 0, a: 1 };
const gray = { r: 118, g: 118, b: 118, a: 1 };
if (Math.abs(contrast(white, black) - 21) > 0.001) mathErrors.push('white on black is not 21');
if (Math.abs(contrast(white, white) - 1) > 0.001) mathErrors.push('white on white is not 1');
if (Math.abs(contrast(gray, white) - 4.54) > 0.01) mathErrors.push('#767676 on white is not 4.54');
if (mathErrors.length) {
  console.log('CONTRAST MATH SELF TEST FAILED:');
  for (const e of mathErrors) console.log(`  ${e}`);
  console.log('CONTRAST: UNVERIFIED');
  process.exit(1);
}

/* ==================================================================
   3. THE PAIR TABLE
   ================================================================== */

const NORMAL_TEXT = { value: 4.5, why: 'normal body text, SC 1.4.3' };
const LARGE_TEXT = { value: 3.0, why: 'large text at 24px or 18.66px bold, SC 1.4.3' };
const UI_INDICATOR = { value: 3.0, why: 'non text UI indicator, SC 1.4.11' };
const ADVISORY = { value: 0, why: 'reported only, no WCAG requirement applies' };

const rows = [];
const unresolved = [];

/**
 * Registers one measurement. `fgToken` and `bgToken` are token names.
 * `over` names an optional wash token composited between them, which
 * is how energized panel fills get measured rather than skipped.
 */
function pair(surfaceName, fgToken, bgToken, threshold, options = {}) {
  const scope = SURFACES[surfaceName];
  const fgRaw = resolve(scope, fgToken);
  const bgRaw = resolve(scope, bgToken);
  const fg = parseColor(fgRaw);
  let bg = parseColor(bgRaw);

  if (!fg || !bg) {
    unresolved.push(
      `${surfaceName}: ${!fg ? fgToken : bgToken} did not resolve to a color ` +
        `(got ${!fg ? String(fgRaw) : String(bgRaw)})`,
    );
    return;
  }

  let bgLabel = bgToken;
  if (options.over) {
    const washRaw = resolve(scope, options.over);
    const wash = parseColor(washRaw);
    if (!wash) {
      unresolved.push(`${surfaceName}: ${options.over} did not resolve to a color`);
      return;
    }
    bg = composite(wash, bg);
    bgLabel = `${options.over} over ${bgToken}`;
  }

  // A foreground carrying alpha is composited over its background too,
  // otherwise the ratio would describe a color that never paints.
  const flatFg = fg.a < 1 ? composite(fg, bg) : fg;

  rows.push({
    surface: surfaceName,
    pair: `${fgToken} on ${bgLabel}`,
    ratio: contrast(flatFg, bg),
    threshold,
    advisory: threshold === ADVISORY,
  });
}

for (const surface of ['chassis', 'panel']) {
  // Text on the surface ground.
  pair(surface, '--text', '--bg', NORMAL_TEXT);
  pair(surface, '--text-muted', '--bg', NORMAL_TEXT);
  pair(surface, '--text-faint', '--bg', NORMAL_TEXT);
  pair(surface, '--accent', '--bg', NORMAL_TEXT);

  // Text on a panel sitting on that ground.
  pair(surface, '--text', '--panel', NORMAL_TEXT);
  pair(surface, '--text-muted', '--panel', NORMAL_TEXT);
  pair(surface, '--accent', '--panel', NORMAL_TEXT);
  pair(surface, '--text', '--panel-raised', NORMAL_TEXT);

  // Status tokens. Judged as indicators because their shipped use is
  // the status dot. If a status token is ever used for small label
  // text it must clear 4.5, which the advisory rows below report.
  for (const token of ['--status-live', '--status-beta', '--status-queued', '--status-alert']) {
    pair(surface, token, '--bg', UI_INDICATOR);
  }

  // Category dots, same indicator reasoning.
  for (const token of ['--cat-design', '--cat-build', '--cat-evaluate', '--cat-operate', '--cat-understand']) {
    pair(surface, token, '--bg', UI_INDICATOR);
  }

  // Alpha tokens, composited rather than skipped.
  pair(surface, '--text', '--bg', NORMAL_TEXT, { over: '--signal-wash' });
  pair(surface, '--accent', '--bg', NORMAL_TEXT, { over: '--signal-wash' });
  pair(surface, '--text', '--bg', NORMAL_TEXT, { over: '--signal-wash-strong' });
  pair(surface, '--accent', '--bg', NORMAL_TEXT, { over: '--signal-wash-strong' });
  // Focus and active edges are state indicators, so 1.4.11 applies.
  pair(surface, '--signal-edge', '--bg', UI_INDICATOR);
  pair(surface, '--signal-edge', '--panel', UI_INDICATOR);
}

// Advisory rows. Reported every run, never fail the run, so that a
// number nobody is asserting can never be mistaken for a pass.
pair('chassis', '--text-dim', '--bg', ADVISORY);
pair('panel', '--text-dim', '--bg', ADVISORY);
pair('chassis', '--accent-deep', '--bg', ADVISORY);
pair('chassis', '--line', '--bg', ADVISORY);
pair('chassis', '--line-strong', '--bg', ADVISORY);
pair('chassis', '--line-faint', '--bg', ADVISORY);
for (const token of ['--status-live', '--status-beta', '--status-queued', '--status-alert']) {
  pair('chassis', token, '--bg', ADVISORY);
}
// Large text tier, reported so a designer can see which dim tokens are
// still usable at display sizes.
pair('chassis', '--text-dim', '--panel', LARGE_TEXT);

/* ==================================================================
   4. REPORT
   ================================================================== */

const required = rows.filter((r) => !r.advisory);
const advisory = rows.filter((r) => r.advisory);
const failed = required.filter((r) => r.ratio < r.threshold.value);

console.log(`token pairs measured: ${rows.length} (${required.length} required, ${advisory.length} advisory)`);
console.log(`source: src/styles/tokens.css, ${blocks.length} declaration blocks parsed`);
console.log('');

const widest = Math.max(...rows.map((r) => r.pair.length), 10);
const surfaceWidth = Math.max(...rows.map((r) => r.surface.length), 7);

function printRow(surface, pairText, ratio, threshold, verdict) {
  console.log(
    `  ${surface.padEnd(surfaceWidth)}  ${pairText.padEnd(widest)}  ` +
      `${ratio.padStart(6)}  ${threshold.padStart(9)}  ${verdict}`,
  );
}

printRow('SURFACE', 'PAIR', 'RATIO', 'THRESHOLD', 'VERDICT');
printRow('-'.repeat(surfaceWidth), '-'.repeat(widest), '------', '---------', '-------');
for (const r of required) {
  printRow(
    r.surface,
    r.pair,
    r.ratio.toFixed(2),
    r.threshold.value.toFixed(1),
    r.ratio >= r.threshold.value ? 'PASS' : 'FAIL',
  );
}
if (advisory.length) {
  console.log('');
  console.log('  advisory, not asserted:');
  for (const r of advisory) {
    printRow(r.surface, r.pair, r.ratio.toFixed(2), 'none', 'ADVISORY');
  }
}

console.log('');
console.log('thresholds applied:');
console.log(`  ${NORMAL_TEXT.value.toFixed(1)}  ${NORMAL_TEXT.why}`);
console.log(`  ${LARGE_TEXT.value.toFixed(1)}  ${LARGE_TEXT.why}`);
console.log(`  ${UI_INDICATOR.value.toFixed(1)}  ${UI_INDICATOR.why}`);

if (unresolved.length) {
  console.log('');
  console.log(`UNRESOLVED TOKENS (${unresolved.length}), these pairs were NOT verified:`);
  for (const u of unresolved) console.log(`  ${u}`);
}

console.log('');
if (failed.length || unresolved.length) {
  if (failed.length) {
    console.log(`CONTRAST: FAILED (${failed.length} required pairs below threshold)`);
    for (const r of failed) {
      console.log(
        `  ${r.surface}: ${r.pair} is ${r.ratio.toFixed(2)}, needs ${r.threshold.value.toFixed(1)} for ${r.threshold.why}`,
      );
    }
  }
  if (unresolved.length) {
    console.log('CONTRAST: UNVERIFIED for the tokens listed above. A missing token is not a pass.');
  }
  process.exit(1);
}
console.log(`CONTRAST: CLEAN, ${required.length} required pairs at or above threshold`);
