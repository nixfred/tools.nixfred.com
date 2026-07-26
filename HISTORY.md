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

## Chapter 5: Live
### 2026-07-26

The blocker turned out to be exactly what the diagnosis said it was,
which is a satisfying way for a night of work to end. Fred issued an API
token with Account, Cloudflare Pages, Edit and Zone, DNS, Edit. It
verified against the Pages endpoint on the first call, where every
previous credential had returned 10000.

After that the remaining steps took under two minutes: Pages project,
first deploy of 19 files, custom domain attached, certificate issued,
proxied CNAME on the nixfred.com zone.

The site answers at https://tools.nixfred.com with a valid certificate,
the correct title and canonical, and zero unsubstituted placeholders in
the served HTML. All four routes return 200.

One false alarm, worth writing down because it looked like a failure.
The first verification attempts against the custom domain returned
nothing at all while pages.dev served fine. The instinct is to assume
the deploy broke. It had not. Cloudflare reported the domain active and
the certificate active, and public resolvers at 1.1.1.1 and 8.8.8.8 both
answered correctly. It was the local Tailscale resolver on this machine
holding a stale negative answer. The site was live the whole time. When
a domain fails locally but the authoritative side reports healthy,
suspect the resolver in front of you before the infrastructure behind
it.

Then the part that mattered most to Fred's ruling: a dispatched workflow
run built the site, passed the link gate, passed the static safety gate,
and deployed. Push to main now ships the site. The instruction he gave
at the start of the run is now literally true of the repository.

What shipped is a foundation, deliberately. Fourteen instruments are
specified and none are usable, and the landing page says so plainly
rather than dressing an empty catalog up as a product. AVAILABLE NOW
reads 0. That number is the honest one, and it will move one PRD at a
time.

---

## Chapter 6: Fourteen tools, and the audit that caught me
### 2026-07-26

Fred set a goal: build all fourteen tools, triple check them with
receipts, and text him as each one landed.

The build itself went the way the factory says it should. The type
contract was already written and proven, so thirteen agents went out at
once, each owning three files and nothing else, each handed the
prompt-lab implementation as the house pattern. Zero collisions. Every
schema validated. The parallel machine worked exactly as designed.

Then the drift-monitor agent sent a message saying, in effect, I built
what you asked for and I think what you asked for is wrong.

It was right. Its PRD specifies a snapshot differ that compares two
system configurations and treats permission expansion as the headline
finding. The brief I wrote described a statistical significance
instrument, built around one of the several inputs the PRD happens to
list. The agent built to my brief, documented the mismatch in a comment
at the top of its own file, and told me rather than letting it ship
quietly.

That triggered an audit of all fourteen PRDs against what had actually
been built, and the result was not comfortable. Ten tools were off
spec to some degree. Two were badly wrong. Signal Tester was supposed
to verify whether a claim is supported by its evidence, and had been
built as a metrics validity tool. Evaluation Workbench was supposed to
be a working scoring workbench whose central idea is that an aggregate
score must never hide a failed critical case, and had been built as an
advisor that explains how to design one.

The root cause is worth writing down precisely, because it is a lesson
about a lesson. The factory's hardest won rule is that a contract
quoted verbatim in every producer prompt yields zero failures. That
rule was followed for the TYPE contract, and the type contract held
perfectly across thirteen agents with not one schema violation. It was
not followed for the PRODUCT definition. The briefs described the tools
in my own words, confidently and at length, and confident paraphrase is
exactly how scope drifts. The schema was quoted and survived. The
acceptance criteria were paraphrased and did not.

All ten were corrected, this time with the PRD text pasted in verbatim.
None of the good work was discarded. Where a PRD lists evaluation
results as one input among several, the rigorous statistics engines
built for them survive as secondary panels, which is where they always
belonged.

The gates had a hard day too, and earned their place. Three defects
were found in them and each fix was validated with a negative control,
which is how the worst one surfaced: a fix intended to stop the copy
gate flagging arithmetic accidentally made it stop flagging prose
dashes entirely, because the comment marker slash slash contains a
forward slash and so every comment line looked like arithmetic. The
gate went quiet rather than loud. A gate that silently passes
everything is worse than no gate at all, and only a deliberate test
against known bad input catches that.

One gate turned out to be in genuine conflict with the pack it exists
to enforce. The no hardcoded slug rule fired on Workflow Decomposer for
naming Agent Designer, but that tool's PRD explicitly requires
promoting a workflow into Agent Designer. Read closely, the criterion
permits an explicit export and forbids hidden coupling, so the fix was
a documented allowlist paired with a new check that the allowlisted
file may name the other tool but may not import it. The allowance
widens may mention, never may depend on.

Every tool is live. Every gate is green. The landing page reads
REGISTERED 14 and AVAILABLE NOW 14, and it was never edited once
across the entire build, because the registry drives it. That was the
whole point of the foundation.

---
