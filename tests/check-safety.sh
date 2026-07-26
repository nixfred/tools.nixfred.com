#!/usr/bin/env bash
# Static safety gate (00_MASTER_BRIEF hard rules + 10_QA checklist).
# Fails the build if the dist output ever grows payment fields, form
# actions, external scripts, or credential inputs.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d dist ]; then
  echo "dist/ missing. Run bun astro build first." >&2
  exit 2
fi

fail=0

check() {
  local label="$1" pattern="$2"
  local hits
  hits=$(grep -rInE "$pattern" dist --include='*.html' --include='*.js' || true)
  if [ -n "$hits" ]; then
    echo "VIOLATION [$label]:"
    echo "$hits" | head -8
    fail=1
  fi
}

# Forms must never submit anywhere
check "form action" '<form[^>]+action='
# No payment fields, ever
check "card fields" 'autocomplete="cc-|name="card|name="cvv|name="cvc|placeholder="[^"]*card number'
# No credential inputs
check "password input" 'type="password"'
# No payment processors
check "payment processors" 'stripe|paypal|braintree|checkout\.com|squareup'
# No external scripts or styles (self contained site, CSP by diet)
check "external script" '<script[^>]+src="https?://'
check "external style" '<link[^>]+href="https?://[^"]+\.css'

# fetch/XHR: warning tier. Framework chunks may contain the token; any
# hit gets eyeballed, not auto-failed.
warns=$(grep -rInE 'fetch\(|XMLHttpRequest' dist --include='*.js' || true)
if [ -n "$warns" ]; then
  echo "WARN [network primitives present, review manually]:"
  echo "$warns" | head -5
fi

if [ "$fail" -eq 1 ]; then
  echo "STATIC SAFETY: FAILED"
  exit 1
fi
echo "STATIC SAFETY: CLEAN"
