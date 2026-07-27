#!/usr/bin/env bash
# Canonical URL integrity gate.
#
# astro.config.mjs uses build.format 'file', so pages are emitted as
# <name>.html and Astro.url.pathname carries that extension. Every
# internal link and every registry route uses the EXTENSIONLESS form.
#
# Before this gate existed the site advertised /tools/x.html as its
# canonical and its og:url while linking only to /tools/x. Two URLs for
# one page, canonical pointing at the one nothing links to. The share
# sheet then started handing that URL to real people.
#
# This gate asserts canonical, og:url, and any share URL never carry the
# extension, and that canonical always matches the page it sits on.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d dist ]; then
  echo "dist/ missing. Run bun astro build first." >&2
  exit 2
fi

python3 - <<'PYEOF'
import os, re, sys

DIST = 'dist'
fail = []
checked = 0

CANON = re.compile(r'<link rel="canonical" href="([^"]+)"')
OGURL = re.compile(r'<meta property="og:url" content="([^"]+)"')
SHARE = re.compile(r'data-share-url="([^"]+)"')

for root, _dirs, files in os.walk(DIST):
    for name in files:
        if not name.endswith('.html'):
            continue
        path = os.path.join(root, name)
        html = open(path, encoding='utf-8', errors='ignore').read()
        rel = os.path.relpath(path, DIST)
        checked += 1

        for label, pattern in (('canonical', CANON), ('og:url', OGURL), ('share url', SHARE)):
            for url in pattern.findall(html):
                if url.endswith('.html'):
                    fail.append(f'{rel}: {label} carries a .html extension: {url}')
                if '/index' in url:
                    fail.append(f'{rel}: {label} points at an index path: {url}')

        # Canonical must correspond to this file's own route.
        m = CANON.search(html)
        if m:
            expected = '/' if rel == 'index.html' else '/' + rel[:-len('.html')]
            got = m.group(1).split('tools.nixfred.com', 1)[-1] or '/'
            if got != expected:
                fail.append(f'{rel}: canonical is {got}, expected {expected}')

print(f'html files checked: {checked}')
if fail:
    print('CANONICAL URL PROBLEMS:')
    for f in fail[:12]:
        print(f'  {f}')
    sys.exit(1)
print('canonical, og:url, and share urls all extensionless and self consistent')
PYEOF
