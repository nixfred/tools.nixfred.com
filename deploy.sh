#!/usr/bin/env bash
# Deploy tools.nixfred.com to Cloudflare Pages (Direct Upload, production).
#
# Auth: the env CLOUDFLARE_API_TOKEN from ~/.env.local works against the
# Pages API (verified 2026-07-25 on the sun build). Do NOT unset it; the
# wrangler OAuth fallback is expired. If auth error 10000 appears, run
# `wrangler login` from a real terminal.
set -euo pipefail

cd "$(dirname "$0")"

bun astro build

DIR="${1:-dist}"
PROJECT="tools-nixfred-com"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-b120e63874f8f8e9d75db4c1bf65a766}"

echo "Deploying $DIR to Pages project $PROJECT ..."
wrangler pages deploy "$DIR" \
  --project-name="$PROJECT" \
  --branch=main \
  --commit-dirty=true

echo
echo "Live: https://tools.nixfred.com"
