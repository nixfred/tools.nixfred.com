# CLAUDE.md - tools.nixfred.com

> Design law for this site. Global rules live in ~/.claude/CLAUDE.md.
> Factory rules live in ~/.claude/skills/SiteFactory/SKILL.md.
> This file holds only what is specific to this site.
> Bootstrapped 2026-07-25 by the NixFred Site Factory.

## What this site is

FILL IN STAGE 1: one paragraph from the build pack. The pack directory
in this repo is the READ ONLY input contract. Do not edit it.

## Hard rules from the pack

FILL IN STAGE 1: safety rules, tone rules, whatever the pack makes
non-negotiable. Restate them here so they survive every session.

## Settled

1. Public repo github.com/nixfred/tools.nixfred.com, Pages project
   tools-nixfred-com, domain tools.nixfred.com, deploy is ./deploy.sh
   (builds and ships to production, main branch IS production).
2. Astro + bun, static output. Tokens are law: src/styles/tokens.css,
   no raw hex downstream.
3. Gates before any production swap: tests/check-links.sh (zero dead
   links) and tests/check-safety.sh both green.
4. Decisions in docs/decisions/, status in docs/project/PROJECT_STATUS.md,
   chronicle in HISTORY.md. One of each.

## Writing rules

1. No dash punctuation. Periods and commas. Numbered lists only.
2. Short declarative sentences. Cut every word not carrying information.
3. Capital C on Customer when referring to Customers.
4. Nothing personal about Fred beyond Built by Fred Nix and links.

## Repo hygiene

1. PUBLIC repo. Scan every commit for private content.
2. git remote -v before every commit.
3. Commit messages carry what and why with LR- trailers.
