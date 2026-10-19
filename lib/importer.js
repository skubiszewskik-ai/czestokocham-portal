// Import aktualności z czestochowa.pl i wczestochowie.pl do bazy portalu
import { fetchText, fetchBuffer, parseList, parseArticle, parsePlDate, guessCategory, toWebpVariants, LIST_URL } from './scraper.js';
import { fetchLatestPosts, sleep, WCZ_DELAY } from './wczestochowie.js';

const MAX_GALLERY = 10;
const DUP_WINDOW_DAYS = 14; // z iloma dniami wstecz porównujemy wiadomości
const COVER_WIDTHS = [240, 640, 1280]; // 240 – miniatury na listach
const GALLERY_WIDTHS = [480, 1200];

export function keywordsFor(...parts) {
  const words = parts.join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return [...new Set(words)].slice(0, 80);
}

/**
 * store: { exists(id) → bool, saveImage(path, buffer) → url, saveArticle(id, data) }
 */
export async function importLatest(store, { pages = 3, limit = 30, log = console.log } = {}) {
  const found = [];
  for (let p = 1; p <= pages; p++) {
    const url = p === 1 ? LIST_URL : `${LIST_URL}?1=${p}`;
    const items = parseList(await fetchText(url));
    found.push(...items);
    // gdy na stronie są już znane artykuły, starsze też są w bazie
    const known = await Promise.all(items.map((i) => store.exists(i.slug)));
    if (known.some(Boolean)) break;
  }
  // czas publikacji: czestochowa.pl podaje tylko datę, więc bierzemy godzinę wgrania zdjęć do artykułu (nagłówek
  // Last-Modified) – redakcja wgrywa je tuż przed publikacją. Lista idzie od najnowszych, więc czas nie może rosnąć.
  let newer = Infinity;
  const timed = [];
  for (const item of found.slice(0, limit)) {
    if (await store.exists(item.slug)) continue;
    let art;
    try { art = parseArticle(await fetchText(item.url), item.url); } catch (e) { log(`błąd ${item.slug}: ${e.message}`); continue; }
    const day = art.date || item.date;
    let at = (await photoTime(art.images, day)) || parsePlDate(day, null);
    if (!at) at = new Date(Math.min(Date.now(), newer - 60000)); // dzisiejszy bez zdjęć – zaraz pod nowszym
    if (at.getTime() >= newer) at = new Date(newer - 60000);
    newer = at.getTime();
    timed.push({ item, art, at });
  }
  const entries = timed.reverse().map(({ item, art, at }) => ({
    slug: item.slug,
    url: item.url,
    load: async () => {
      const title = art.title || item.title;
      const lead = art.lead || item.lead;
      return {
        title, lead, body: art.body, images: art.images, photoCredit: art.photoCredit,
        category: guessCategory(title, lead),
        publishedAt: at,
      };
    },
  }));
  const result = await saveAll(store, entries, { sourceName: 'czestochowa.pl', log });
  // czestochowa.pl ma pierwszeństwo: wcześniej pobrany przedruk z wczestochowie.pl chowamy (szkic w panelu)
  if (result.saved.length && store.recent && store.hide) {
    const others = (await store.recent(new Date(Date.now() - DUP_WINDOW_DAYS * 864e5)))
      .filter((r) => r.source?.name === 'wczestochowie.pl' && r.status === 'published');
    for (const art of result.saved) {
      const fp = fingerprint(art);
      for (const o of others) {
        if (o.hidden || !isDuplicate(fp, fingerprint(o))) continue;
        await store.hide(o.slug, art.slug);
        o.hidden = true;
        log(`ukryto duplikat z wczestochowie.pl: ${o.slug} → ${art.slug}`);
      }
    }
  }
  return result;
}

const plDay = (d) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
/** Najpóźniejsza godzina wgrania zdjęć artykułu z dnia `day` (dd.mm.rrrr) albo null */
async function photoTime(images, day) {
  let best = null;
  for (const src of images.slice(0, 4)) {
    try {
      const res = await fetch(src, { method: 'HEAD' });
      const lm = new Date(res.headers.get('last-modified') || '');
      if (isNaN(lm) || plDay(lm) !== day || lm > Date.now()) continue;
      if (!best || lm > best) best = lm;
    } catch {}
  }
  return best;
}

/** Część wspólna względem mniejszego zbioru (0–1) */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.min(a.size, b.size);
}

/** Odcisk treści: trójki kolejnych słów z tytułu, zajawki i treści + słowa kluczowe z tytułu i zajawki */
export function fingerprint({ title = '', lead = '', body = '' }) {
  const plain = `${title} ${lead} ${body.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')}`;
  const words = plain.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const sh = new Set();
  for (let i = 0; i + 3 <= words.length; i++) sh.add(words.slice(i, i + 3).join(' '));
  return { sh, kw: new Set(keywordsFor(title, lead)), ent: entities(plain) };
}

const COMMON = new Set('częstochowa częstochowy częstochowie częstochowski częstochowskiej częstochowskich urząd urzędu miasta miasto polska polski polskiej'.split(' '));
/** Konkrety tekstu: liczby (kwoty, numery szkół, adresy) i nazwy własne – zostają takie same, nawet gdy ktoś przepisze tekst innymi słowami */
function entities(plain) {
  const out = new Set();
  for (const x of plain.matchAll(/\d[\d\s.,]*\d|\d{2,}/g)) {
    const n = x[0].replace(/[\s.,]/g, '');
    if (n.length >= 2 && !/^20[12]\d$/.test(n)) out.add('#' + n);
  }
  for (const x of plain.matchAll(/(?<=\s|„|\()(\p{Lu}[\p{L}-]{2,})/gu)) {
    const w = x[1].toLowerCase();
    if (!COMMON.has(w)) out.add(w.slice(0, 6));
  }
  return out;
}

/**
 * Ta sama wiadomość? Przedruki komunikatów mają 0,53–0,95 wspólnych trójek słów,
 * różne wiadomości najwyżej 0,24 (sprawdzone na październikowych artykułach obu portali).
 * Same podobne tytuły nie wystarczą (zapowiedź i relacja z tego samego wydarzenia to dwie wiadomości).
 */
export function isDuplicate(a, b, { strict = false } = {}) {
  const sh = overlap(a.sh, b.sh);
  if (sh >= 0.35 || (sh >= 0.1 && overlap(a.kw, b.kw) >= 0.5)) return true;
  // tryb ostry (wirtualny redaktor): przeredagowany tekst o tym samym ma te same liczby i nazwy.
  // Łapie też zapowiedź i relację z jednego wydarzenia, dlatego importy go nie używają.
  if (!strict || !a.ent || !b.ent) return false;
  let n = 0;
  for (const x of a.ent) if (b.ent.has(x)) n++;
  const r = n / Math.max(1, Math.min(a.ent.size, b.ent.size));
  return (r >= 0.6 && n >= 8) || (r >= 0.5 && n >= 15);
}

/**
 * Import z wczestochowie.pl – wpisy z ostatnich dni, bez artykułów sponsorowanych
 * i bez wiadomości, które już mamy (czestochowa.pl ma pierwszeństwo).
 * store.recent(since) → [{ slug, title, lead, body, source }] – opcjonalnie, do wykrywania duplikatów
 */
export async function importWczestochowie(store, { days = 3, log = console.log } = {}) {
  const since = Date.now() - days * 864e5;
  const known = (store.recent ? await store.recent(new Date(Date.now() - DUP_WINDOW_DAYS * 864e5)) : [])
    .map((r) => ({ slug: r.slug, fp: fingerprint(r) }));
  const posts = [];
  for (const p of (await fetchLatestPosts()).reverse()) {
    if (p.sponsored || p.date.getTime() <= since || !/^[a-z0-9-]+$/.test(p.slug)) continue;
    const fp = fingerprint(p);
    const dup = known.find((r) => r.slug !== p.slug && isDuplicate(fp, r.fp));
    if (dup) { log(`pominięto duplikat (wczestochowie.pl): ${p.slug} ≈ ${dup.slug}`); continue; }
    known.push({ slug: p.slug, fp }); // także powtórki w obrębie samego wczestochowie.pl
    posts.push(p);
  }
  const entries = posts.map((p) => ({
    slug: p.slug,
    url: p.url,
    load: async () => ({ ...p, publishedAt: p.date }),
  }));
  return saveAll(store, entries, { sourceName: 'wczestochowie.pl', log, imageDelay: WCZ_DELAY });
}

async function saveAll(store, entries, { sourceName, log, imageDelay = 0 }) {
  const result = { checked: entries.length, imported: [], skipped: 0, errors: [], saved: [] };
  for (const item of entries) {
    try {
      if (await store.exists(item.slug)) { result.skipped++; continue; }
      const art = await item.load();
      const { title, lead } = art;
      const images = [];
      for (const [idx, src] of art.images.slice(0, MAX_GALLERY + 1).entries()) {
        try {
          if (imageDelay) await sleep(imageDelay);
          const variants = await toWebpVariants(await fetchBuffer(src), idx === 0 ? COVER_WIDTHS : GALLERY_WIDTHS);
          const srcset = [];
          for (const v of variants) {
            const url = await store.saveImage(`articles/${item.slug}/${idx}-${v.width}.webp`, v.buffer);
            srcset.push({ w: v.width, h: v.height, url });
          }
          const big = srcset[srcset.length - 1];
          images.push({ srcset, w: big.w, h: big.h, alt: idx === 0 ? title : `${title} – zdjęcie ${idx}` });
        } catch (e) {
          log(`zdjęcie pominięte ${src}: ${e.message}`);
        }
      }
      const doc = {
        slug: item.slug,
        title,
        lead,
        body: art.body,
        category: art.category,
        cover: images[0] || null,
        gallery: images.slice(1),
        author: 'Redakcja',
        photoCredit: art.photoCredit,
        source: { name: sourceName, url: item.url },
        status: 'published',
        featured: false,
        publishedAt: art.publishedAt,
        keywords: keywordsFor(title, lead),
        importedAt: new Date(),
      };
      await store.saveArticle(item.slug, doc);
      result.saved.push(doc);
      result.imported.push(item.slug);
      log(`zaimportowano (${sourceName}): ${item.slug}`);
    } catch (e) {
      result.errors.push(`${item.slug}: ${e.message}`);
      log(`błąd ${item.slug}: ${e.message}`);
    }
  }
  return result;
}
