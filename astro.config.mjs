// @ts-check
import { defineConfig } from 'astro/config';

// Nixfred AI Systems Workbench. Static output, Cloudflare Pages, no adapters.
export default defineConfig({
  site: 'https://tools.nixfred.com',
  output: 'static',
  trailingSlash: 'never',
  build: {
    format: 'file',
  },
});
