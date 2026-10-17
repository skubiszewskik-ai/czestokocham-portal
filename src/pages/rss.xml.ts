import type { APIRoute } from 'astro';
import { latest } from '../lib/db';
import { SITE, articleUrl } from '../lib/site';
import { esc } from '../lib/xml';
export const GET: APIRoute = async ({ site }) => {
  const items = await latest({ limit: 40 });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(SITE.name)}</title><link>${site}</link><description>${esc(SITE.description)}</description><language>pl</language>
${items
  .map((a) => {
    const u = new URL(articleUrl(a), site).toString();
    return `<item><title>${esc(a.title)}</title><link>${u}</link><guid>${u}</guid><pubDate>${a.publishedAt.toUTCString()}</pubDate><description>${esc(a.lead)}</description></item>`;
  })
  .join('\n')}
</channel></rss>`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
};
