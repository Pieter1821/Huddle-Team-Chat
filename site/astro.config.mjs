// The public Huddle website: landing page and documentation, built to static files and served by
// its own Cloudflare Worker (see wrangler.jsonc). Nothing here runs on the Huddle app itself.
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://huddlechat.co.za',
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [mdx(), sitemap(), react()],
  markdown: {
    shikiConfig: { theme: 'github-dark-default', wrap: false },
  },
  image: { responsiveStyles: false },
  devToolbar: { enabled: false },
});
