# Information Architecture PRD

## Routes

- `/` — modular tool directory
- `/tools/[slug]` — canonical tool route
- `/about` — what the workbench is and is not
- `/privacy` — data-handling explanation

Do not create a new subdomain per tool.

## Categories

- Design
- Build
- Evaluate
- Operate
- Understand

Categories are metadata, not hard-coded page sections. A tool may have one primary category and multiple tags.

## Initial tool registry

| Slug | Name | Category | Initial release |
|---|---|---|---|
| `prompt-lab` | Prompt Laboratory | Build | Yes |
| `token-planner` | Token & Cost Planner | Design | Yes |
| `context-packer` | Context Packer | Design | Yes |
| `rag-lab` | Retrieval Lab | Build | Later |
| `model-selector` | Model Selector | Design | Later |
| `eval-workbench` | Evaluation Workbench | Evaluate | Later |
| `workflow-decomposer` | Workflow Decomposer | Design | Later |
| `agent-designer` | Agent Designer | Build | Later |
| `permission-planner` | Permission Planner | Design | Later |
| `latency-budgeter` | Latency Budgeter | Operate | Later |
| `failure-investigator` | Failure Investigator | Operate | Later |
| `drift-monitor` | Drift Monitor | Operate | Later |
| `signal-tester` | Signal Tester | Evaluate | Later |
| `stack-mapper` | AI Stack Mapper | Understand | Later |

## Consolidations

- Agent Observatory, Mission Control, Fleet Command, autonomy, and handoffs become modes or panels inside Agent Designer.
- AI Failure Atlas and AI Incident Room become Failure Investigator.
- “Where the Tokens Go” becomes Token & Cost Planner.
- “Inside the Request” becomes a trace mode inside Stack Mapper.
- RAG and context remain separate because they answer different user questions.

## Tool states

Each registry item has one state:

- `released`: visible and usable
- `beta`: visible with a clear badge
- `coming-soon`: optional on landing page, never linked as usable
- `hidden`: absent from public navigation

No route should be generated for `hidden` or unimplemented tools.

