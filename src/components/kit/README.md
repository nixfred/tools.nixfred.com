# Tool UI kit

The shared component surface every tool builds against. Import from
`src/components/kit` rather than from individual files.

These components are deliberately empty of tool logic. They frame,
label, warn, and dispatch. They never compute, never serialize, and
never hold tool state. That separation is what lets the platform
satisfy 02-BUILD-CONTROL.md, which forbids a tool PRD from altering a
shared contract.

## Components

| Component | Purpose | PRD line it satisfies |
|---|---|---|
| `Field.astro` | Labeled input wrapper with hint, error, and the aria wiring | 03-SHARED-PLATFORM.md, "Consistent input ... components" |
| `ResultPanel.astro` | The inspectable result surface, including a stale state when inputs change after a result | 00-PRODUCT-VISION.md principle 2, "Inputs must produce an inspectable result" |
| `AssumptionList.astro` | Visible, editable assumptions with their source | 00-PRODUCT-VISION.md principle 3, "Assumptions must be visible and editable" |
| `HelpNote.astro` | Inline teaching note, collapsible, no JavaScript | 00-PRODUCT-VISION.md principle 5, "teach through use without becoming textbook chapters" |
| `WarningNote.astro` | Info, warning, and alert tiers with correct live region roles | 03-SHARED-PLATFORM.md, "warning ... components" |
| `ExportBar.astro` | Dispatches an export intent for the tool's own adapter to answer | 03-SHARED-PLATFORM.md, "Optional export adapter" |
| `EmptyState.astro` | Pre input state that offers the sample in one click | 00-PRODUCT-VISION.md principle 7, "A tool must work with sample data" |
| `PrivacyNotice.astro` | States plainly that input stays on the device, scaled to sensitivity | 03-SHARED-PLATFORM.md, "Privacy notice near any import or paste surface" |
| `ErrorBoundary.astro` | Contains a runtime failure to a readable panel instead of a dead region | 03-SHARED-PLATFORM.md, "error boundary" |

## Event contract

The kit never owns state. It communicates by dispatching bubbling
`CustomEvent`s that a tool listens for.

1. `workbench:export` carries `{ format, filename, resolve }`. The tool
   serializes and calls `resolve(text)`. A tool that does not answer
   within 250ms gets a plain "no exportable result yet" message rather
   than a spinner that lies.
2. `workbench:load-sample` asks the tool to install its sample state.
3. `workbench:edit-assumption` carries the assumption key the visitor
   wants to change.

## House rules for anything added here

1. Tokens are law. No raw hex, no `rgba()`. Every color comes from
   `src/styles/tokens.css`, and `tests/check-copy.sh` enforces it.
2. No dash punctuation in copy. Periods and commas.
3. State is never conveyed by color alone. Always pair it with a word
   or a shape.
4. Nothing may reach the network. `tests/check-safety.sh` greps the
   built output for `fetch` and `XMLHttpRequest`.
