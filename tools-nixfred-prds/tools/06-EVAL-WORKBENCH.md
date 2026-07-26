# Tool PRD — Evaluation Workbench

## User outcome

Design a small, repeatable evaluation before choosing a prompt, model, or agent configuration.

## Workflow

Define task cases, expected properties, scoring rubric, weights, and candidate result sets; score manually or with deterministic checks.

## Outputs

Per-case scores, aggregate comparison, disagreement indicators, failures, and coverage gaps.

## Boundaries

No hidden automated judge. Any future model judge must be optional and labeled.

## Acceptance criteria

- Import/export a portable evaluation set.
- Prevent aggregate scores from hiding failed critical cases.
- Support pass/fail and scaled rubrics.
- Include a sample evaluation.

