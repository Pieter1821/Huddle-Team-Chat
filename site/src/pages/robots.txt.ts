import type { APIRoute } from 'astro';

/** robots.txt with the sitemap's full address (search engines need an absolute URL). */
export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL('/sitemap-index.xml', site)}\n`, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
