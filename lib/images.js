// Zdjęcie główne do szkicu redaktora. Kolejność:
// 1) bank zdjęć redakcji (panel), 2) archiwum zdjęć miasta z czestochowa.pl – najpierw artykuły już zaimportowane
//    (pliki są u nas, nic nie pobieramy), potem wyszukiwarka czestochowa.pl (całe archiwum aktualności),
// 3) prawdziwe zdjęcie tematu na wolnej licencji (z podpisem) – dla każdego hasła od
//    redaktora (np. „Politechnika Częstochowska”): zdjęcie z hasła w Wikipedii → Wikimedia Commons → Openverse,
// 4) ilustracja AI (Pollinations, darmowa, z ich logo – tylko gdy włączona w panelu), 4) bez zdjęcia – prośba w panelu.
// Artykuł o konkretnej osobie: wyłącznie jej prawdziwe zdjęcie – Wikipedia → Wikimedia Commons → zdjęcie z artykułu
// źródłowego (z podpisem portalu) → bez zdjęcia z prośbą w panelu. Nigdy ilustracja AI.
// Plansz z tytułem już nie robimy – wyglądały jak zrzut tekstu, redakcja woli dodać zdjęcie sama.
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { fetchBuffer, fetchText, toWebpVariants, parseArticle, SOURCE_BASE } from './scraper.js';
import { keywordsFor } from './importer.js';

const COVER_WIDTHS = [240, 640, 1280];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'CzestokochamBot/1.0 (https://czestokocham.com; czestokocham@gmail.com)';

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

// ---------------- zdjęcie osoby ----------------
// ogólne słowa („polski”, „Częstochowa”) nie potwierdzają, że to ta sama osoba
const GENERIC = new Set(['polsk', 'czest', 'slask', 'urodz', 'obecn', 'ktory', 'ktora', 'jest', 'byla', 'oraz', 'roku']);
const stems = (s) => keywordsFor(s).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)).filter((w) => !GENERIC.has(w));
const FREE = /^(CC0|CC BY(-SA)? [\d.]+|Public domain)/i;

async function mw(host, params) {
  const api = new URL(`https://${host}/w/api.php`);
  Object.entries({ format: 'json', formatversion: '2', ...params }).forEach(([k, v]) => api.searchParams.set(k, v));
  const res = await fetch(api, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
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

// ---------------- zdjęcie tematu ----------------
// wynik musi dotyczyć hasła: w tytule/tagach zdjęcia co najmniej dwa (albo jedyne) znaczące słowa hasła
function about(query, text) {
  const want = [...new Set(stems(query))];
  const have = new Set(stems(text));
  return want.length > 0 && want.filter((w) => have.has(w)).length >= Math.min(2, want.length);
}

/** Zdjęcie z hasła polskiej Wikipedii (np. budynek Politechniki w haśle „Politechnika Częstochowska”) */
export async function findWikiTopic(query) {
  const d = await mw('pl.wikipedia.org', { action: 'query', generator: 'search', gsrsearch: query, gsrlimit: '3', gsrnamespace: '0', prop: 'pageprops', ppprop: 'page_image_free|disambiguation' });
  const pages = (d.query?.pages || []).sort((a, b) => a.index - b.index);
  for (const p of pages) {
    const pp = p.pageprops || {};
    if ('disambiguation' in pp || !pp.page_image_free || !about(query, p.title)) continue;
    const f = await mw('commons.wikimedia.org', { action: 'query', titles: `File:${pp.page_image_free}`, ...IMGINFO });
    const info = commonsInfo(f.query?.pages?.[0]);
    if (info) return { ...info, kind: 'wikipedia' };
  }
  return null;
}

/** Wikimedia Commons – zdjęcia na wolnych licencjach, których nazwa pasuje do hasła */
export async function findWikimedia(query) {
  const d = await mw('commons.wikimedia.org', { action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: '10', gsrsearch: `${query} filetype:bitmap`, ...IMGINFO });
  const pages = (d.query?.pages || []).sort((a, b) => a.index - b.index);
  for (const p of pages) {
    if (!about(query, p.title.replace(/^File:|\.\w+$/g, ''))) continue;
    const info = commonsInfo(p);
    if (info && p.imageinfo[0].width >= 800) return { ...info, kind: 'wikimedia' };
  }
  return null;
}

/** Openverse (WordPress) – zdjęcia Creative Commons z Flickra i innych serwisów; bez „ND”, bo kadrujemy */
const OV_SOURCES = { wikimedia: 'Wikimedia Commons', flickr: 'Flickr' };
const OV_LICENSES = { cc0: 'CC0', pdm: 'Public domain', by: 'CC BY', 'by-sa': 'CC BY-SA' };
export async function findOpenverse(query) {
  const api = new URL('https://api.openverse.org/v1/images/');
  Object.entries({ q: query, license: Object.keys(OV_LICENSES).join(','), page_size: '20', mature: 'false' }).forEach(([k, v]) => api.searchParams.set(k, v));
  const res = await fetch(api, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Openverse HTTP ${res.status}`);
  for (const r of (await res.json()).results || []) {
    const lic = OV_LICENSES[r.license];
    if (!lic || (r.width && r.width < 800) || !about(query, `${r.title || ''} ${(r.tags || []).map((t) => t.name).join(' ')}`)) continue;
    const who = (r.creator || 'autor nieznany').replace(/\s+/g, ' ').trim().slice(0, 60);
    return { url: r.url, credit: `${who} / ${OV_SOURCES[r.source] || r.source || 'Openverse'}, ${lic}${r.license_version && !['cc0', 'pdm'].includes(r.license) ? ` ${r.license_version}` : ''}`, page: r.foreign_landing_url || r.url, kind: 'openverse' };
  }
  return null;
}

// ---------------- archiwum zdjęć miasta (czestochowa.pl) ----------------
// Zdjęcia robi Urząd Miasta. Artykuł o tym samym miejscu/instytucji ma zwykle kilka zdjęć – bierzemy zdjęcie
// z galerii (nie główne), żeby nasza miniatura nie była kopią okładki ich artykułu; każde zdjęcie najwyżej raz na uruchomienie.
const usedCity = new Set();
const cityCredit = (c) => `${(c || '').replace(/^fot\.\s*/i, '').trim() || 'UM Częstochowa'} / czestochowa.pl`;
function pickImage(list, key) {
  const fresh = list.filter((x) => !usedCity.has(x));
  if (!fresh.length) return null;
  const gallery = fresh.length > 1 ? fresh.filter((x) => x !== list[0]) : fresh;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const pick = gallery[h % gallery.length];
  usedCity.add(pick);
  return pick;
}

/** Zaimportowane artykuły z czestochowa.pl (store.cityArticles → [{ slug, title, lead, cover, gallery, photoCredit }]), najnowsze pierwsze */
export function findCityLocal(articles, query) {
  for (const a of articles) {
    if (!about(query, `${a.title} ${a.lead || ''}`)) continue;
    const imgs = [a.cover, ...(a.gallery || [])].filter((i) => i?.srcset?.length && i.w >= 640);
    const img = pickImage(imgs, query);
    if (img) return { image: img, credit: cityCredit(a.photoCredit), page: `${SOURCE_BASE}/${a.slug}`, kind: 'miasto' };
  }
  return null;
}

/** Wyszukiwarka czestochowa.pl – aktualności z całego archiwum; zdjęcie z artykułu, którego TYTUŁ dotyczy hasła */
export async function findCityArchive(query) {
  const url = `${SOURCE_BASE}/search?lang_id=1&type=news&text=${encodeURIComponent(query)}`;
  const $ = cheerio.load(await fetchText(url));
  const hits = $('#search-results .item .item-title > a').map((_, a) => ({ href: $(a).attr('href'), title: $(a).text().trim() })).get()
    .filter((h) => h.href && about(query, h.title)).slice(0, 3);
  for (const h of hits) {
    await sleep(800);
    const page = new URL(h.href, `${SOURCE_BASE}/`).toString();
    const art = parseArticle(await fetchText(page), page);
    const img = pickImage(art.images, query);
    if (img) return { url: img, credit: cityCredit(art.photoCredit), page, kind: 'miasto' };
  }
  return null;
}

/** Zdjęcie w innych proporcjach (pionowe, 4:3) → kadr 16:9 jak na stronie (sharp szuka twarzy/najciekawszego fragmentu); za małe odrzucamy */
async function fitCover(buf) {
  const meta = await sharp(buf).rotate().metadata();
  const w = meta.autoOrient?.width || meta.width;
  const h = meta.autoOrient?.height || meta.height;
  if (!w || w < 400) throw new Error('za małe zdjęcie');
  if (Math.abs(w / h - 16 / 9) < 0.08) return buf;
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

/**
 * Zdjęcie główne dla szkicu. photoQueries: hasła od najbardziej konkretnego (np. „Politechnika Częstochowska”). store: { photos() → [{id, tags, image, credit, lastUsedAt}], usePhoto(id), saveImage(path, buf) }
 * @returns {{ cover, photoCredit, imageSource, needsPhoto? }} – bez zdjęcia: cover null i needsPhoto
 */
const NO_PHOTO = { cover: null, photoCredit: null, imageSource: null, needsPhoto: true };
export async function coverFor(store, { slug, title, tags = [], photoQueries = [], illustrationPrompt, aiImages = false, person = null, sources = [], log = console.log }) {
  if (person?.name) {
    const found = await personCover(store, { slug, title, person, sources, log });
    if (found) return found;
    return NO_PHOTO; // brak zdjęcia osoby – prośba w panelu o wklejenie prawdziwego zdjęcia
  }
  try {
    const photo = store.photos ? pickFromBank(await store.photos(), [...tags, title]) : null;
    if (photo) {
      await store.usePhoto?.(photo.id);
      return { cover: { ...photo.image, alt: title }, photoCredit: photo.credit || null, imageSource: 'bank' };
    }
  } catch (e) { log(`bank zdjęć: ${e.message}`); }
  // archiwum miasta: hasła po polsku (angielski opis sceny i tak nie pasuje do tytułów czestochowa.pl)
  let city = [];
  try { city = store.cityArticles ? await store.cityArticles() : []; } catch (e) { log(`archiwum miasta: ${e.message}`); }
  for (const q of photoQueries) {
    const local = findCityLocal(city, q);
    if (local) {
      log(`zdjęcie „${q}”: archiwum miasta ${local.page}`);
      return { cover: { ...local.image, alt: title }, photoCredit: local.credit, imageSource: 'miasto', imagePage: local.page };
    }
    try {
      const f = await findCityArchive(q);
      if (!f) continue;
      log(`zdjęcie „${q}”: czestochowa.pl ${f.page}`);
      return { cover: await saveVariants(store, slug, await fitCover(await fetchBuffer(f.url)), title), photoCredit: f.credit, imageSource: 'miasto', imagePage: f.page };
    } catch (e) { log(`zdjęcie „${q}” (czestochowa.pl): ${e.message}`); }
  }
  for (const q of photoQueries) {
    for (const find of [findWikiTopic, findWikimedia, findOpenverse]) {
      try {
        const f = await find(q);
        if (!f) continue;
        log(`zdjęcie „${q}”: ${f.kind} ${f.page}`);
        return { cover: await saveVariants(store, slug, await fitCover(await fetchBuffer(f.url)), title), photoCredit: f.credit, imageSource: f.kind, imagePage: f.page };
      } catch (e) { log(`zdjęcie „${q}” (${find.name}): ${e.message}`); }
    }
  }
  if (aiImages && illustrationPrompt) {
    try {
      return { cover: await saveVariants(store, slug, await aiIllustration(illustrationPrompt), `${title} (ilustracja)`), photoCredit: 'Ilustracja wygenerowana przez AI', imageSource: 'ai' };
    } catch (e) { log(`ilustracja AI: ${e.message}`); }
  }
  return NO_PHOTO;
}
