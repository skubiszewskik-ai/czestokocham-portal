import type { APIRoute } from 'astro';
import { latest } from '../lib/db';
import { SITE, articleUrl } from '../lib/site';
import { esc } from '../lib/xml';
// Google News: artykuły z ostatnich 48 godzin
export const GET: APIRoute = async ({ site }) => {
  const since = Date.now() - 48 * 3600e3;
  const items = (await latest({ limit: 200 })).filter((a) => +a.publishedAt > since);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${items
  .map((a) => `<url><loc>${new URL(articleUrl(a), site)}</loc><news:news><news:publication><news:name>${esc(SITE.name)}</news:name><news:language>pl</news:language></news:publication><news:publication_date>${a.publishedAt.toISOString()}</news:publication_date><news:title>${esc(a.title)}</news:title></news:news></url>`)
  .join('\n')}
</urlset>`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
