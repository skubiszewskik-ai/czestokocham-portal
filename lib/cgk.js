// Kalendarz wydarzeń z cgk.czestochowa.pl (miejski portal kulturalny „Co/Gdzie/Kiedy”): kanał RSS → opis przeredagowany
// przez AI → data/events.json + zdjęcia w public/media/events. Zdjęcia publikujemy z podpisem źródła.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { fetchText, fetchBuffer, toWebpVariants } from './scraper.js';
import { htmlToText } from './sources.js';
import { chatJson, llmAvailable } from './llm.js';

export const CGK_BASE = 'https://cgk.czestochowa.pl';
const FEED = `${CGK_BASE}/rss`;
const FILE = 'data/events.json';
const MEDIA = 'public/media/events';
const WIDTHS = [240, 640, 1280];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const warsawDay = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(d); // rrrr-mm-dd

/** „20.10.2026 19:00” → { day: '2026-10-20', time: '19:00' } */
function parseWhen(s) {
  const m = String(s || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return { day: `${m[3]}-${m[2]}-${m[1]}`, time: m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : null };
}

/** Kanał RSS → lista wydarzeń (kanał ma osobny wpis na każdy termin – łączymy je po adresie) */
export function parseFeed(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const byUrl = new Map();
  $('entry').each((_, el) => {
    const e = $(el);
    const url = e.find('link').attr('href')?.trim();
    const when = parseWhen(e.find('begin').text());
    if (!url || !when) return;
    const slug = url.split('/wydarzenie/')[1]?.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return;
    let ev = byUrl.get(url);
    if (!ev) {
      const img = e.find('image').text().trim();
      ev = {
        slug,
        url,
        title: e.find('title').text().trim(),
        type: e.find('category').text().trim() || 'Wydarzenie',
        place: e.find('place').text().trim(),
        image: img ? new URL(img, CGK_BASE).href : null,
        html: e.find('content').html() || '',
        dates: [],
      };
      byUrl.set(url, ev);
    }
    if (!ev.dates.some((d) => d.day === when.day && d.time === when.time)) ev.dates.push(when);
  });
  for (const ev of byUrl.values()) ev.dates.sort((a, b) => `${a.day}${a.time || ''}`.localeCompare(`${b.day}${b.time || ''}`));
  return [...byUrl.values()];
}

/** Adres miejsca ze strony wydarzenia: „Filharmonia Częstochowska (ul. Wilsona 16)” */
async function fetchAddress(url) {
  const $ = cheerio.load(await fetchText(url));
  return $('.site-wydarzenie h5 span').first().text().replace(/^\(|\)$/g, '').trim() || null;
}

const SYSTEM = `Jesteś redaktorem lokalnego portalu Częstokocham (Częstochowa). Dostajesz zapowiedź wydarzenia kulturalnego z miejskiego portalu CGK.
Napisz ją od nowa WŁASNYMI SŁOWAMI, po polsku, rzeczowo i ciepło, jak zapowiedź w portalu informacyjnym:
- nie przepisuj zdań z oryginału, nie dodawaj faktów, których w nim nie ma (żadnych cen, godzin ani nazwisk spoza tekstu);
- tytuł: krótki i konkretny, najwyżej 70 znaków; zachowaj nazwę wydarzenia; pisownia zwykła: wielka litera na początku i w nazwach własnych, bez zapisu WERSALIKAMI (nazwy firm i marek jak w oryginale, np. FUJIFILM);
- lead: jedno zdanie (do 180 znaków) – co to jest i dla kogo;
- body: 2–4 krótkie akapity zwykłego tekstu (bez HTML, bez list, bez daty i miejsca – te pokazujemy osobno);
- tickets: adres strony z biletami lub zapisami, jeśli jest w tekście, inaczej null;
- price: krótka informacja o cenie/wstępie („wstęp wolny”, „bilety 60–90 zł”), jeśli jest w tekście, inaczej null;
- organizer: organizator, jeśli jest podany, inaczej null.
Odpowiedz wyłącznie JSON-em: {"title": "", "lead": "", "body": ["", ""], "tickets": null, "price": null, "organizer": null}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function rewrite(ev, { log }) {
  const text = htmlToText(ev.html).slice(0, 6000);
  const links = [...ev.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&')).filter((u) => /^https?:/.test(u) && !u.includes('facebook.com/l.php')).slice(0, 5);
  const user = `TYTUŁ: ${ev.title}\nRODZAJ: ${ev.type}\nMIEJSCE: ${ev.place}\nLINKI W TEKŚCIE: ${links.join(' ') || 'brak'}\n\nTEKST:\n${text || '(brak opisu)'}`;
  const { data, provider } = await chatJson({ system: SYSTEM, user, temperature: 0.5, log });
  const body = (Array.isArray(data.body) ? data.body : [data.body]).map((p) => String(p || '').trim()).filter(Boolean);
  if (!data.title || !body.length) throw new Error('AI nie zwróciło tytułu lub treści');
  const tickets = typeof data.tickets === 'string' && /^https?:\/\//.test(data.tickets) ? data.tickets : null;
  return {
    title: String(data.title).trim().slice(0, 120),
    lead: String(data.lead || '').trim().slice(0, 260),
    body: body.map((p) => `<p>${esc(p)}</p>`).join(''),
    tickets,
    price: data.price ? String(data.price).trim().slice(0, 80) : null,
    organizer: data.organizer ? String(data.organizer).trim().slice(0, 120) : null,
    ai: provider,
  };
}

async function saveImage(slug, src) {
  const dir = path.join(MEDIA, slug);
  await fs.mkdir(dir, { recursive: true });
  const variants = await toWebpVariants(await fetchBuffer(src), WIDTHS);
  const srcset = [];
  for (const v of variants) {
    await fs.writeFile(path.join(dir, `${v.width}.webp`), v.buffer);
    srcset.push({ w: v.width, h: v.height, url: `/media/events/${slug}/${v.width}.webp` });
  }
  const big = srcset[srcset.length - 1];
  return { srcset, w: big.w, h: big.h, alt: '' };
}

/**
 * Odświeża kalendarz: nowe terminy, nowe wydarzenia (zdjęcie + tekst AI), koniec zakończonych.
 * maxRewrites – ile opisów najwyżej redaguje AI w jednym uruchomieniu (najpierw najbliższe wydarzenia).
 */
export async function importCgk({ maxRewrites = 20, log = console.log } = {}) {
  const store = JSON.parse(await fs.readFile(FILE, 'utf8').catch(() => '{"events":{}}'));
  const events = store.events || {};
  const today = warsawDay();
  const result = { found: 0, added: [], rewritten: [], removed: [], errors: [] };

  const feed = parseFeed(await fetchText(FEED));
  result.found = feed.length;
  for (const f of feed) {
    const ev = events[f.slug];
    if (ev) {
      // terminy z kanału są aktualne; zostawiamy też dzisiejsze, których kanał już nie pokazuje
      const keep = ev.dates.filter((d) => d.day >= today && !f.dates.some((x) => x.day === d.day));
      Object.assign(ev, { dates: [...keep, ...f.dates].sort((a, b) => `${a.day}${a.time || ''}`.localeCompare(`${b.day}${b.time || ''}`)), place: f.place || ev.place, type: f.type, sourceHtml: f.html });
      continue;
    }
    const doc = {
      slug: f.slug,
      source: { name: 'cgk.czestochowa.pl', url: f.url },
      sourceTitle: f.title,
      sourceHtml: f.html,
      title: f.title,
      lead: '',
      body: '',
      type: f.type,
      place: f.place,
      address: null,
      dates: f.dates,
      cover: null,
      photoCredit: 'materiały organizatora / cgk.czestochowa.pl',
      tickets: null,
      price: null,
      organizer: null,
      ai: null,
      addedAt: new Date().toISOString(),
    };
    try {
      await sleep(800);
      doc.address = await fetchAddress(f.url);
    } catch (e) { log(`cgk: adres ${f.slug}: ${e.message}`); }
    if (f.image) {
      try { doc.cover = await saveImage(f.slug, f.image); } catch (e) { log(`cgk: zdjęcie ${f.slug}: ${e.message}`); }
    }
    events[f.slug] = doc;
    result.added.push(f.slug);
    log(`cgk: nowe wydarzenie ${f.slug}`);
  }

  // redakcja opisów: najpierw najbliższe terminy; nieudane spróbują znowu przy kolejnym uruchomieniu
  if (llmAvailable()) {
    const todo = Object.values(events).filter((e) => !e.ai && e.dates.some((d) => d.day >= today))
      .sort((a, b) => a.dates[0].day.localeCompare(b.dates[0].day)).slice(0, maxRewrites);
    for (const ev of todo) {
      try {
        Object.assign(ev, await rewrite({ title: ev.sourceTitle || ev.title, type: ev.type, place: ev.place, html: ev.sourceHtml || '' }, { log }));
        ev.rewrittenAt = new Date().toISOString();
        result.rewritten.push(ev.slug);
      } catch (e) {
        result.errors.push(`${ev.slug}: ${e.message}`);
        log(`cgk: redakcja ${ev.slug}: ${e.message}`);
      }
    }
  }

  // zakończone wydarzenia znikają razem ze zdjęciami (dzień zapasu)
  const yesterday = warsawDay(new Date(Date.now() - 864e5));
  for (const ev of Object.values(events)) {
    if (ev.dates.some((d) => d.day >= yesterday)) continue;
    delete events[ev.slug];
    await fs.rm(path.join(MEDIA, ev.slug), { recursive: true, force: true });
    result.removed.push(ev.slug);
  }

  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ updatedAt: new Date().toISOString(), events }));
  return result;
}
