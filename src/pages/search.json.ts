import type { APIRoute } from 'astro';
import { allArticles } from '../lib/db';
import { CATEGORIES, articleUrl } from '../lib/site';
// Indeks wyszukiwarki (ładowany tylko na stronie /szukaj)
export const GET: APIRoute = () => {
  const rows = allArticles().map((a) => ({
    t: a.title,
    u: articleUrl(a),
    c: CATEGORIES[a.category]?.name || '',
    d: a.publishedAt.toISOString().slice(0, 10),
    k: a.keywords.join(' '),
    i: a.cover?.srcset?.[0]?.url || '',
  }));
  return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
};
