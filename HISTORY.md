# HISTORY
## The Making of Nixfred AI Systems Workbench

> The build chronicle. Every milestone gets a chapter, written as it
> happens. The site is the product; this is the ship's log of the
> factory run that built it.

---

## Chapter 1: The pack, and an argument with it
### 2026-07-25

The work arrived the way the best work does, as a finished thought.
Fred pointed at a directory called tools-nixfred-prds and said run the
site factory. Inside were twenty documents: a product vision, an
information architecture, a shared platform spec, a landing page spec,
and fourteen tool PRDs describing everything from a prompt laboratory
to a drift monitor.

The factory read all of it and immediately hit a problem, which is the
most interesting thing that happened all night.

Document 02 in that pack is called BUILD-CONTROL, and it exists for one
reason: to stop exactly what was about to happen. Its opening line is
"Prevent a broad product plan from being interpreted as permission to
build the entire site in one pass." It states that one execution may
cover exactly one named PRD, that shared platform work and landing page
work are separate executions, and that each tool is its own execution.

So the instruction was build the site, and the site's own governing
document said you may not build the site.

The factory's operating law 2 settles ties like this: when the skill
and the pack conflict, the pack wins. But a law that says the pack wins
does not say how much of the pack to build tonight, and the honest
answer was that nobody knew, because the two readings produced
completely different evenings. So it went to Fred rather than being
resolved quietly in favor of whichever reading made for a better demo.

He ruled: foundation only. The shared platform and the landing page.
Zero tools.

He also ruled on the look, dark instrument panel, near black surfaces
with monospace data and one electric accent, the thing should read like
test equipment. And on deployment, push to GitHub, let that deploy to
Cloudflare Pages, let Cloudflare DNS point the domain at it.

---

## Chapter 2: The credential wall
### 2026-07-25

Bootstrap went up cleanly through five steps: seed, install, first
build, git init, and a public repository at
github.com/nixfred/tools.nixfred.com.

Step six failed. Cloudflare API error 10000, authentication.

The temptation with a 10000 is to try things. Rotate a variable, unset
a variable, run it again. The factory skill's own note said the
environment token works for Pages and should not be unset. Memory from
the mac.nixfred.com build in July said the opposite, that the
environment tokens must be unset because the OAuth credential wins. Two
authorities, direct contradiction, and both had been true at some point.

Diagnosis beat guessing. The token verifies as active against
Cloudflare's own verify endpoint and returns 10000 on the Pages
endpoint specifically, which means it is a valid token that simply does
not carry Pages permission. The wrangler OAuth credential does exist on
disk, and its access token expired on 2026-07-18. Wrangler can normally
refresh itself out of that, but the refresh failed too, and the shell
here is non interactive, so it could not open a browser to re-auth.

The finding was not a bug. It was that no credential on the machine
currently holds Cloudflare Pages permission, and no amount of retrying
was going to conjure one. That needs a human at a dashboard.

The same finding resolved a second question. Fred wanted push to GitHub
to deploy. Connecting a repository to Pages natively requires an
interactive OAuth grant in the Cloudflare dashboard that cannot be
performed from a terminal, so the answer was a GitHub Actions workflow
instead, which produces the same behavior and can be configured
entirely from the command line. Actions cannot use an OAuth credential
either. It needs an API token. So one Pages-scoped token unblocks both
problems at once, which made the ask to Fred a single ask.

Everything that did not depend on Cloudflare kept moving.

---

## Chapter 3: Seven agents, one contract
### 2026-07-25

Fred's next instruction was short: deploy expert agents for all tasks.

The factory's hardest won lesson about parallel producers is that they
succeed or fail on the contract they are given, and that a schema
quoted verbatim in every prompt produces zero validation failures. So
the type contract was written first and by hand: the registry entry
shape, the tool module shape, the status vocabulary, and the validator
that runs at module load. Then seven agents went out at once against
it, owning disjoint directories so none could collide with another.

They produced good work. The route contract page for /tools/[slug]
carries a comment explaining that generating zero pages is correct and
telling a future session not to fix it. The privacy page makes six
claims and every one of them is literally true of the codebase. The
landing page handles the awkward reality of a catalog where nothing is
usable yet by naming it honestly: First release queue, Catalog in
build, AVAILABLE NOW 0.

Then all seven died in the same minute, on a monthly spend limit.

The remaining work got finished in the main loop: the tool layout, four
kit components, the telemetry module, the house style gate, the
favicon, and the repairs described below.

---

## Chapter 4: What the gates caught
### 2026-07-26

The gates earned their keep, including against the process that wrote
them.

The contrast gate implements real WCAG relative luminance math rather
than eyeballing, and it failed the build on --signal-edge, an accent
token at 38 percent alpha used as a visible boundary. It measured 2.50
against the chassis where SC 1.4.11 requires 3.0 for a non text UI
indicator. The fix was solved numerically, not adjusted by taste: 0.45
is the lowest alpha that clears 3.0 on all four grounds it can appear
against. That token had been written earlier the same night by the same
process that then caught it.

The house style gate was written, run, and immediately found three
false positives in itself. It flagged arithmetic in shareState.ts as
dash punctuation, flagged a comment about the rule against rgba as a
breach of that rule, and flagged the landing page's own curly quote
normalizer, which has to contain the characters it strips. All three
got fixed in the gate, because a gate that cries wolf gets switched
off, and a switched off gate protects nothing.

Four provenance defects surfaced, three inherited and one self
inflicted. The seed carried a SOLAR SAVE FOUNDATION header in
global.css, a skip link pointing at var(--navy-900) which no seed has
ever defined and which therefore rendered the focused skip link
transparent, and a ShareSheet component shipping the previous site's
name into share text. The fourth was ours: the token rewrite deleted
--card-bg while ShareSheet still referenced it, and a dangling CSS
custom property does not error, it silently renders nothing. Standing
lesson: after removing a token, grep the whole tree for its name.

An accessibility finding turned out to be a non finding, which is worth
recording because the reasoning is reusable. Measured at 390px, the
category filter chips came out 40px tall, under the 44px floor. The
correct conclusion was not to fix them. A desktop browser at a narrow
viewport reports pointer: fine, so the coarse pointer rules are
inactive, and the chips already solve this with their own scoped rule
that lifts them to exactly 44px on a real touch device. The measurement
was an artifact of the harness. The comment written about it was
corrected once that was proven, because a confident and wrong comment
in the codebase is worse than no comment at all.

The attempt to fix the seed itself was blocked, correctly, by Fred's
own SystemFileGuard hook under Law 1, never overwrite Larry. Fixing the
factory seed requires his explicit approval, and the guard is not
something a run should route around on its own authority. So this site
is clean and the seed is still infected. That is an open item, not a
closed one.

---
