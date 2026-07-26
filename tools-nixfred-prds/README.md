# tools.nixfred.com — PRD Pack

This repository is the product framework for a modular AI Systems Workbench. It is intentionally not an implementation.

## Product

`tools.nixfred.com` is one coherent site containing practical, browser-based tools for designing, explaining, testing, and operating AI systems. It is not a directory of unrelated microsites and not a collection of essays.

## Documents

1. Read `00-PRODUCT-VISION.md`.
2. Read `01-INFORMATION-ARCHITECTURE.md`.
3. Read `02-BUILD-CONTROL.md`.
4. Build `03-SHARED-PLATFORM.md`.
5. Build `04-LANDING-PAGE.md`.
6. Select exactly one PRD from `tools/`.

## Non-negotiable build rule

Claude Code must implement only the PRD explicitly named by the operator. A tool PRD does not authorize implementation of another tool, even when another tool is linked, mentioned, mocked, or shown in navigation.

The operator should use:

> Implement only `[PRD filename]`. Read the shared product documents for constraints, but do not implement any other PRD. Stop after completing the acceptance checks and report the files changed, checks run, and remaining gaps.

## Suggested release order

- Foundation: shared platform and modular landing page
- First useful release: Prompt Laboratory, Token Planner, Context Packer
- AI-building suite: RAG Lab, Model Selector, Eval Workbench
- Agent suite: Workflow Decomposer, Agent Designer, Permission Planner
- Operations suite: Latency Budgeter, Failure Investigator, Drift Monitor
- Advanced suite: Signal Tester, Stack Mapper

