# Tool PRD — Token & Cost Planner

## User outcome

Estimate context usage, request cost, monthly cost, and headroom using editable assumptions.

## Inputs

Model pricing profile, system prompt size, input/output tokens, requests, retry rate, cache rate, and time period.

## Outputs

Cost breakdown, token allocation, scenario comparison, major cost driver, and threshold warnings.

## Boundaries

Pricing data must show its effective date and remain editable. Results are estimates, never billing claims.

## Acceptance criteria

- Supports custom pricing and two-scenario comparison.
- Every formula and assumption is visible.
- Currency rounding does not corrupt underlying calculations.
- Results export as JSON or CSV.

