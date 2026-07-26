# Decision 0003: How build control is enforced, not just promised

Date: 2026-07-25
Status: Accepted. Fred's ruling.

## If you read one decision record, read this one

You are probably here because you are about to build a tool, or because
something looks broken and you are about to fix it. Two things below are
supposed to look broken. They are not.

## The conflict

Fred said "run the site factory" and pointed at the build pack.

The pack's own tools-nixfred-prds/02-BUILD-CONTROL.md forbids exactly
that reading. Its stated purpose is to "prevent a broad product plan
from being interpreted as permission to build the entire site in one
pass." It specifies that one execution covers exactly one named PRD,
that shared platform and landing page are separate executions, and that
each tool is its own execution.

The NixFred Site Factory's operating law 2 says that when the skill and
the pack conflict, the pack wins. That settles who is authoritative, but
it does not answer how much to build in this session, because both
readings are defensible and they produce completely different work.

So it went to Fred rather than being resolved silently.

## The ruling

Foundation only. 03-SHARED-PLATFORM.md and 04-LANDING-PAGE.md. Zero
tools.

## Why this record exists

A promise in a document does not survive contact with a future session
that has no memory of tonight and a strong instinct to be helpful. The
constraint had to be built into the code so that violating it produces a
failure, not just a broken promise. Here is where it lives.

## Enforcement 1: status discipline in the registry

Every one of the 14 tools in src/data/registry.ts carries status
`coming-soon`. A tool is `coming-soon` until its own PRD has been
implemented and accepted.

src/data/types.ts defines exactly two actionable statuses, `released`
and `beta`. Everything downstream derives from that single fact rather
than from a hand maintained list.

The registry validates itself at module load and THROWS on a contract
violation. A malformed entry fails the build. It does not ship a broken
card and find out later.

## Enforcement 2: the route contract generates zero pages

src/pages/tools/[slug].astro calls getStaticPaths over ACTIONABLE_TOOLS.

In a production build that array is EMPTY, so the route generates ZERO
pages. The build log will show the route with no output beneath it.

THIS IS CORRECT. It is the mechanism, working. 01-INFORMATION-
ARCHITECTURE.md states it plainly: "No route should be generated for
hidden or unimplemented tools."

Do not fix this by adding entries, by changing a status, or by widening
ACTIONABLE_STATUSES.

## Enforcement 3: the gates punish a shortcut

Flipping a tool to `released` without implementing it does not quietly
work. It produces a route to a page with no tool in it, and once
anything links to that tool as usable, tests/check-links.sh fails.

tests/check-registry.mjs asserts that ACTIONABLE_TOOLS is empty when dev
fixtures are excluded. That assertion is deliberately brittle. It is
EXPECTED to be updated by the first real tool PRD, and updating it
should feel like a decision, because it is one.

## How to actually ship a tool, when the time comes

1. Fred names exactly one tool PRD.
2. State the preflight required by 02-BUILD-CONTROL.md: the named PRD,
   routes touched, files touched, excluded work, verification plan.
3. Implement that tool and only that tool. Do not build adjacent tools.
   Do not add dependencies that only a future PRD needs.
4. Do not alter the shared contract in src/data/types.ts. If the tool
   genuinely needs a change there, propose it and STOP.
5. Flip that one registry entry to `released` or `beta`.
6. Update the assertion in tests/check-registry.mjs.
7. Run the full gate suite, then report scope, files, checks,
   acceptance status, limitations, and the recommended next PRD without
   implementing it.

## The part that is easy to miss

The landing page does not need to change when a tool ships. That is the
headline acceptance criterion of both foundation PRDs, and it is proven
in both directions by the dev fixtures in src/data/fixtures.ts, which
register and unregister without a single edit to landing page markup.

If you find yourself editing src/pages/index.astro to add a tool, stop.
Something has gone wrong, and it is not the landing page.

---

## AMENDMENT, 2026-07-26: the operator named all fourteen

Fred directed that all 14 tool PRDs be built, triple checked, and
shipped. That is a change in scope, not a violation of the protocol,
and the distinction matters enough to write down.

02-BUILD-CONTROL.md says "Claude Code must implement only the PRD
explicitly named by the operator." The protocol constrains what may be
INFERRED, not what the operator may AUTHORIZE. Fred is the operator. He
named all fourteen. Building them is compliant. Building them because
the plan looked broad enough to justify it would not have been.

What survives from the original decision, unchanged:

1. A tool ships only when its own PRD is implemented, not when it looks
   convenient to flip a status.
2. Status still reflects reality. A registry entry moves to released
   only when a real page exists behind it.
3. The landing page still needs no edit when a tool ships.

What changed, deliberately:

Assertion 8 in tests/check-registry.mjs required the production
actionable set to be EMPTY. That assertion only held while zero tools
existed, and its own comment named its successor. It has been replaced
with the stronger, permanent check the comment specified: every
actionable tool must have a page file at src/pages/tools/<slug>.astro,
plus the converse, no orphan page without an actionable registry entry.

The old check could only ever fail once. The new one guards the actual
failure mode forever: a status flipped to released with nothing behind
it, which is a dead route.

Assertion 7d was also rescoped. It forbade any file under
src/components, src/layouts, or src/pages from naming a tool slug. That
fired on prompt-lab.astro for calling getTool('prompt-lab'), which is
how a tool page identifies itself and is not a hardcoded landing grid.
A tool page may now name exactly one slug, its own. Every other file
still may not name any.
