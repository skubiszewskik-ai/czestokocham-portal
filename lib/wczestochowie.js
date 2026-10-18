// Pobieranie aktualności z wczestochowie.pl (WordPress REST API) – za zgodą redakcji
import * as cheerio from 'cheerio';
import { fetchText, sanitizeHtml } from './scraper.js';

export const WCZ_BASE = 'https://wczestochowie.pl';
const API = `${WCZ_BASE}/wp-json/wp/v2`;
const SPORT = 29;
const REGION = 28;
const SPONSORED = new Set([28363, 28161]); // artykuły partnera i sponsorowane – nie przedrukowujemy
export const WCZ_DELAY = 3000; // przerwa między zapytaniami do ich serwera (robots.txt: Crawl-delay)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (html) => cheerio.load(`<div>${html || ''}</div>`).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** Największy wariant z srcset (albo src) */
function bestSrc($, img) {
  const set = ($(img).attr('srcset') || '').split(',').map((s) => s.trim().split(/\s+/)).filter((x) => x[0]);
  set.sort((a, b) => parseInt(b[1] || '0', 10) - parseInt(a[1] || '0', 10));
  return set[0]?.[0] || $(img).attr('data-src') || $(img).attr('src') || null;
}

export function categoryFor(ids, parents) {
  const top = ids.map((id) => parents.get(id) || id);
  if (ids.includes(SPORT) || top.includes(SPORT)) return 'sport';
  if (ids.includes(REGION)) return 'powiat';
  return 'miasto';
}

/** Wpis z API → artykuł w formacie importera */
export function parsePost(post, parents = new Map()) {
  const html = post.content?.rendered || '';
  const $ = cheerio.load(html, null, false);
  const images = [];
  const add = (u) => {
    if (!u || !/^https?:/.test(u)) return;
    const key = u.replace(/-\d+x\d+(\.\w+)$/, '$1');
    if (!images.some((x) => x.replace(/-\d+x\d+(\.\w+)$/, '$1') === key)) images.push(u);
  };
  add(post._embedded?.['wp:featuredmedia']?.[0]?.source_url);
  $('img').each((_, img) => add(bestSrc($, img)));
  const captions = $('figcaption').map((_, f) => $(f).text().trim()).get().join('\n');

  let lead = text(post.excerpt?.rendered).replace(/\s*(\[(…|&hellip;|\.\.\.)\]|…)$/, '');
  let body = sanitizeHtml(html, WCZ_BASE);
  // gdy zajawka jest jednocześnie pierwszym akapitem treści – nie powtarzamy jej
  const $b = cheerio.load(body, null, false);
  const first = $b('p').first();
  if (lead && first.length && text(first.html()).startsWith(lead.slice(0, 80))) {
    first.remove();
    body = $b.html().trim();
  }
  const plain = `${text(body)}\n${captions}`;
  const photoCredit = (plain.match(/Fot(?:o|\.)\s*:?\s*([^\n]+?)(?:\n|$)/i) || [])[1]?.trim().slice(0, 120) || null;

  return {
    slug: post.slug,
    url: post.link,
    title: text(post.title?.rendered),
    lead,
    body,
    images,
    photoCredit,
    date: new Date(`${post.date_gmt}Z`),
    category: categoryFor(post.categories || [], parents),
    sponsored: (post.categories || []).some((c) => SPONSORED.has(c)),
  };
}

/** Najnowsze wpisy (jedno zapytanie o kategorie + jedno o wpisy) */
export async function fetchLatestPosts({ perPage = 30 } = {}) {
  const cats = JSON.parse(await fetchText(`${API}/categories?per_page=100&_fields=id,parent`));
  const parents = new Map(cats.filter((c) => c.parent).map((c) => [c.id, c.parent]));
  await sleep(WCZ_DELAY);
  const posts = JSON.parse(await fetchText(`${API}/posts?per_page=${perPage}&_embed=wp:featuredmedia`));
  return posts.map((p) => parsePost(p, parents));
}
