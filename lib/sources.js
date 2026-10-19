// Portale obserwowane przez wirtualnego redaktora (odczyt tekstu; zdjęcie bierzemy tylko przy tekstach o konkretnej osobie – lib/images.js)
import * as cheerio from 'cheerio';
import { fetchText } from './scraper.js';

export const SOURCES = [
  { name: 'miejska.pl', type: 'wp', base: 'https://miejska.pl' },
  { name: 'zycieczestochowy.pl', type: 'wp', base: 'https://zycieczestochowy.pl' },
  { name: 'gazetacz.com.pl', type: 'wp', base: 'https://gazetacz.com.pl' },
  { name: 'wpowiecie.pl', type: 'wp', base: 'https://wpowiecie.pl' },
  { name: 'czestochowskie24.pl', type: 'wp', base: 'https://czestochowskie24.pl' },
  { name: 'czestochowskie.pl', type: 'wp', base: 'https://czestochowskie.pl' },
  { name: 'czestochowaonline.pl', type: 'wp', base: 'https://www.czestochowaonline.pl' },
  { name: 'Radio Jura', type: 'wp', base: 'https://www.radiojura.pl' }, // lokalne radio – dużo krótkich komunikatów (MZD, starostwo, policja)
  { name: 'Radio Fiat', type: 'wp', base: 'https://fiat.fm' }, // częstochowskie radio – część wpisów kościelnych/krajowych odsiewa redaktor
  { name: 'gazetaregionalna.com', type: 'wp', base: 'https://gazetaregionalna.com' }, // powiaty częstochowski, kłobucki, myszkowski, lubliniecki
  { name: 'zycieregionu.com.pl', type: 'rss', base: 'https://zycieregionu.com.pl', feed: 'https://zycieregionu.com.pl/feed/' },
  { name: 'sport.czest.pl', type: 'wp', base: 'https://sport.czest.pl' }, // wyniki i zapowiedzi lokalnego sportu
  { name: 'Włókniarz Częstochowa', type: 'wp', official: true, base: 'https://www.wlokniarz.com' }, // komunikaty klubu
  // komunikaty policji – materiał urzędowy, można go swobodnie opracowywać
  { name: 'KMP Częstochowa', type: 'rss', official: true, base: 'https://czestochowa.policja.gov.pl', feed: 'https://czestochowa.policja.gov.pl/dokumenty/rss/42-rss-2341.rss' },
  { name: 'KPP Kłobuck', type: 'rss', official: true, base: 'https://klobuck.policja.gov.pl', feed: 'https://klobuck.policja.gov.pl/dokumenty/rss/47-rss-o-274.rss' },
  { name: 'KPP Myszków', type: 'rss', official: true, base: 'https://myszkow.policja.gov.pl', feed: 'https://myszkow.policja.gov.pl/dokumenty/rss/52-rss-o-294.rss' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => cheerio.load(`<div>${s || ''}</div>`).text();

/** HTML → czysty tekst z akapitami (bez skryptów, podpisów zdjęć i „czytaj też”) */
export function htmlToText(html) {
  const $ = cheerio.load(`<div id="r">${html || ''}</div>`);
  $('#r').find('script,style,iframe,figure,figcaption,noscript,form,.wp-block-embed,.sharedaddy,.jp-relatedposts').remove();
  const parts = [];
  $('#r').find('p,h2,h3,h4,li,blockquote').each((_, el) => {
    if ($(el).find('p,li').length) return;
    const t = $(el).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  });
  const out = parts.length ? parts.join('\n\n') : $('#r').text().replace(/\s+/g, ' ').trim();
  return out.replace(/\n\n(czytaj (też|także|również)|zobacz (też|także|również))[^\n]*$/gim, '');
}

/** Treść strony bez szablonu: element z największą liczbą akapitów */
export function mainText(html) {
  const $ = cheerio.load(html);
  $('script,style,nav,header,footer,aside,form,noscript').remove();
  let best = null;
  let bestLen = 0;
  $('article, main, section, div').each((_, el) => {
    const len = $(el).children('p').text().length;
    if (len > bestLen) { best = el; bestLen = len; }
  });
  return best ? htmlToText($(best).html()) : '';
}

async function fetchWp(src, since) {
  const url = `${src.base}/wp-json/wp/v2/posts?per_page=20&after=${encodeURIComponent(since.toISOString())}&_fields=id,date_gmt,link,title,excerpt,content,sticky`;
  const posts = JSON.parse(await fetchText(url));
  const items = posts.map((p) => ({
    source: src.name,
    official: !!src.official,
    url: p.link,
    title: decode(p.title?.rendered).trim(),
    lead: decode(p.excerpt?.rendered).replace(/\s*(\[…\]|\[\.\.\.\]|…)\s*$/, '').trim(),
    text: htmlToText(p.content?.rendered),
    date: new Date(`${p.date_gmt}Z`),
  }));
  // część portali nie oddaje treści w API (np. kreator stron) – wtedy czytamy samą stronę artykułu
  for (const it of items) {
    if (it.text.length > 200) continue;
    await sleep(1500);
    try { it.text = mainText(await fetchText(it.url)); } catch {}
  }
  return items;
}

async function fetchRss(src, since) {
  const $ = cheerio.load(await fetchText(src.feed), { xml: true });
  const items = $('item').map((_, el) => ({
    url: $(el).find('link').text().trim(),
    title: $(el).find('title').text().trim(),
    lead: decode($(el).find('description').text()).trim(),
    date: new Date($(el).find('pubDate').text()),
  })).get().filter((i) => i.url && i.date > since);
  const out = [];
  for (const it of items) {
    await sleep(1500);
    try {
      out.push({ ...it, source: src.name, official: !!src.official, text: mainText(await fetchText(it.url)) });
    } catch {
      out.push({ ...it, source: src.name, official: !!src.official, text: it.lead });
    }
  }
  return out;
}

/** Wpisy ze wszystkich portali z ostatnich `days` dni; awaria jednego portalu nie zatrzymuje reszty */
export async function fetchCompetitors({ days = 7, log = console.log, sources = SOURCES } = {}) {
  const since = new Date(Date.now() - days * 864e5);
  const all = [];
  for (const src of sources) {
    try {
      const items = src.type === 'rss' ? await fetchRss(src, since) : await fetchWp(src, since);
      all.push(...items.filter((i) => i.title && i.text.length > 200));
      log(`${src.name}: ${items.length} wpisów`);
    } catch (e) {
      log(`${src.name}: błąd ${e.message}`);
    }
    await sleep(1500);
  }
  return all;
}
