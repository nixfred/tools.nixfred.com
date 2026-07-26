# Tool PRD — Prompt Laboratory

## User outcome

Compare prompt structures and understand why small instruction changes alter behavior.

## Core workflow

Enter a system instruction, task, context, and constraints; select a deterministic sample scenario; compare structured versions side by side.

## Outputs

- Prompt anatomy and token estimate
- Detected conflicts, ambiguity, missing success criteria, and unsafe authority
- Side-by-side diff
- Improved prompt draft with every change explained

## Boundaries

Core mode performs local analysis and simulation. It must not pretend simulated output came from a model. Live provider execution is future scope.

## Acceptance criteria

- Includes at least three samples.
- User can edit, compare, copy, reset, and export.
- Findings link to exact prompt segments.
- No input is transmitted externally.

