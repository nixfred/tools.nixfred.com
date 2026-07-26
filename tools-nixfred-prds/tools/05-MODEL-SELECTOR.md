# Tool PRD — Model Selector

## User outcome

Turn workload requirements into a defensible model-selection shortlist.

## Inputs

Task type, quality threshold, latency, budget, context size, modalities, tool use, hosting constraints, and data sensitivity.

## Outputs

Ranked candidates, disqualifiers, tradeoffs, unanswered questions, and a recommended evaluation plan.

## Boundaries

The model catalog is versioned data with sources and dates. The tool must not present one universal “best model.”

## Acceptance criteria

- Hard constraints visibly eliminate candidates.
- Weight changes update ranking.
- Stale catalog data is clearly flagged.
- Recommendation exports with assumptions.

