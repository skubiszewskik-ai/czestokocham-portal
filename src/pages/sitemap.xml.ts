import type { APIRoute } from 'astro';
import { latest } from '../lib/db';
import { CATEGORY_KEYS, articleUrl } from '../lib/site';
export const GET: APIRoute = async ({ site }) => {
  const items = await latest({ limit: 1000 });
  const urls = [
    ['/', new Date()],
    ...CATEGORY_KEYS.map((k) => [`/${k}`, new Date()]),
    ['/o-nas', null], ['/reklama', null], ['/regulamin', null], ['/polityka-prywatnosci', null],
    ...items.map((a) => [articleUrl(a), a.updatedAt || a.publishedAt]),
  ] as [string, Date | null][];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(([p, d]) => `<url><loc>${new URL(p, site)}</loc>${d ? `<lastmod>${d.toISOString()}</lastmod>` : ''}</url>`)
    .join('\n')}\n</urlset>`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
