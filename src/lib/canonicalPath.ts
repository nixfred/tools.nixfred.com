/**
 * Canonical path normalization.
 *
 * WHY THIS EXISTS. astro.config.mjs sets `build.format: 'file'`, so every
 * page is emitted as `<name>.html` and `Astro.url.pathname` carries that
 * extension at build time. Every internal link in the site, and the
 * `route` field on every registry entry, uses the EXTENSIONLESS form
 * (`/tools/drift-monitor`). Cloudflare Pages serves both.
 *
 * The result before this was fixed: the site advertised
 * `/tools/drift-monitor.html` as its canonical URL and its og:url, while
 * linking exclusively to `/tools/drift-monitor`. Two URLs for one page,
 * with the canonical pointing at the one nothing links to. That splits
 * link equity, and it became visible to people the moment the share
 * sheet started handing out URLs.
 *
 * Normalizing here rather than at each call site means canonical,
 * og:url, twitter, and the share sheet cannot drift apart from each
 * other again.
 */

/**
 * Strip the `.html` Astro adds under `build.format: 'file'`, and collapse
 * an index page to its directory.
 *
 * Examples:
 *   /index.html              -> /
 *   /about.html              -> /about
 *   /tools/drift-monitor.html -> /tools/drift-monitor
 *   /                        -> /            (already canonical)
 */
export function canonicalPath(pathname: string): string {
  let p = pathname;

  // /index.html and /some/dir/index.html collapse to the directory.
  if (p === '/index.html') return '/';
  if (p.endsWith('/index.html')) {
    return p.slice(0, -'index.html'.length);
  }

  if (p.endsWith('.html')) {
    p = p.slice(0, -'.html'.length);
  }

  // Never return an empty string; the site root is '/'.
  return p === '' ? '/' : p;
}

/** The absolute canonical URL for a page, as a string. */
export function canonicalUrl(pathname: string, site: URL | undefined): string {
  return new URL(canonicalPath(pathname), site).toString();
}
