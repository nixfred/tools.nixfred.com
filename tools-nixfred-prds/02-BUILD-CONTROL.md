# Claude Code Build-Control Protocol

## Purpose

Prevent a broad product plan from being interpreted as permission to build the entire site in one pass.

## Unit of work

One execution may cover exactly one named PRD. Shared-platform work and landing-page work are separate executions. Each tool is a separate execution.

## Required operator prompt

> Implement only `[exact PRD path]`. Other PRDs are context and future scope, not implementation instructions. Do not create placeholder implementations for future tools. Stop when this PRD's acceptance criteria pass.

## Mandatory preflight response

Before editing, Claude Code must state:

- The named PRD
- The routes it will touch
- The expected files or modules it will touch
- Explicitly excluded work
- Its verification plan

If the scope includes more than one tool route, it must stop and ask permission.

## Implementation constraints

- Do not “helpfully” build adjacent tools.
- Do not add dependencies needed only by future PRDs.
- Do not alter shared contracts from a tool PRD. Propose the change and stop.
- Do not expose cards for unfinished tools unless the landing PRD explicitly requests a coming-soon card.
- Do not call external model APIs unless the selected PRD explicitly authorizes them.
- Use deterministic local simulation for sample experiences.
- Preserve existing working tools.

## Completion report

Claude Code must report:

1. Scope completed
2. Files changed
3. Tests and checks run
4. Acceptance criteria status
5. Known limitations
6. Recommended next PRD, without implementing it

## Gate between PRDs

The operator reviews and commits each completed PRD before starting another. A failed or partially accepted PRD remains the only active scope.

