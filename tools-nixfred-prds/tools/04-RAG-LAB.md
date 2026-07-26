# Tool PRD — Retrieval Lab

## User outcome

See how chunking, retrieval, and ranking choices change the evidence available to an answer.

## Workflow

Load included sample documents or paste text; select chunk size, overlap, retrieval count, and ranking strategy; enter a query.

## Outputs

Chunks, scores, selected evidence, missed evidence, and a grounded answer template with citations.

## Boundaries

Initial release uses transparent local retrieval. It must not claim semantic equivalence to a production embedding model.

## Acceptance criteria

- Every selected passage can be traced to its source.
- User can compare two configurations.
- The UI exposes why a chunk ranked.
- Pasted data remains local.

