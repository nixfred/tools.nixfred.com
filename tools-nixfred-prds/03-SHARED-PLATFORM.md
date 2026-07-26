# Shared Platform PRD

## Goal

Create the reusable site shell and contracts required by all tools without implementing any tool.

## Requirements

- Shared header, footer, navigation, tool layout, and error boundary
- Registry-driven tool metadata
- Consistent input, result, assumption, help, warning, and export components
- Responsive keyboard-accessible UI
- Theme tokens that match the Nixfred laboratory aesthetic
- Local project persistence with schema versioning
- URL-safe share state only for small, non-sensitive inputs
- Privacy notice near any import or paste surface
- Lightweight event hooks that do not capture pasted content

## Registry contract

Each tool entry contains:

- `slug`, `name`, `shortDescription`, `category`, `tags`
- `status`, `version`, `iconKey`
- `inputSensitivity`, `supportsSample`, `supportsExport`
- `route`, `prdId`

The landing page renders from this registry. Tool implementations may not edit landing-page markup.

## Tool-module contract

Each released tool supplies:

- Route entry
- Tool metadata
- Empty state
- Sample state
- Input validation
- Result view
- Reset behavior
- Optional export adapter
- Tool-specific tests

## Explicit exclusions

- No tool algorithms
- No authentication
- No backend database
- No model-provider integration
- No cards for imaginary tools

## Acceptance criteria

- A dummy development fixture can register and unregister without changing landing-page code.
- Hidden tools produce no public route or navigation item.
- Shared components pass keyboard and contrast checks.
- Stored data includes a version and can be cleared globally.

