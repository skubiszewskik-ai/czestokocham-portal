import type { APIRoute } from 'astro';
import { allArticles } from '../lib/db';
import { CATEGORIES, articleUrl } from '../lib/site';
import { allEvents, eventUrl, today, whenText } from '../lib/events';
// Wiedza asystenta czatu (worker/index.js): świeże wiadomości i nadchodzące wydarzenia, w skrócie
export const GET: APIRoute = () => {
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const news = allArticles().slice(0, 120).map((a) => ({
    t: a.title,
    l: cut(a.lead.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 220),
    c: CATEGORIES[a.category]?.name || '',
    d: a.publishedAt.toISOString().slice(0, 10),
    u: articleUrl(a),
  }));
  // tylko przyszłe terminy, od najbliższego wydarzenia
  const events = allEvents()
    .map((e) => ({ e, dates: e.dates.filter((d) => d.day >= today()) }))
    .filter((x) => x.dates.length)
    .sort((a, b) => a.dates[0].day.localeCompare(b.dates[0].day))
    .slice(0, 80)
    .map(({ e, dates }) => ({ t: e.title, y: e.type, p: e.place, w: dates.slice(0, 4).map(whenText).join('; '), d: dates.slice(0, 31).map((x) => x.day), u: eventUrl(e) }));
  return new Response(JSON.stringify({ at: new Date().toISOString(), news, events }), { headers: { 'content-type': 'application/json' } });
};
