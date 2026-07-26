# Tool PRD — Workflow Decomposer

## User outcome

Convert a vague workflow into explicit steps suitable for humans, automation, or AI agents.

## Workflow

Describe an outcome; add inputs, actors, constraints, and approval points; refine a generated or sample step graph.

## Outputs

Ordered steps, dependencies, human decisions, automation candidates, failure paths, required systems, and success evidence.

## Boundaries

Initial decomposition is rules/templates plus user editing. It does not execute the workflow.

## Acceptance criteria

- Every step has an owner and completion evidence.
- Cycles and orphan steps are flagged.
- Workflow exports as structured JSON and readable Markdown.
- User can promote the workflow into Agent Designer through an explicit export, not hidden coupling.

