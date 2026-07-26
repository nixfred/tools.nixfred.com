# PROJECT STATUS
## Nixfred AI Systems Workbench, tools.nixfred.com

> Single source of truth for project state. If it is not here, it is
> not the state.
>
> Last updated 2026-07-26.

## Current phase

Foundation scope COMPLETE in code and pushed to GitHub. NOT deployed.
The site does not serve at tools.nixfred.com yet, and the reason is a
missing credential, not missing work. See "Blocked" below.

## Scope of this execution

Per tools-nixfred-prds/02-BUILD-CONTROL.md, one execution covers named
PRDs only. Fred named these two, and only these two:

1. tools-nixfred-prds/03-SHARED-PLATFORM.md
2. tools-nixfred-prds/04-LANDING-PAGE.md

ZERO tool PRDs were implemented. That is deliberate and enforced, not
an oversight. See docs/decisions/0003-build-control-adherence.md.

## URLs

1. Repo: https://github.com/nixfred/tools.nixfred.com (public, live)
2. Production: https://tools.nixfred.com (NOT serving, blocked)
3. Pages project: not created yet, blocked on the same credential

## Completed

1. 2026-07-25: Factory bootstrap, partial. Seed, dependencies, first
   build, git init, public GitHub repo. The Cloudflare steps did NOT
   complete.
2. 2026-07-25: Registry contract, src/data/types.ts and registry.ts.
   Validated at module load, so a malformed entry fails the build.
3. 2026-07-25: Dark instrument panel design system, src/styles/.
4. 2026-07-25: Shared platform. Shell components, tool UI kit, tool
   layout, versioned persistence, share state, telemetry.
5. 2026-07-25: Landing page, registry driven, search and filters with
   URL state.
6. 2026-07-26: /about, /privacy, /404, and the /tools/[slug] route
   contract.
7. 2026-07-26: Five gates green. Links, safety, house style, registry
   contract, WCAG contrast.
8. 2026-07-26: GitHub Actions deploy workflow written and validated.

## Blocked

1. THE ONE BLOCKER. No credential on the build machine holds Cloudflare
   Pages permission. The environment token verifies as active but
   returns API error 10000 on the Pages endpoint, and the wrangler
   OAuth credential expired 2026-07-18 and cannot refresh from a non
   interactive shell.
   Needed: an API token with Account, Cloudflare Pages, Edit plus Zone,
   DNS, Edit on nixfred.com.
   Unblocks, in this order: Pages project creation, first deploy,
   custom domain attach, the proxied CNAME, and the GitHub Actions
   deploy secret.
2. Until that token exists, the GitHub Actions workflow will run on
   every push, pass the build and both gates, and fail at the final
   deploy step. That failure is expected and is not a code defect.

## Open items

1. THE FACTORY SEED IS STILL INFECTED. Three provenance defects from
   the sun.nixfred.com seed were fixed in THIS project but not in
   ~/.claude/skills/SiteFactory/seed/, so every future factory site
   inherits them. The write was blocked by the SystemFileGuard hook
   under Law 1 and needs Fred's explicit approval.
   The list: a SOLAR SAVE FOUNDATION header in seed global.css, a
   .skip-link pointing at the undefined var(--navy-900) which renders
   the focused skip link transparent, Solar Save Foundation naming
   throughout seed tokens.css, the same name in seed ShareSheet.astro
   where the fix is the __SITE_NAME__ placeholder that bootstrap.sh
   already substitutes, and a sample route list in seed LAYOUT_AUDIT.md.
2. src/components/ShareSheet.astro is repaired but UNUSED. Nothing
   imports it. A social share row is arguably off spec for this
   product. Fred can rule on deleting it.
3. No og:image exists. Base.astro advertises /images/og-card.jpg and
   that file has not been generated, so link previews will show a
   broken image. Generate before sharing any link publicly.
4. Visual review was completed at 1440px. The 390px pass was verified
   mechanically, zero horizontal overflow and touch targets confirmed,
   because the screenshot harness timed out repeatedly at that width.
   A human eye on a real phone has not seen this yet.

## Recommended next PRD

tools-nixfred-prds/tools/01-PROMPT-LAB.md, per the pack's own suggested
release order.

RECOMMENDING IT IS NOT IMPLEMENTING IT. Per 02-BUILD-CONTROL.md the
operator reviews and commits each completed PRD before another starts,
and the next execution must be named explicitly by Fred. Implementing
it also means flipping that tool's registry status from coming-soon to
released, which is the deliberate act described in
docs/decisions/0003-build-control-adherence.md, and updating the
assertion in tests/check-registry.mjs that currently expects zero
actionable tools.

## Fred decisions needed

1. The Cloudflare Pages token. Everything else is done.
2. Approval to fix the factory seed, which requires the SystemFileGuard
   override window.
3. Keep or delete the unused ShareSheet component.
