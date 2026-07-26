# Landing Page PRD

## Goal

Help a visitor choose a useful AI tool quickly while allowing the catalog to grow without redesign.

## Page structure

1. Compact hero: “Practical instruments for reliable AI systems.”
2. Search and category filters
3. Featured tools, selected through registry metadata
4. All released tools in a responsive grid
5. Short privacy and local-processing statement
6. About link and connection back to nixfred.com

## Tool card

Each card displays name, one-sentence outcome, category, status, and whether it runs locally. Cards use registry data only.

## Behavior

- Search matches name, description, category, and tags.
- Filters compose with search.
- Filter state may be represented in the URL.
- Released and beta tools are actionable.
- Coming-soon tools are visually distinct and disabled.
- Hidden tools never appear.
- Empty filter results suggest clearing filters.

## Modularity

Adding a conforming registry entry must automatically place the tool in search, filters, and the grid. Featured placement is controlled by metadata or a small ordered configuration list.

## Explicit exclusions

- No tool implementation
- No hard-coded card grid
- No account or newsletter capture
- No live “number of users” claims

## Acceptance criteria

- Adding a development fixture requires no landing component change.
- Search and filters are keyboard accessible.
- The page remains coherent with 3, 15, or 50 registered tools.
- Mobile view presents the same discoverability and status information.

