// Zdjęcie główne do szkicu redaktora. Kolejność:
// 1) bank zdjęć redakcji (panel), 2) Wikimedia Commons (wolne licencje, z podpisem),
// 3) ilustracja AI (Pollinations, darmowa, z ich logo – tylko gdy włączona w panelu), 4) plansza w kolorach działu.
// Artykuł o konkretnej osobie: wyłącznie jej prawdziwe zdjęcie – Wikipedia → Wikimedia Commons → zdjęcie z artykułu
// źródłowego (z podpisem portalu) → plansza z prośbą o zdjęcie w panelu. Nigdy ilustracja AI.
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { fetchBuffer, fetchText, toWebpVariants } from './scraper.js';
import { keywordsFor } from './importer.js';

const COVER_WIDTHS = [240, 640, 1280];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'CzestokochamBot/1.0 (https://czestokocham.com; czestokocham@gmail.com)';
const COLORS = { miasto: '#e3141b', powiat: '#0b7a54', kraj: '#2f55d4', sport: '#b85200' };
const NAMES = { miasto: 'Miasto', powiat: 'Powiat', kraj: 'Kraj', sport: 'Sport' };

async function saveVariants(store, slug, input, alt, name = '0') {
  const variants = await toWebpVariants(input, COVER_WIDTHS);
  const srcset = [];
  for (const v of variants) srcset.push({ w: v.width, h: v.height, url: await store.saveImage(`articles/${slug}/${name}-${v.width}.webp`, v.buffer) });
  const big = srcset[srcset.length - 1];
  return { srcset, w: big.w, h: big.h, alt };
}

/** 1) bank zdjęć: najwięcej wspólnych tagów, przy remisie najdawniej użyte */
export function pickFromBank(photos, tags) {
  const want = new Set(keywordsFor(...tags));
  let best = null;
  for (const p of photos) {
    const have = keywordsFor(...(p.tags || []));
    const score = have.filter((w) => want.has(w)).length;
    if (!score) continue;
    const used = p.lastUsedAt ? +new Date(p.lastUsedAt) : 0;
    if (!best || score > best.score || (score === best.score && used < best.used)) best = { photo: p, score, used };
  }
  return best?.photo || null;
}

/** 2) Wikimedia Commons – tylko zdjęcia na wolnych licencjach, min. 1000 px szerokości */
export async function findWikimedia(query) {
  const api = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '8',
    gsrsearch: `${query} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '1600',
  }).forEach(([k, v]) => api.searchParams.set(k, v));
  const res = await fetch(api, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}`);
  const pages = Object.values((await res.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    const meta = ii?.extmetadata || {};
    const license = meta.LicenseShortName?.value || '';
    if (!ii || ii.mime !== 'image/jpeg' || ii.width < 1000 || ii.width < ii.height) continue;
    if (!/^(CC0|CC BY(-SA)? [\d.]+|Public domain)/i.test(license)) continue;
    const artist = (meta.Artist?.value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'autor nieznany';
    return { url: ii.thumburl || ii.url, credit: `${artist} / Wikimedia Commons, ${license}`, page: ii.descriptionurl };
  }
  return null;
}

// ---------------- zdjęcie osoby ----------------
// ogólne słowa („polski”, „Częstochowa”) nie potwierdzają, że to ta sama osoba
const GENERIC = new Set(['polsk', 'czest', 'slask', 'urodz', 'obecn', 'ktory', 'ktora', 'jest', 'byla', 'oraz', 'roku']);
const stems = (s) => keywordsFor(s).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)).filter((w) => !GENERIC.has(w));
const FREE = /^(CC0|CC BY(-SA)? [\d.]+|Public domain)/i;

async function mw(host, params) {
  const api = new URL(`https://${host}/w/api.php`);
  Object.entries({ format: 'json', formatversion: '2', ...params }).forEach(([k, v]) => api.searchParams.set(k, v));
  const res = await fetch(api, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${host} HTTP ${res.status}`);
  return res.json();
}
function commonsInfo(p) {
  const ii = p?.imageinfo?.[0];
  const meta = ii?.extmetadata || {};
  const license = meta.LicenseShortName?.value || '';
  if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || ii.width < 400 || !FREE.test(license)) return null;
  const artist = (meta.Artist?.value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'autor nieznany';
  return { url: ii.thumburl || ii.url, credit: `${artist} / Wikimedia Commons, ${license}`, page: ii.descriptionurl };
}
const IMGINFO = { prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '1600' };

/** Zdjęcie z polskiej Wikipedii – tylko gdy opis hasła pasuje do roli osoby (żeby nie wziąć imiennika) */
export async function findPersonWiki(name, role) {
  if (!role) return null;
  const d = await mw('pl.wikipedia.org', {
    action: 'query', titles: name, redirects: '1', prop: 'pageprops|extracts',
    ppprop: 'page_image_free|disambiguation|wikibase-shortdesc', exintro: '1', explaintext: '1', exsentences: '3',
  });
  const p = d.query?.pages?.[0];
  const pp = p?.pageprops || {};
  if (!p || p.missing || 'disambiguation' in pp || !pp.page_image_free) return null;
  const have = new Set(stems(`${pp['wikibase-shortdesc'] || ''} ${p.extract || ''}`));
  if (!stems(role).some((w) => have.has(w))) return null;
  const f = await mw('commons.wikimedia.org', { action: 'query', titles: `File:${pp.page_image_free}`, ...IMGINFO });
  return commonsInfo(f.query?.pages?.[0]);
}

/** Wikimedia Commons – plik, którego nazwa zawiera imię i nazwisko */
export async function findPersonCommons(name) {
  const words = keywordsFor(name);
  if (words.length < 2) return null;
  const d = await mw('commons.wikimedia.org', { action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: '10', gsrsearch: `"${name}" filetype:bitmap`, ...IMGINFO });
  const pages = (d.query?.pages || []).sort((a, b) => a.index - b.index);
  for (const p of pages) {
    const t = keywordsFor(p.title);
    if (!words.every((w) => t.includes(w))) continue;
    const info = commonsInfo(p);
    if (info) return info;
  }
  return null;
}

/** Zdjęcie główne artykułu źródłowego (og:image) – tak robią lokalne portale przy tekstach o osobach; podpis: portal */
export async function sourcePhoto({ name, url }) {
  const $ = cheerio.load(await fetchText(url));
  const og = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
  if (!og || /logo|default|placeholder|favicon/i.test(og)) return null;
  return { url: new URL(og, url).toString(), credit: name, page: url };
}

/** Pionowe zdjęcie → kadr 16:9 (sharp szuka twarzy/najciekawszego fragmentu); za małe odrzucamy */
async function fitCover(buf) {
  const meta = await sharp(buf).rotate().metadata();
  const w = meta.autoOrient?.width || meta.width;
  const h = meta.autoOrient?.height || meta.height;
  if (!w || w < 400) throw new Error('za małe zdjęcie');
  if (w / h >= 1.2) return buf;
  return sharp(buf).rotate().resize(Math.min(1280, w), Math.round(Math.min(1280, w) * 9 / 16), { fit: 'cover', position: sharp.strategy.attention }).jpeg({ quality: 90 }).toBuffer();
}

async function personCover(store, { slug, title, person, sources, log }) {
  const tries = [
    ['wikimedia', () => findPersonWiki(person.name, person.role)],
    ['wikimedia', () => findPersonCommons(person.name)],
    ...sources.map((s) => ['zrodlo', () => sourcePhoto(s)]),
  ];
  for (const [kind, find] of tries) {
    try {
      const f = await find();
      if (!f) continue;
      const cover = await saveVariants(store, slug, await fitCover(await fetchBuffer(f.url)), `${person.name} – ${title}`);
      return { cover, photoCredit: f.credit, imageSource: kind, imagePage: f.page };
    } catch (e) { log(`zdjęcie osoby (${kind}): ${e.message}`); }
  }
  return null;
}

/** 3) ilustracja AI (Pollinations – darmowe API bez klucza; limit: 1 obraz na 45 s z jednego adresu) */
const AI_GAP = 47000;
let lastAi = 0;
export async function aiIllustration(prompt) {
  const p = `${prompt}. Editorial photo style, natural light, realistic, no text, no logos, no watermark`;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=1280&height=720&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastAi + AI_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastAi = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctl.signal });
      if (res.status === 402 || res.status === 429) continue; // limit darmowej wersji – czekamy i próbujemy raz jeszcze
      if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 20000) throw new Error('za mały obraz');
      return buf; // darmowa wersja ma logo pollinations.ai – zostawiamy je (usuwanie jest tylko dla płatnych kont)
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('limit darmowych ilustracji');
}

/** Nowa ilustracja na życzenie z panelu – zapisywana obok obecnej, redakcja sama decyduje, czy jej użyć */
export async function aiCandidate(store, { slug, title, prompt }) {
  return saveVariants(store, slug, await aiIllustration(prompt || title), `${title} (ilustracja)`, `ai-${Date.now().toString(36)}`);
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > max && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

/** 4) plansza z tytułem w kolorze działu */
export async function titleCard(title, category) {
  const color = COLORS[category] || COLORS.miasto;
  let lines = wrap(title, 30);
  if (lines.length > 4) { lines = lines.slice(0, 4); lines[3] = lines[3].replace(/\s*\S*$/, '') + '…'; }
  const size = lines.length > 3 ? 64 : 74;
  const top = 360 - (lines.length * size * 1.15) / 2 + size * 0.4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#14141f"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#g)"/>
    <circle cx="1130" cy="120" r="260" fill="#fff" opacity="0.06"/><circle cx="1180" cy="640" r="170" fill="#fff" opacity="0.05"/>
    <rect x="96" y="${top - size * 1.9}" width="${NAMES[category].length * 17 + 48}" height="44" rx="22" fill="#fff" opacity="0.16"/>
    <text x="120" y="${top - size * 1.9 + 30}" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="700" fill="#fff" letter-spacing="2">${xml(NAMES[category].toUpperCase())}</text>
    ${lines.map((l, i) => `<text x="96" y="${top + i * size * 1.15}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="800" fill="#fff">${xml(l)}</text>`).join('')}
    <text x="96" y="660" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" font-weight="700" fill="#fff" opacity="0.85">częstokocham</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Zdjęcie główne dla szkicu. store: { photos() → [{id, tags, image, credit, lastUsedAt}], usePhoto(id), saveImage(path, buf) }
 * @returns {{ cover, photoCredit, imageSource }}
 */
export async function coverFor(store, { slug, title, category, tags = [], photoQuery, illustrationPrompt, aiImages = false, person = null, sources = [], log = console.log }) {
  if (person?.name) {
    const found = await personCover(store, { slug, title, person, sources, log });
    if (found) return found;
    // brak zdjęcia osoby – plansza i prośba w panelu o wklejenie prawdziwego zdjęcia
    return { cover: await saveVariants(store, slug, await titleCard(title, category), title), photoCredit: null, imageSource: 'plansza', needsPhoto: true };
  }
  try {
    const photo = store.photos ? pickFromBank(await store.photos(), [...tags, title]) : null;
    if (photo) {
      await store.usePhoto?.(photo.id);
      return { cover: { ...photo.image, alt: title }, photoCredit: photo.credit || null, imageSource: 'bank' };
    }
  } catch (e) { log(`bank zdjęć: ${e.message}`); }
  if (photoQuery) {
    try {
      const w = await findWikimedia(photoQuery);
      if (w) return { cover: await saveVariants(store, slug, await fetchBuffer(w.url), title), photoCredit: w.credit, imageSource: 'wikimedia', imagePage: w.page };
    } catch (e) { log(`Wikimedia: ${e.message}`); }
  }
  if (aiImages && illustrationPrompt) {
    try {
      return { cover: await saveVariants(store, slug, await aiIllustration(illustrationPrompt), `${title} (ilustracja)`), photoCredit: 'Ilustracja wygenerowana przez AI', imageSource: 'ai' };
    } catch (e) { log(`ilustracja AI: ${e.message}`); }
  }
  return { cover: await saveVariants(store, slug, await titleCard(title, category), title), photoCredit: null, imageSource: 'plansza' };
}
