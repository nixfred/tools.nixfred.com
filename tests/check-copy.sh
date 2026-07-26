#!/usr/bin/env bash
# House style gate.
#
# Enforces the four rules that are easy to state and easy to drift on:
#   1. No dash punctuation. Periods and commas.
#   2. No curly quotes.
#   3. Capital C on Customer.
#   4. Tokens are law. No raw hex or rgba() outside tokens.css.
#
# DESIGN NOTE ON RULE 1, read before "improving" this gate.
# The whole difficulty is telling dash PUNCTUATION apart from the many
# legitimate hyphens in a codebase: kebab-case slugs like coming-soon,
# CSS custom properties like --accent, HTML comment markers, Astro
# frontmatter fences, markdown table rules, CLI flags, and arithmetic
# inside calc(). A gate that cries wolf on those gets switched off, and
# a switched off gate protects nothing. So the exclusions below are
# deliberate and each one is commented. Prefer a false negative here
# over a false positive.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
scanned=0

SRC_GLOBS=(--include='*.astro' --include='*.ts' --include='*.css' --include='*.md')

report() {
  local label="$1" hits="$2"
  if [ -n "$hits" ]; then
    echo "VIOLATION [$label]:"
    echo "$hits" | head -12
    echo
    fail=1
  fi
}

scanned=$(grep -rl '' src "${SRC_GLOBS[@]}" 2>/dev/null | wc -l | tr -d ' ')
echo "house style gate: scanning $scanned files under src/"

# ---------------------------------------------------------------------
# 1a. Em dash and en dash. No legitimate use, no exclusions needed.
# ---------------------------------------------------------------------
report "em dash or en dash" \
  "$(grep -rn $'—\|–' src "${SRC_GLOBS[@]}" 2>/dev/null || true)"

# ---------------------------------------------------------------------
# 1b. Spaced hyphen used as punctuation, the " - " pattern.
# Exclusions, in order of appearance in the filter chain:
#   calc(          arithmetic, "calc(100% - 20px)" is correct CSS
#   ^\s*---\s*$    Astro frontmatter fence and markdown frontmatter
#   ^[-|:+ ]+$     markdown table rules and ASCII box separators
#   ^\s*[-*] |^\s*#  markdown list bullets and headings
#   -->            HTML comment close
#   ^\s*\*         block comment continuation lines
# ---------------------------------------------------------------------
#
# REFINEMENT, learned the hard way on the first run of this gate. The
# original filter flagged `const remaining = bytes.length - i;` in
# src/lib/shareState.ts, which is arithmetic, not punctuation. Excluding
# arithmetic by pattern is a losing game, so the rule was inverted:
# scan only lines that are PROSE, meaning a comment, a markdown line, or
# a line carrying a quoted string. Code expressions carry no quote and
# are therefore never scanned. This trades a small false negative rate,
# an unquoted dash in raw template text, for zero false positives, which
# is the correct trade for a gate that must stay switched on.
spaced_hyphen=$(grep -rn ' - ' src "${SRC_GLOBS[@]}" 2>/dev/null |
  grep -E ':\s*(//|\*|<!--)|["'"'"'`]' |
  grep -v 'calc(' |
  grep -v -E ':\s*---\s*$' |
  grep -v -E ':[-|:+ ]+$' |
  grep -v -E ':\s*[-*] ' |
  grep -v -E ':\s*#' |
  grep -v -- '-->' || true)
report "spaced hyphen used as punctuation" "$spaced_hyphen"

# ---------------------------------------------------------------------
# 2. Curly quotes. Straight ASCII only, so a copied paragraph from a
# word processor cannot smuggle typography in.
#
# Escape hatch: a line ending in the marker below is skipped. There is
# exactly one legitimate reason to write a curly quote in this codebase,
# which is code that STRIPS curly quotes from visitor input so search
# matches anyway. That code must contain the characters it removes.
# The marker is deliberately ugly so it cannot be sprinkled around
# casually without a reviewer noticing.
# ---------------------------------------------------------------------
report "curly quote" \
  "$(grep -rn $'‘\|’\|“\|”' src "${SRC_GLOBS[@]}" 2>/dev/null |
    grep -v 'check-copy:allow-curly' || true)"

# ---------------------------------------------------------------------
# 3. Capital C on Customer. Matches the standalone word only, so
# "customers" inside a compound or a URL does not trip it. Word
# boundary on both sides, case sensitive.
# ---------------------------------------------------------------------
report "lowercase customer" \
  "$(grep -rnw 'customer' src "${SRC_GLOBS[@]}" 2>/dev/null || true)"

# ---------------------------------------------------------------------
# 4. Tokens are law. Color literals live in exactly one file.
# Two documented exemptions:
#   src/styles/tokens.css   the one legitimate home for color values
#   src/layouts/Base.astro  a single theme-color meta tag, because a
#                           meta tag cannot read a CSS custom property
# ---------------------------------------------------------------------
#
# The rgba pattern requires a DIGIT after the paren. Without it the gate
# flagged the sentence "no component ever hand rolls an rgba()" inside a
# comment in global.css, which is prose about the rule, not a breach of
# it. Matching an actual color value rather than the bare function name
# is the difference between a gate and a nuisance.
COLOR_RE='#[0-9a-fA-F]{3,8}\b|rgba?\([0-9]'

color_literals=$(grep -rnE "$COLOR_RE" \
  src/components src/layouts src/pages \
  --include='*.astro' --include='*.ts' --include='*.css' 2>/dev/null |
  grep -v '^src/layouts/Base.astro.*theme-color' || true)
report "raw color literal outside tokens.css" "$color_literals"

# A hex inside tokens.css is expected. A hex ANYWHERE else in styles is
# not, so styles/ is checked separately with tokens.css excluded.
stray_style_colors=$(grep -rnE "$COLOR_RE" src/styles \
  --include='*.css' 2>/dev/null |
  grep -v '^src/styles/tokens.css:' || true)
report "raw color literal in styles outside tokens.css" "$stray_style_colors"

if [ "$fail" -eq 1 ]; then
  echo "HOUSE STYLE: FAILED"
  exit 1
fi
echo "HOUSE STYLE: CLEAN"
