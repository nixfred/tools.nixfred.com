/**
 * DEVELOPMENT FIXTURES.
 *
 * 03-SHARED-PLATFORM.md acceptance criterion 1: "A dummy development
 * fixture can register and unregister without changing landing-page
 * code."
 * 04-LANDING-PAGE.md acceptance criterion 1: "Adding a development
 * fixture requires no landing component change."
 *
 * This file IS that proof. Entries here are merged into the registry
 * only when import.meta.env.DEV is true, so they exercise search,
 * filters, featured placement, the grid, and routing during
 * development and are absent from every production build.
 *
 * To unregister: empty the array. Nothing else in the codebase
 * changes. tests/check-registry.mjs asserts both directions.
 */

import type { ToolEntry } from './types';

export const devFixtures: ToolEntry[] = [
  {
    slug: 'fixture-released',
    name: 'Fixture: Released Tool',
    shortDescription:
      'Development fixture proving a released entry becomes actionable, routable, and searchable with no landing-page edit.',
    category: 'Understand',
    tags: ['fixture', 'development', 'released'],
    status: 'released',
    version: '0.0.1',
    iconKey: 'beaker',
    inputSensitivity: 'none',
    supportsSample: true,
    supportsExport: true,
    route: '/tools/fixture-released',
    prdId: 'fixture/dev-only',
  },
  {
    slug: 'fixture-beta',
    name: 'Fixture: Beta Tool',
    shortDescription:
      'Development fixture proving a beta entry renders its badge and stays actionable.',
    category: 'Evaluate',
    tags: ['fixture', 'development', 'beta'],
    status: 'beta',
    version: '0.0.1',
    iconKey: 'beaker',
    inputSensitivity: 'low',
    supportsSample: true,
    supportsExport: false,
    route: '/tools/fixture-beta',
    prdId: 'fixture/dev-only',
  },
  {
    slug: 'fixture-hidden',
    name: 'Fixture: Hidden Tool',
    shortDescription:
      'Development fixture proving a hidden entry produces no card, no route, and no navigation item.',
    category: 'Operate',
    tags: ['fixture', 'development', 'hidden'],
    status: 'hidden',
    version: '0.0.1',
    iconKey: 'beaker',
    inputSensitivity: 'none',
    supportsSample: false,
    supportsExport: false,
    route: '/tools/fixture-hidden',
    prdId: 'fixture/dev-only',
  },
];
