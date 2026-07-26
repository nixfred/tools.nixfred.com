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
#
# SECOND REFINEMENT, 2026-07-26. The prose-only rule above still fired
# on arithmetic, because arithmetic lives inside template literals and
# quoted strings, which is exactly what the rule treats as prose.
# Real examples it wrongly flagged: `all.length - 1` inside a template
# literal, `group.p50 - sc.effectiveP50`, and `1 - alpha/m` written
# inside an explanatory comment.
#
# Distinguishing "word minus word" from "identifier minus identifier"
# is not possible lexically, so the discriminator is CONTEXT:
#   1. Template interpolations `${...}` are code. Strip them, then scan.
#   2. A subtraction flanked by identifier or number characters, on a
#      line that also carries another arithmetic or assignment operator,
#      is arithmetic and not punctuation.
# Bash cannot express that cleanly, so this one check is Python. The
# other checks stay as grep because they do not need the nuance.
spaced_hyphen=$(python3 - <<'PYEOF'
import os, re, sys

ROOT = '.'
EXTS = ('.astro', '.ts', '.css', '.md')
PROSE = re.compile(r'^\s*(//|\*|<!--)')
QUOTED = re.compile(r'["\'`]')
INTERP = re.compile(r'\$\{[^}]*\}')
ARITH = re.compile(r'[\w)\].] - [\w(]')
OPS = re.compile(r'[*/+=<>]|Math\.')
SKIP_LINE = re.compile(r'calc\(|-->|^\s*---\s*$|^[-|:+ ]+$|^\s*[-*] |^\s*#')

hits = []
for base, dirs, files in os.walk(os.path.join(ROOT, 'src')):
    for name in files:
        if not name.endswith(EXTS):
            continue
        path = os.path.join(base, name)
        try:
            lines = open(path, encoding='utf-8', errors='ignore').read().split('\n')
        except OSError:
            continue
        for i, raw in enumerate(lines, 1):
            # Code is not prose. Only comments, markdown, and lines
            # carrying a quoted string are candidates at all.
            if not (PROSE.search(raw) or QUOTED.search(raw)):
                continue
            if SKIP_LINE.search(raw.strip()):
                continue
            # Template interpolations are code, so remove them first.
            line = INTERP.sub('', raw)
            if ' - ' not in line:
                continue
            # STRIP THE COMMENT MARKER BEFORE TESTING FOR OPERATORS.
            # Caught by a negative control: `//` contains a forward
            # slash, so every single comment line looked like it
            # contained an arithmetic operator, and the gate silently
            # stopped catching real prose dashes in comments. A gate
            # that quietly passes everything is the worst outcome
            # available, so this line is load bearing.
            body = re.sub(r'^\s*(//+|/\*|\*/|\*|<!--)', '', line)
            # Arithmetic, not punctuation.
            if ARITH.search(body) and OPS.search(body):
                continue
            hits.append('%s:%d:%s' % (os.path.relpath(path, ROOT), i, raw.strip()[:120]))

sys.stdout.write('\n'.join(hits))
PYEOF
)
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
# THIRD REFINEMENT, 2026-07-26. A bare hex pattern also matches CSS id
# selectors whose name happens to start with hex letters. The real case
# that fired: the string '#add-kind-select', where "add" is three valid
# hex digits. A color literal is never followed by a letter, digit,
# underscore, or hyphen, so a negative lookahead separates them exactly.
# grep -E has no lookahead, so this check is Python too.
color_scan=$(python3 - <<'PYEOF'
import os, re, sys

# A real color: # then exactly 3, 4, 6, or 8 hex digits, NOT followed by
# an identifier character. Plus rgb()/rgba() with a numeric first arg.
COLOR = re.compile(r'#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])|rgba?\(\s*[0-9]')
DIRS = ['src/components', 'src/layouts', 'src/pages', 'src/styles', 'src/lib']
EXTS = ('.astro', '.ts', '.css')

hits = []
for d in DIRS:
    for base, _dirs, files in os.walk(d):
        for name in files:
            if not name.endswith(EXTS):
                continue
            path = os.path.join(base, name)
            # tokens.css is the one legitimate home for color values.
            if path.replace(os.sep, '/') == 'src/styles/tokens.css':
                continue
            try:
                lines = open(path, encoding='utf-8', errors='ignore').read().split('\n')
            except OSError:
                continue
            for i, raw in enumerate(lines, 1):
                if not COLOR.search(raw):
                    continue
                # Base.astro carries exactly one documented theme-color
                # meta tag, because a meta tag cannot read a CSS variable.
                if path.endswith('Base.astro') and 'theme-color' in raw:
                    continue
                hits.append('%s:%d:%s' % (path.replace(os.sep, '/'), i, raw.strip()[:120]))

sys.stdout.write('\n'.join(hits))
PYEOF
)
report "raw color literal outside tokens.css" "$color_scan"

if [ "$fail" -eq 1 ]; then
  echo "HOUSE STYLE: FAILED"
  exit 1
fi
echo "HOUSE STYLE: CLEAN"
