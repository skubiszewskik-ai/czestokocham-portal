import type { APIRoute } from 'astro';
export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /r/\n\nSitemap: ${new URL('/sitemap.xml', site)}\nSitemap: ${new URL('/sitemap-news.xml', site)}\n`, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
