# Tool PRD — Context Packer

## User outcome

Choose what information fits into a finite model context and see what gets dropped or compressed.

## Workflow

Add labeled context blocks, priorities, token estimates, and required/optional status; choose a budget and packing strategy.

## Outputs

Packed order, excluded blocks, remaining capacity, truncation risk, and suggested summarization targets.

## Boundaries

This is a planning simulator, not a tokenizer guarantee. Token estimates must be labeled by method.

## Acceptance criteria

- Drag or keyboard controls change priority.
- Multiple packing strategies produce explainable results.
- Required content can never be silently dropped.
- Includes a realistic agent-task sample.

