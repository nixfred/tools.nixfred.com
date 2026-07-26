# Tool PRD — Agent Designer

## User outcome

Design and simulate a bounded AI agent or agent team before implementing it.

## Modes

- Architecture: role, instructions, tools, memory, triggers, and exit conditions
- Mission: steps and tool calls for a sample task
- Team: delegation and handoffs
- Observatory: timeline, state, cost estimate, failures, and recovery

## Outputs

Agent specification, authority map, memory plan, handoff contract, simulated trace, unresolved risks, and implementation checklist.

## Boundaries

This is not a production runtime. All traces are visibly simulated. Permission planning uses the shared export contract but remains a separate tool.

## Acceptance criteria

- A single-agent sample works before team mode is introduced.
- Every action maps to an explicit permission.
- Loops require limits and exit conditions.
- Simulation distinguishes observation, decision, action, result, and memory.

