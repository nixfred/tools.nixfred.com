/**
 * REGISTRY CONTRACT GATE.
 *
 * Machine proof of the two headline acceptance criteria:
 *   03-SHARED-PLATFORM.md: "A dummy development fixture can register
 *   and unregister without changing landing-page code."
 *   04-LANDING-PAGE.md: "Adding a development fixture requires no
 *   landing component change."
 *
 * Run: bun tests/check-registry.mjs
 *
 * This gate imports src/data/ directly rather than scraping built
 * HTML, so it fails on a bad contract even when the build is green.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import {
  CATEGORIES,
  TOOL_STATUSES,
  INPUT_SENSITIVITIES,
  validateToolEntry,
  isPublic,
  isActionable,
} from '../src/data/types.ts';
import {
  TOOLS,
  PUBLIC_TOOLS,
  ACTIONABLE_TOOLS,
  FEATURED_TOOLS,
  FEATURED_SLUGS,
} from '../src/data/registry.ts';
import { devFixtures } from '../src/data/fixtures.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
function fail(label, detail) {
  failures.push(`VIOLATION [${label}]: ${detail}`);
}
function expect(label, condition, detail) {
  if (!condition) fail(label, detail);
}

/* ------------------------------------------------------------------
   Base set derivation.

   registry.ts merges devFixtures only when import.meta.env.DEV is
   true, and that flag is undefined under a plain bun run. Rather than
   depend on which way the runtime happens to resolve it, the base set
   is derived by subtracting the fixture slugs. Both directions of the
   register/unregister property are then computed from pure data, so
   this gate reports the same answer in dev and in production.
   ------------------------------------------------------------------ */
const fixtureSlugs = new Set(devFixtures.map((f) => f.slug));
const BASE = TOOLS.filter((t) => !fixtureSlugs.has(t.slug));
const MERGED = [...BASE, ...devFixtures];
const fixturesWereMerged = TOOLS.length !== BASE.length;

console.log(
  `registry entries checked: ${MERGED.length} ` +
    `(base ${BASE.length}, dev fixtures ${devFixtures.length}, ` +
    `fixtures merged in this run: ${fixturesWereMerged ? 'yes' : 'no'})`,
);

/* ---- 1. Every entry satisfies the exported contract -------------- */
for (const tool of MERGED) {
  for (const err of validateToolEntry(tool)) fail('contract', err);
}

/* ---- 2. Unique slugs, and route equals /tools/{slug} ------------- */
const seen = new Map();
for (const tool of MERGED) {
  if (seen.has(tool.slug)) fail('duplicate slug', `"${tool.slug}" appears more than once`);
  seen.set(tool.slug, tool);
  expect(
    'route shape',
    tool.route === `/tools/${tool.slug}`,
    `${tool.slug}: route is "${tool.route}", expected "/tools/${tool.slug}"`,
  );
}

/* ---- 3. Every enum value is inside its declared union ------------ */
for (const tool of MERGED) {
  expect('category union', CATEGORIES.includes(tool.category), `${tool.slug}: category "${tool.category}" is not in CATEGORIES`);
  expect('status union', TOOL_STATUSES.includes(tool.status), `${tool.slug}: status "${tool.status}" is not in TOOL_STATUSES`);
  expect(
    'sensitivity union',
    INPUT_SENSITIVITIES.includes(tool.inputSensitivity),
    `${tool.slug}: inputSensitivity "${tool.inputSensitivity}" is not in INPUT_SENSITIVITIES`,
  );
}

/* ---- 4. Featured slugs resolve to real, non hidden entries ------- */
for (const slug of FEATURED_SLUGS) {
  const entry = seen.get(slug);
  if (!entry) {
    fail('featured', `FEATURED_SLUGS names "${slug}", which is not a registry entry`);
    continue;
  }
  expect('featured', isPublic(entry), `FEATURED_SLUGS names "${slug}", which is hidden`);
}
expect(
  'featured',
  FEATURED_TOOLS.length === FEATURED_SLUGS.filter((s) => seen.has(s) && isPublic(seen.get(s))).length,
  `FEATURED_TOOLS has ${FEATURED_TOOLS.length} entries, expected ${FEATURED_SLUGS.length} resolvable public slugs`,
);
expect(
  'featured order',
  FEATURED_TOOLS.map((t) => t.slug).join(',') ===
    FEATURED_SLUGS.filter((s) => seen.has(s) && isPublic(seen.get(s))).join(','),
  'FEATURED_TOOLS does not preserve FEATURED_SLUGS order',
);

/* ---- 5. Hidden tools appear in no public collection -------------- */
for (const collection of [
  ['PUBLIC_TOOLS', PUBLIC_TOOLS],
  ['FEATURED_TOOLS', FEATURED_TOOLS],
  ['ACTIONABLE_TOOLS', ACTIONABLE_TOOLS],
]) {
  const [name, list] = collection;
  for (const tool of list) {
    expect('hidden leak', tool.status !== 'hidden', `${name} contains hidden tool "${tool.slug}"`);
  }
}

/* ---- 6. Only released and beta are actionable -------------------- */
for (const tool of ACTIONABLE_TOOLS) {
  expect(
    'actionable status',
    tool.status === 'released' || tool.status === 'beta',
    `ACTIONABLE_TOOLS contains "${tool.slug}" with status "${tool.status}"`,
  );
}

/* ==================================================================
   7. THE FIXTURE PROOF.

   The acceptance criterion is a property of the data layer, not a
   property of any one rendered page: a conforming entry must flow
   into the public collections by predicate alone. So the proof
   recomputes the derived collections from the raw arrays using the
   SAME predicates registry.ts uses (isPublic, isActionable, and the
   FEATURED_SLUGS lookup), once with fixtures present and once with
   them absent, and asserts the deltas.

   Why this satisfies "requires no landing component change": the
   landing page renders whatever these predicates return. Nothing in
   this test touches a landing file, no fixture slug is written into
   any component, and the only input that changed between the two
   runs is the contents of the registry array. If membership were
   decided anywhere else, for example by a hardcoded card list in a
   component, the counts below would still pass while the page stayed
   wrong. Assertion 7d closes that hole by proving no landing file
   names a tool slug at all.
   ================================================================== */

const derive = (tools) => ({
  all: tools,
  public: tools.filter(isPublic),
  actionable: tools.filter(isActionable),
  featured: FEATURED_SLUGS.map((slug) => tools.filter(isPublic).find((t) => t.slug === slug)).filter(Boolean),
});

const withFixtures = derive(MERGED);
const withoutFixtures = derive(BASE);

// 7a. The fixture set must actually exercise the property. A fixture
// file of three coming-soon entries would make every delta below
// trivially true, which is a gate that checks nothing.
const byStatus = (status) => devFixtures.filter((f) => f.status === status);
expect('fixture shape', byStatus('released').length >= 1, 'devFixtures has no released entry, the actionable delta would be vacuous');
expect('fixture shape', byStatus('beta').length >= 1, 'devFixtures has no beta entry, the badge path is unproven');
expect('fixture shape', byStatus('hidden').length >= 1, 'devFixtures has no hidden entry, the hidden exclusion is unproven');

const expectedPublicDelta = devFixtures.filter(isPublic).length;
const expectedActionableDelta = devFixtures.filter(isActionable).length;

// 7b. Register direction: collections grow by exactly the expected counts.
expect(
  'fixture register',
  withFixtures.all.length === withoutFixtures.all.length + devFixtures.length,
  `registering fixtures changed total by ${withFixtures.all.length - withoutFixtures.all.length}, expected ${devFixtures.length}`,
);
expect(
  'fixture register',
  withFixtures.public.length === withoutFixtures.public.length + expectedPublicDelta,
  `public grew by ${withFixtures.public.length - withoutFixtures.public.length}, expected ${expectedPublicDelta}`,
);
expect(
  'fixture register',
  withFixtures.actionable.length === withoutFixtures.actionable.length + expectedActionableDelta,
  `actionable grew by ${withFixtures.actionable.length - withoutFixtures.actionable.length}, expected ${expectedActionableDelta}`,
);
for (const fixture of byStatus('released').concat(byStatus('beta'))) {
  expect(
    'fixture register',
    withFixtures.actionable.some((t) => t.slug === fixture.slug),
    `${fixture.slug} is ${fixture.status} but did not become actionable`,
  );
  expect(
    'fixture register',
    withFixtures.public.some((t) => t.slug === fixture.slug),
    `${fixture.slug} is ${fixture.status} but did not become public`,
  );
}
for (const fixture of byStatus('hidden')) {
  for (const [name, list] of [
    ['public', withFixtures.public],
    ['actionable', withFixtures.actionable],
    ['featured', withFixtures.featured],
  ]) {
    expect(
      'fixture register',
      !list.some((t) => t.slug === fixture.slug),
      `hidden fixture ${fixture.slug} leaked into the ${name} collection`,
    );
  }
}
// Featured placement is configuration, not status, so registering a
// fixture must not disturb it.
expect(
  'fixture register',
  withFixtures.featured.length === withoutFixtures.featured.length,
  'registering fixtures changed the featured count, featured placement is not status driven',
);

// 7c. Unregister direction: with fixtures absent every collection
// returns to the base set, entry for entry rather than by count alone.
const sameSlugs = (a, b) => a.map((t) => t.slug).sort().join(',') === b.map((t) => t.slug).sort().join(',');
expect('fixture unregister', sameSlugs(withoutFixtures.all, BASE), 'unregistering did not restore the base registry');
expect('fixture unregister', sameSlugs(withoutFixtures.public, BASE.filter(isPublic)), 'unregistering did not restore the public set');
expect(
  'fixture unregister',
  withoutFixtures.all.every((t) => !fixtureSlugs.has(t.slug)),
  'a fixture slug survived unregistration',
);

// 7d. No landing surface may name a tool slug. FEATURED_SLUGS lives in
// src/data/registry.ts, which 04-LANDING-PAGE.md permits as "a small
// ordered configuration list". Anywhere else a slug literal means the
// grid is hardcoded and the modularity criterion is false.
const LANDING_DIRS = ['src/components', 'src/layouts', 'src/pages'];
const allSlugs = MERGED.map((t) => t.slug);
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
let landingFilesScanned = 0;
for (const dir of LANDING_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    if (!/\.(astro|ts|tsx|js|mjs|css)$/.test(file)) continue;
    landingFilesScanned += 1;
    const text = readFileSync(file, 'utf8');
    for (const slug of allSlugs) {
      if (text.includes(slug)) {
        fail(
          'hardcoded slug',
          `${relative(ROOT, file)} names the tool slug "${slug}". Landing surfaces must render from the registry only.`,
        );
      }
    }
  }
}

/* ==================================================================
   8. PRODUCTION STATUS DISCIPLINE.

   02-BUILD-CONTROL.md: a tool is coming-soon until its own PRD is
   implemented and accepted. This execution implemented only
   03-SHARED-PLATFORM and 04-LANDING-PAGE, so with fixtures excluded
   the actionable set must be EMPTY. A released entry with no tool
   module behind it is a dead route.

   READ THIS BEFORE YOU EDIT: this assertion is expected to change.
   The first tool PRD that lands will make its own slug actionable,
   and at that point this check must be loosened DELIBERATELY, for
   example to "every actionable tool has a route file under
   src/pages/tools/". Do not delete it, and do not weaken it by
   accident to make a red build go green.
   ================================================================== */
const productionActionable = BASE.filter(isActionable);
expect(
  'foundation scope',
  productionActionable.length === 0,
  `production actionable set is not empty: ${productionActionable
    .map((t) => `${t.slug} (${t.status})`)
    .join(', ')}. Either a tool PRD shipped, in which case update assertion 8 in this file on purpose, or a status was flipped without an implementation, which is a dead route.`,
);

/* ---- Report ------------------------------------------------------ */
console.log(
  `landing files scanned for hardcoded slugs: ${landingFilesScanned} ` +
    `across ${LANDING_DIRS.join(', ')}`,
);
console.log(
  `derived: public ${withoutFixtures.public.length}, actionable ${withoutFixtures.actionable.length}, ` +
    `featured ${withoutFixtures.featured.length} without fixtures, ` +
    `public ${withFixtures.public.length}, actionable ${withFixtures.actionable.length}, ` +
    `featured ${withFixtures.featured.length} with fixtures`,
);

if (failures.length) {
  console.log(`REGISTRY CONTRACT: FAILED (${failures.length})`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('REGISTRY CONTRACT: CLEAN');
