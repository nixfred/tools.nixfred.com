# Tool PRD — Latency Budgeter

## User outcome

Allocate a response-time budget across an AI request and identify the largest optimization opportunity.

## Inputs

Client, network, gateway, retrieval, model queue, inference, tools, retries, streaming, and concurrency assumptions.

## Outputs

Critical path, percentile estimates, waterfall, budget overruns, and scenario comparison.

## Boundaries

Results are planning estimates. The tool does not perform live network tests in its first release.

## Acceptance criteria

- Parallel and sequential stages calculate differently.
- Retry and tail-latency effects are visible.
- User can compare baseline and proposed designs.
- Formulas are inspectable.

