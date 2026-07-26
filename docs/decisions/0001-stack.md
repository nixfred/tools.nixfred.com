# Decision 0001: Astro 5 with bun, static output, no adapter

Date: 2026-07-25
Status: Accepted

## Context

The PRD pack describes one site containing up to 14 browser based
instruments, plus a landing directory, an about page, and a privacy
page. Two constraints from the pack dominate the stack choice.

The first is principle 8 in `00-PRODUCT-VISION.md`: no user input
leaves the browser unless the interface explicitly says so. The second
is the modularity requirement in `04-LANDING-PAGE.md`: adding a
registry entry must place a tool in search, filters, and the grid
without touching landing page code.

A privacy promise of that shape is only credible if the architecture
makes it structurally true rather than politely intended. If there is
no server, there is nothing to send input to.

## Options considered

1. A server rendered app with an API layer. Rejected. It would give
   the site a place to send user input, which is the exact thing the
   product promises never happens. Defending that promise would then
   require auditing every handler forever instead of pointing at the
   absence of a backend.
2. Astro 5 with bun, static output, no adapter. Chosen. Every route
   compiles to a file at build time. There is no runtime origin, no
   request handler, and no database. Islands carry interactivity only
   where a tool genuinely needs it. This is the factory default and it
   is already proven on calc.nixfred.com and sun.nixfred.com.
3. A single page React or Next.js application. Rejected. It ships a
   framework runtime to a visitor who may only want one calculator,
   and it fights the pack's requirement that each tool live at its own
   isolated route under `/tools/[slug]`.
4. Hand written static HTML. Rejected. 14 tools sharing a header,
   footer, tool layout, and registry driven cards becomes duplicated
   markup that drifts. The pack's success signal, that an incomplete
   tool can be hidden without breaking the site, needs one code path
   reading one registry.

## Decision

Astro 5, installed and run with bun. `output: 'static'`. No Cloudflare
adapter and no SSR. `trailingSlash: 'never'` and `build.format: 'file'`
so the emitted paths match what Cloudflare Pages serves.

Interactivity is added as narrowly as the feature allows. The landing
page search and category filters are vanilla inline JavaScript
operating on server rendered DOM, not a framework island. The cards
exist in the HTML before any script runs, so the directory is complete
and readable with JavaScript disabled, and filtering only ever hides
elements that were already there. A framework island for filtering
would ship a runtime to do less than a few dozen lines of DOM work.

Later tool PRDs may introduce islands where the interaction actually
demands one. That is a per tool judgment, made in that tool's own
execution, and it does not license changing this baseline.

## Fonts

Inter Variable for interface text and JetBrains Mono Variable for
every number, slug, token count, and machine readable value. Both are
self hosted through fontsource and imported in `src/layouts/Base.astro`,
so the font files are bundled into the static build and served from
the same origin as the site.

A font CDN was rejected for three reasons. It introduces a third party
request on every page load, which contradicts a site whose stated
promise is that nothing leaves the browser. It makes rendering depend
on a host nobody here controls. And `tests/check-safety.sh` exists to
assert that the static output carries no external scripts, so an
external font host would either fail that gate or force a hole in it.

## Consequences

1. There is no server side code path capable of receiving user input.
   The privacy claim is enforced by the absence of a backend, not by
   discipline.
2. Deployment is a directory of files. See `docs/decisions/0004-deployment-path.md`.
3. Every tool is a route under `/tools/[slug]`, generated from the
   registry. The pack's ban on a subdomain per tool is satisfied by
   construction.
4. Any future PRD that requires a live model provider call has to
   confront this decision explicitly and state where the request goes
   and what the interface tells the user. It cannot be added quietly.
