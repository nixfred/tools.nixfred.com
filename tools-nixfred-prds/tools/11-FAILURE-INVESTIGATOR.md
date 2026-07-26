# Tool PRD — Failure Investigator

## User outcome

Systematically narrow an AI-system failure using symptoms and available evidence.

## Workflow

Select or describe a symptom; add trace facts, prompt changes, model changes, retrieval evidence, tool results, and timing; walk a branching diagnostic path.

## Outputs

Ranked hypotheses, evidence for and against, next checks, containment actions, and incident notes.

## Boundaries

No claim of automatic root-cause certainty. The tool must distinguish diagnosis, inference, and missing evidence.

## Acceptance criteria

- Supports hallucination, retrieval, permission, tool, latency, loop, and cost incidents.
- No hypothesis is ranked without visible evidence.
- User can export an incident report.
- Destructive remediation is never auto-executed.

