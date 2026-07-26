#!/usr/bin/env bash
# Internal link integrity gate (Stage 5, charter: no dead links).
# Scans every built HTML file for internal hrefs and verifies each
# resolves to a file in dist/ or a _redirects rule. Exits nonzero on
# any dead link.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d dist ]; then
  echo "dist/ missing. Run bun astro build first." >&2
  exit 2
fi

python3 - <<'EOF'
import os, re, sys

DIST = 'dist'
redirects = set()
if os.path.exists('public/_redirects'):
    for line in open('public/_redirects'):
        line = line.strip()
        if line and not line.startswith('#'):
            redirects.add(line.split()[0])

hrefs = set()
for root, _, files in os.walk(DIST):
    for name in files:
        if not name.endswith('.html'):
            continue
        html = open(os.path.join(root, name), encoding='utf-8', errors='ignore').read()
        for m in re.finditer(r'href="([^"#?]+)', html):
            h = m.group(1)
            if h.startswith('/') and not h.startswith('//'):
                hrefs.add(h.rstrip('/') or '/')

def resolves(h):
    if h in redirects:
        return True
    if h == '/':
        return os.path.exists(f'{DIST}/index.html')
    p = h.lstrip('/')
    return (
        os.path.exists(f'{DIST}/{p}')
        or os.path.exists(f'{DIST}/{p}.html')
        or os.path.exists(f'{DIST}/{p}/index.html')
    )

dead = sorted(h for h in hrefs if not resolves(h))
print(f'internal hrefs checked: {len(hrefs)}')
if dead:
    print('DEAD LINKS:')
    for d in dead:
        print(f'  {d}')
    sys.exit(1)
print('zero dead links')
EOF
