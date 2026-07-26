/**
 * THE ROUTE CONTRACT.
 *
 * Every href in NAV_ITEMS must resolve to a real page in dist. This
 * file is the single list that SiteHeader and SiteFooter read, so a
 * dead link here is a dead link everywhere, and tests/check-links.sh
 * catches it.
 *
 * 01-INFORMATION-ARCHITECTURE.md defines the routes:
 *
 *   /                the modular tool directory (the landing page)
 *   /tools/[slug]    canonical tool route, generated per released tool
 *   /about           what the workbench is and is not
 *   /privacy         data handling explanation
 *
 * There is NO /tools index route. Do not add one. Individual tool
 * routes are never listed here either: they are registry driven, and a
 * tool that is not `released` or `beta` has no route at all.
 */

export interface NavItem {
  /** Absolute site path. Must resolve. */
  href: string;
  /** Visible link text. */
  label: string;
  /** Longer form for title and aria-label where a nav label is terse. */
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Tools', description: 'The full tool directory' },
  { href: '/about', label: 'About', description: 'What this workbench is and is not' },
  { href: '/privacy', label: 'Privacy', description: 'How your input is handled' },
];

/** The site name, in one place, so header, footer, and titles agree. */
export const SITE_NAME = 'Nixfred AI Systems Workbench';

/** Where the workbench came from. External, opens in a new tab. */
export const PARENT_SITE = {
  href: 'https://nixfred.com',
  label: 'nixfred.com',
};

/**
 * Trailing slash tolerant path compare. astro.config sets
 * trailingSlash: 'never', but a hand typed URL or a proxy can still
 * hand us "/about/", and the current page marker must survive that.
 */
export function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  const stripped = pathname.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** True when `href` is the page currently being rendered. */
export function isCurrentPath(pathname: string, href: string): boolean {
  return normalizePath(pathname) === normalizePath(href);
}
