// Pobieranie aktualności z czestochowa.pl – parser i obróbka zdjęć
import * as cheerio from 'cheerio';
import sharp from 'sharp';

export const SOURCE_BASE = 'https://www.czestochowa.pl';
export const LIST_URL = `${SOURCE_BASE}/aktualnosci`;
const UA = 'Mozilla/5.0 (compatible; CzestokochamBot/1.0; +https://czestokocham.com)';

export async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'pl' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return res.text();
}

export async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const abs = (href, base = SOURCE_BASE) => new URL(href, base + '/').toString().replace(/\?background=$/, '');

/** Lista artykułów z jednej strony aktualności */
export function parseList(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.newscategory_element .item').each((_, el) => {
    const a = $(el).find('.media-body a').first();
    const href = a.attr('href');
    if (!href) return;
    const url = abs(href);
    const slug = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
    if (!/^[a-z0-9-]+$/.test(slug)) return;
    items.push({
      slug,
      url,
      date: $(el).find('.news-date').text().trim(),
      title: a.find('h3').text().trim(),
      lead: a.find('p').text().trim(),
    });
  });
  return items;
}

const ALLOWED = new Set(['p', 'b', 'strong', 'i', 'em', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'br', 'blockquote']);

/** Czyści HTML do bezpiecznego podzbioru tagów */
export function sanitizeHtml(html, base = SOURCE_BASE) {
  const $ = cheerio.load(`<div id="root">${html}</div>`, null, false);
  const root = $('#root');
  root.find('script,style,iframe,img,figure,table').remove();
  root.find('*').each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    const node = $(el);
    if (!ALLOWED.has(tag)) {
      node.replaceWith(node.contents());
      return;
    }
    const href = tag === 'a' ? node.attr('href') : null;
    for (const name of Object.keys(el.attribs || {})) node.removeAttr(name);
    if (href) {
      const full = abs(href, base);
      node.attr('href', full);
      if (!full.startsWith(base)) node.attr('rel', 'noopener nofollow').attr('target', '_blank');
    }
  });
  root.find('b').each((_, el) => { el.tagName = 'strong'; });
  root.find('i').each((_, el) => { el.tagName = 'em'; });
  root.find('p').each((_, el) => {
    if (!$(el).text().replace(/ /g, ' ').trim()) $(el).remove();
  });
  return root.html().replace(/(<br\s*\/?>\s*){2,}/g, '<br>').replace(/<p>\s*<br>/g, '<p>').trim();
}

/** TYTUŁ WERSALIKAMI → zdanie, z wielkimi literami nazw własnych znalezionych w treści */
export function titleCase(title, text) {
  const letters = title.replace(/[^\p{L}]/gu, '');
  if (!letters || letters !== letters.toUpperCase()) return title.trim();
  const known = new Map();
  for (const m of text.matchAll(/(?<=[\p{L}\d,;:–-]\s+|\(|„)(\p{Lu}[\p{L}\d-]*)/gu)) {
    const w = m[1];
    if (w.length > 1 && w !== w.toUpperCase()) known.set(w.toLowerCase(), w);
  }
  for (const m of text.matchAll(/(?:ul|al|pl|os|im|św)\.\s+(\p{Lu}\p{Ll}+)(?:\s+(\p{Lu}\p{Ll}+))?/gu)) {
    for (const w of [m[1], m[2]]) if (w) known.set(w.toLowerCase(), w);
  }
  for (const m of text.matchAll(/\b(\p{Lu}{2,}[\d-]*)\b/gu)) known.set(m[1].toLowerCase(), m[1]); // skróty: SP, MPK, MOSiR
  let first = true;
  return title
    .trim()
    .toLowerCase()
    .replace(/[\p{L}\d-]+/gu, (w) => {
      let out = known.get(w) || w;
      if (/^(sp|mdk|um|mpk|mzd|pks|ue|ii|iii|iv|xx|xxi)$/.test(w)) out = w.toUpperCase();
      if (first) { out = out.charAt(0).toUpperCase() + out.slice(1); first = false; }
      return out;
    })
    .replace(/([.!?]\s+)(\p{Ll})/gu, (_, p, c) => p + c.toUpperCase());
}

const SPORT_STRONG = /(rks raków|raków częstochowa|włókniar|mecz|ekstraklas|żużl|siatkar|siatków|piłkar|koszykar|turniej|mistrzost|maraton|olimpi|zawodnik|zawodnicz|trener|ligow)/i;
const SPORT_TITLE = /(sport|bieg|zawody|liga|ligi)/i;
export const guessCategory = (title, lead) =>
  SPORT_STRONG.test(`${title} ${lead}`) || SPORT_TITLE.test(title) ? 'sport' : 'miasto';

/** Pełny artykuł */
export function parseArticle(html, url) {
  const $ = cheerio.load(html);
  const right = $('.right-news');
  const rawTitle = right.find('.headlines-element h3').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
  const date = right.find('.news-date').first().text().trim();
  const body = sanitizeHtml(right.find('.text-element').first().html() || '');
  const plain = cheerio.load(body).text();
  const images = [];
  const seen = new Set();
  $('.left-news a[data-fancybox="gallery"]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    const u = abs(href);
    if (seen.has(u)) return;
    seen.add(u);
    images.push(u);
  });
  const photoCredit = (plain.match(/Fot\.\s*([^\n]+?)(?:\n|$)/) || [])[1]?.trim() || null;
  // lead = pogrubiony początek pierwszego akapitu
  const $b = cheerio.load(body, null, false);
  const firstP = $b('p').first();
  let lead = '';
  const firstNode = firstP.contents().first();
  if (firstNode.length && firstNode[0].tagName === 'strong') {
    lead = firstNode.text().replace(/ /g, ' ').trim();
    firstNode.remove();
    firstP.contents().first().filter((_, n) => n.tagName === 'br').remove();
    if (!firstP.text().trim()) firstP.remove();
  }
  return { url, rawTitle, title: titleCase(rawTitle, plain), date, lead, body: $b.html().trim(), images, photoCredit };
}

/** dd.mm.yyyy → Date (starsze: 12:00 czasu PL; dzisiejsze albo nieczytelne: `today`, domyślnie teraz) */
export function parsePlDate(s, today = new Date()) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((s || '').trim());
  if (!m) return today;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 10, 0, 0));
  return d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? today : d;
}

/** Zdjęcie → warianty WebP: [{width, height, buffer}] */
export async function toWebpVariants(input, widths, quality = 68) {
  const meta = await sharp(input).metadata();
  const srcW = meta.width || widths[widths.length - 1];
  const targets = [...new Set(widths.map((w) => Math.min(w, srcW)))];
  const out = [];
  for (const w of targets) {
    const { data, info } = await sharp(input)
      .rotate()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality, effort: 6, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    out.push({ width: info.width, height: info.height, buffer: data });
  }
  return out;
}
