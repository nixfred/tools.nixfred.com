# Decision 0002: Dark instrument panel

Date: 2026-07-25
Status: Accepted. Fred's ruling.

## Context

`00-PRODUCT-VISION.md` principle 6 asks for a visual language that
feels like one Nixfred laboratory, and the pack repeatedly frames the
product as instruments rather than articles. It does not specify a
palette, a type pairing, or a mood, so the factory put the question to
Fred with three options.

## Options offered

1. **Dark instrument panel.** Near black surfaces, monospace for all
   data, thin precise rules instead of shadows, one electric accent.
   Reads like test equipment.
2. **Warmer softer dark.** A charcoal base with warm grey panels,
   rounder corners, generous padding, a friendlier accent. Rejected.
   It reads like a documentation site or a developer marketing page.
   The product's whole pitch is that it measures things, and a soft
   surface undercuts the claim before a visitor reads a word.
3. **Blueprint schematic.** Drafting paper ground, fine grid, technical
   line work, annotation callouts. Rejected. It is a strong look, but
   it says drawing rather than reading. These tools display live
   computed values that change as inputs change, and a schematic
   suggests a fixed diagram. It also constrains future tools to a
   drawn metaphor that most of them do not have.

## Decision

Option 1. Dark instrument panel.

Near black surfaces. Monospace for every number, slug, token count,
and machine readable value. Structure comes from 1px hairlines, not
from drop shadows. One electric accent, used only for interactive and
live things.

## Token architecture

Tokens are law. `src/styles/tokens.css` is the only file in the
project permitted to contain a color literal. No raw hex ships
downstream. If a component needs a color that is not in the token
file, the token set is wrong and gets fixed there, not patched at the
call site.

The token set is organized as ramps rather than as named one offs.

1. **Chassis**, six near black steps from 950 to 700. 950 is the page
   ground and panels step up, never down, so a card always reads as
   sitting on the chassis rather than cut into it.
2. **Rules**, three hairline weights. Faint, default, and strong.
   These carry the layout structure.
3. **Readout**, five text steps from 100 to 900, so text hierarchy is
   picked from a ramp instead of invented per component.
4. **Signal**, the single accent, five stops plus three alpha washes.
   The washes are tokens specifically so no component hand rolls an
   `rgba()` and drifts off the accent.
5. **Status**, four hues for live, beta, queued, and alert. Status is
   information, not decoration, and these appear only on status
   surfaces.
6. **Category dots**, five desaturated hues.

Surfaces are switched with a `data-surface` attribute rather than by
overriding individual properties. A section that changes the ground
carries `data-surface` and every nested component inherits the correct
tokens automatically. This is a carried lesson: in Astro, tokens leak
if a surface change is applied ad hoc instead of scoped.

## The single accent discipline

There is one loud color on this site, the signal cyan accent, and it
is reserved for interactive and live things. This is the rule that
keeps the panel reading as an instrument rather than as a dashboard
skin.

Category identity therefore gets the smallest possible treatment.
Each of the five categories has a hue, and that hue appears only as a
small identifying dot. Never as a card fill, never as a border, never
as text color. The hues are deliberately desaturated relative to the
accent. If categories were allowed to color their cards, a grid of 14
tools would become five competing color families and the accent would
stop meaning anything.

Status colors are a narrow exception, allowed because a status badge
is information the visitor needs in order to know what is usable.

## Type

Inter Variable for interface, JetBrains Mono Variable for data. Both
self hosted, no CDN, per `docs/decisions/0001-stack.md`. Root font
size is 112.5%, so every rem in the scale is measured against 18px
rather than 16px, per Fred's standing size ruling. `--text-sm` sits
at 16.2px at that root, which keeps it above the threshold where iOS
Safari zooms on input focus.

Instrument labelling uses small uppercase text with wide tracking
(`--track-label`). That is what makes a panel look like a panel.

## Contrast is verified by math, not by eye

A near black palette with a cyan accent and a five step grey ramp is
exactly the kind of scheme where a pairing can look fine on the
author's display and fail WCAG for someone else. Judging it by eye is
not verification.

The intended enforcement is `tests/check-contrast.mjs`, computing real
WCAG relative luminance and contrast ratios over the token pairings
that actually ship, and failing the gate on anything below threshold.
`tokens.css` documents `--signal-400` as the text safe accent stop on
that basis.

Status note, written honestly: as of this record the contrast checker
was still being built by the gates task in this same run. Treat the
math as the standard this palette is held to, and confirm the checker
is present and green before believing any contrast claim about this
site.

## Consequences

1. A future session adding a component copies tokens, never hex. A
   raw color literal outside `tokens.css` is a defect regardless of
   how it looks.
2. Adding a sixth category means adding one dot token, not a new
   color family.
3. Any proposal to introduce a second prominent accent has to argue
   against this record first.
4. Contrast regressions are caught by a gate, so a token ramp can be
   retuned without a manual re audit of every pairing.
