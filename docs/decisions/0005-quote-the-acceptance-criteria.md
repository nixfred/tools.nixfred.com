# Decision 0005: Quote the acceptance criteria verbatim, not just the schema

Date: 2026-07-26
Status: Accepted. Written after the error it describes.

## The rule

When briefing a producer agent to implement a PRD, paste the PRD's
User outcome, Workflow or Inputs, Outputs, and Acceptance criteria into
the prompt VERBATIM. Do not summarize them. Do not describe the tool in
your own words and assume the description is faithful.

## Why this record exists

On 2026-07-26 thirteen agents built thirteen tools in parallel. The
type contract in `src/data/types.ts` was quoted verbatim into every
prompt, exactly as the factory's proven lesson requires.

The result split cleanly along that line:

1. The TYPE contract was quoted. Zero schema violations across thirteen
   agents. Not one malformed registry entry, not one broken tool module.
2. The PRODUCT definition was paraphrased. Ten of fourteen tools came
   back off spec, two of them substantially the wrong tool.

Same agents. Same session. Same care. The only variable was whether the
contract was quoted or restated.

## How it was caught

Not by the gates, and not by review. The drift-monitor agent noticed
that its brief did not match its PRD, built what it had been asked for,
documented the mismatch in a comment at the top of its own file, and
reported it.

That is worth recording as a working practice: a producer agent that
can see a conflict between its brief and the source contract should
build to the brief, mark the conflict clearly in the code, and say so.
Silently building the wrong thing and silently building the right thing
are both worse, because both hide the disagreement.

## The specific failure mode

Paraphrase feels safe when you understand the domain, and it is most
dangerous exactly then. Both of the badly wrong tools were wrong in the
same direction: the brief described a MORE SOPHISTICATED tool than the
PRD asked for.

1. `13-SIGNAL-TESTER.md` asks whether a claim is supported by its cited
   evidence. The brief described construct validity, proxy gaming, and
   Cohen kappa. That is a more advanced idea, and it is not the product.
2. `06-EVAL-WORKBENCH.md` asks for a working scoring workbench. The
   brief described an advisor that helps design one, with statistical
   power analysis. Also more advanced. Also not the product.

The tell is that the paraphrase was more interesting than the source.
When a brief improves on the PRD, that is not craftsmanship, it is
scope drift wearing a good disguise, and 02-BUILD-CONTROL.md exists
specifically to prevent it.

## What to do instead

1. Paste the PRD sections verbatim into the brief, in a clearly marked
   block, before adding any guidance.
2. Add implementation guidance AFTER the quoted text, and label it as
   guidance so the agent knows which is authoritative.
3. Enumerate the acceptance criteria as a numbered checklist the agent
   must satisfy, using the PRD's own words for each.
4. When the PRD names specific items, an input list, a set of modes, a
   sample to include, reproduce that list exactly. The omissions in
   this run were mostly named items that got dropped in paraphrase:
   the simulation modes in Agent Designer, the email and calendar
   sample in Permission Planner, the cycle detection in Workflow
   Decomposer.
5. Before shipping, diff what was built against the acceptance criteria
   one line at a time. Do this even when the tests are green, because
   the tests were written from the same brief and inherit its errors.

## The part that generalizes

Green tests do not prove correct scope. Every one of the ten off spec
tools had a passing, genuinely rigorous test suite, because each agent
wrote tests against the brief it was given. A test suite validates the
implementation against its stated requirements. It cannot tell you the
requirements were wrong.

Only the source document can do that, which is why it has to be read
directly, and quoted rather than remembered.
