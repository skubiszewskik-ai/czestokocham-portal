import type { APIRoute } from 'astro';
import { allArticles } from '../lib/db';
import { CATEGORIES, articleUrl } from '../lib/site';
import { allEvents, eventUrl, whenText } from '../lib/events';
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
  const events = allEvents().slice(0, 80).map((e) => ({
    t: e.title,
    y: e.type,
    p: e.place,
    w: e.dates.slice(0, 4).map(whenText).join('; '),
    u: eventUrl(e),
  }));
  return new Response(JSON.stringify({ at: new Date().toISOString(), news, events }), { headers: { 'content-type': 'application/json' } });
};
