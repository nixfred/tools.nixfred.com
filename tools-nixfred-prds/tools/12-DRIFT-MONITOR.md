# Tool PRD — Drift Monitor

## User outcome

Compare two snapshots of an AI system and identify meaningful behavioral or configuration drift.

## Inputs

Versioned prompts, tools, permissions, knowledge sources, model settings, evaluation results, and optional metrics.

## Outputs

Structured diff, risk classification, likely effects, missing evaluation coverage, and rollback checklist.

## Boundaries

Initial release compares imported snapshots; it does not continuously monitor production systems.

## Acceptance criteria

- Separates intentional change from unexplained drift.
- Permission expansion receives prominent treatment.
- Each finding cites its changed fields.
- Snapshot format is versioned and exportable.

