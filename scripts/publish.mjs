// Publikacja portalu: (import z czestochowa.pl i wczestochowie.pl) → (wirtualny redaktor) → (kalendarz wydarzeń CGK) → zdjęcia z panelu → zmiany z bazy → build Astro → Firebase Hosting
// Użycie: node scripts/publish.mjs [--import] [--redaktor] [--naczelny] [--wydarzenia] [--no-deploy]
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db, warsawNow, importSlot, IMPORT_HOURS } from '../lib/firestore.js';
import { importLatest, importWczestochowie } from '../lib/importer.js';
import { runRedaktor, seenKey } from '../lib/redaktor.js';
import { runNaczelny } from '../lib/naczelny.js';
import { aiCandidate } from '../lib/images.js';
import { importCgk } from '../lib/cgk.js';

const args = new Set(process.argv.slice(2));
const firestore = db();
const MEDIA = 'public/media';
const SNAP = 'data/articles.json';
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const plainTs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v.toDate === 'function' ? v.toDate() : v]));

const buildRef = firestore.collection('config').doc('build');
const build = (await buildRef.get()).data() || {};
const startedAt = Timestamp.now();

// 0. lista administratorów przy pierwszym uruchomieniu
const adminsRef = firestore.collection('config').doc('admins');
if (!(await adminsRef.get()).exists && process.env.ADMIN_EMAILS) {
  await adminsRef.set({ emails: process.env.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()) });
  log('utworzono listę administratorów');
}

// 1. import z czestochowa.pl i wczestochowie.pl
let importResult = null;
if (args.has('--import') || build.importRequested) {
  log('import z czestochowa.pl i wczestochowie.pl…');
  const store = {
    exists: async (id) => (await firestore.collection('articles').doc(id).get()).exists,
    saveImage: async (p, buf) => {
      const full = path.join(MEDIA, p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buf);
      return `/media/${p}`;
    },
    saveArticle: (id, doc) => firestore.collection('articles').doc(id).set({ ...doc, updatedAt: FieldValue.serverTimestamp() }),
    recent: async (since) =>
      (await firestore.collection('articles').where('publishedAt', '>=', since).select('title', 'lead', 'body', 'source', 'status').get())
        .docs.map((d) => ({ slug: d.id, ...d.data() })),
    hide: (id, duplicateOf) => firestore.collection('articles').doc(id).update({ status: 'draft', duplicateOf, updatedAt: FieldValue.serverTimestamp() }),
  };
  importResult = { checked: 0, imported: [], skipped: 0, errors: [] };
  const sources = [
    ['czestochowa.pl', () => importLatest(store, { pages: 3, limit: 30, log })],
    ['wczestochowie.pl', () => importWczestochowie(store, { days: 3, log })],
  ];
  for (const [name, run] of sources) {
    // awaria jednego źródła nie blokuje drugiego
    const r = await run().catch((e) => ({ checked: 0, imported: [], skipped: 0, errors: [`${name}: ${e.message}`] }));
    importResult.checked += r.checked;
    importResult.imported.push(...r.imported);
    importResult.skipped += r.skipped;
    importResult.errors.push(...r.errors);
    log(`${name}: nowych ${r.imported.length}, błędów ${r.errors.length}`);
  }
  await firestore.collection('imports').add({ ...importResult, trigger: build.importRequested ? 'manual' : 'schedule', at: FieldValue.serverTimestamp() });
  log(`import: nowych ${importResult.imported.length}, błędów ${importResult.errors.length}`);
}

// 1b. wirtualny redaktor – szkice na podstawie innych portali (do akceptu w panelu)
let redaktorResult = null;
if (args.has('--redaktor') || build.redaktorRequested) {
  log('wirtualny redaktor…');
  const store = redaktorStore();
  const cfg = (await firestore.collection('config').doc('redaktor').get()).data() || {};
  redaktorResult = await runRedaktor(store, { days: 7, maxDrafts: Number(process.env.REDAKTOR_MAX || 6), keep: 30, aiImages: !!cfg.aiImages, deadline: t0 + Number(process.env.REDAKTOR_MINUTES || 20) * 60e3, log })
    .catch((e) => ({ checked: 0, drafts: [], skipped: [], duplicates: 0, errors: [e.message], pruned: [] }));
  log(`redaktor: nowych szkiców ${redaktorResult.drafts.length}, pominiętych ${redaktorResult.skipped.length}, powtórek ${redaktorResult.duplicates}, błędów ${redaktorResult.errors.length}`);

  // 1c. redaktor naczelny AI – przegląd szkiców i publikacja rozłożona w ciągu dnia (wyłączany w panelu)
  if (cfg.autoPublish !== false) {
    log('redaktor naczelny…');
    redaktorResult.naczelny = await runNaczelny(naczelnyStore(store), { perDay: Number(cfg.perDay) || 16, deadline: Date.now() + Number(process.env.NACZELNY_MINUTES || 12) * 60e3, log })
      .catch((e) => ({ checked: 0, published: [], held: [], rejected: [], newPhotos: 0, errors: [e.message] }));
    const n = redaktorResult.naczelny;
    log(`naczelny: sprawdzonych ${n.checked}, do publikacji ${n.published.length}, do człowieka ${n.held.length}, odrzuconych ${n.rejected.length}, nowych zdjęć ${n.newPhotos}, błędów ${n.errors.length}`);
  }
  await firestore.collection('redaktor_runs').add({ ...redaktorResult, trigger: build.redaktorRequested ? 'manual' : 'schedule', at: FieldValue.serverTimestamp() });
} else if (args.has('--naczelny')) {
  // sam przegląd szkiców (ręcznie, np. po zmianie zasad)
  const n = await runNaczelny(naczelnyStore(redaktorStore()), { perDay: 16, log });
  log(`naczelny: sprawdzonych ${n.checked}, do publikacji ${n.published.length}, do człowieka ${n.held.length}, odrzuconych ${n.rejected.length}, nowych zdjęć ${n.newPhotos}, błędów ${n.errors.length}`);
}

/** Dostęp do bazy i plików dla wirtualnego redaktora (lib/redaktor.js) */
function redaktorStore() {
  const seenCol = firestore.collection('redaktor_seen');
  let cityCache = null;
  return {
    recent: async (since) =>
      (await firestore.collection('articles').where('publishedAt', '>=', since).select('title', 'lead', 'body', 'status', 'origin').get())
        // nieopublikowane przedruki z importu nie zajmują tematu – redaktor może napisać o tym własny tekst
        .docs.map((d) => ({ slug: d.id, ...d.data() })).filter((a) => !(a.origin === 'import' && a.status === 'draft'))
        .sort((a, b) => (a.status === 'deleted') - (b.status === 'deleted')),
    seen: async (keys) => {
      const out = new Set();
      for (let i = 0; i < keys.length; i += 100) {
        const docs = await firestore.getAll(...keys.slice(i, i + 100).map((k) => seenCol.doc(k)));
        docs.filter((d) => d.exists).forEach((d) => out.add(d.id));
      }
      return out;
    },
    markSeen: (key, data) => seenCol.doc(key).set({ ...data, at: FieldValue.serverTimestamp() }),
    usedSources: async (since) =>
      (await seenCol.where('at', '>=', since).get()).docs.filter((d) => d.get('result') === 'draft')
        .map((d) => ({ ref: d.get('ref'), title: d.get('title') || '', text: d.get('text') || '' })),
    exists: async (id) => (await firestore.collection('articles').doc(id).get()).exists,
    saveArticle: (id, doc) => firestore.collection('articles').doc(id).set({ ...doc, updatedAt: FieldValue.serverTimestamp() }),
    saveImage: async (p, buf) => {
      const full = path.join(MEDIA, p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buf);
      return `/media/${p}`;
    },
    photos: async () => (await firestore.collection('photos').get()).docs.map((d) => ({ id: d.id, ...plainTs(d.data()) })),
    usePhoto: (id) => firestore.collection('photos').doc(id).update({ lastUsedAt: FieldValue.serverTimestamp() }),
    // archiwum zdjęć miasta: zaimportowane aktualności czestochowa.pl (jedno zapytanie na uruchomienie)
    cityArticles: async () => (cityCache ||= (await firestore.collection('articles').where('source.name', '==', 'czestochowa.pl')
      .select('title', 'lead', 'cover', 'gallery', 'photoCredit', 'publishedAt', 'status').get()).docs
      .map((d) => ({ slug: d.id, ...d.data() })).filter((a) => a.status !== 'deleted')
      .sort((a, b) => (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0))),
    pending: async () =>
      (await firestore.collection('articles').where('origin', '==', 'redaktor').where('status', '==', 'draft').select('publishedAt', 'keep').get())
        // „keep” – teksty cofnięte z publikacji do poprawki; nie kasujemy ich jako starych propozycji
        .docs.filter((d) => !d.get('keep')).map((d) => ({ slug: d.id, publishedAt: d.get('publishedAt')?.toMillis() || 0 })),
    // zostaje tylko ślad (redaktor nie wróci do tematu), treść i zdjęcia znikają
    prune: async (slug) => {
      await firestore.collection('articles').doc(slug).update({ status: 'deleted', body: '', lead: '', cover: null, gallery: [], prunedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      await fs.rm(path.join(MEDIA, 'articles', slug), { recursive: true, force: true });
    },
  };
}

/** Dostęp do bazy dla redaktora naczelnego (lib/naczelny.js) – zdjęcia jak u redaktora */
function naczelnyStore(base) {
  const col = firestore.collection('articles');
  let recentCache = null;
  const recentAll = async () => (recentCache ||= (await col.where('publishedAt', '>=', new Date(Date.now() - 5 * 864e5)).select('title', 'status', 'autoPublished', 'publishedAt').get())
    .docs.map((d) => ({ slug: d.id, ...d.data() })).filter((a) => a.status === 'published'));
  return {
    ...base,
    drafts: async () => (await col.where('origin', '==', 'redaktor').where('status', '==', 'draft').get()).docs
      .map((d) => ({ slug: d.id, ...d.data() })).filter((a) => !a.keep && !a.review),
    recent: async (since) => (await recentAll()).filter((a) => a.publishedAt.toMillis() >= +since)
      .sort((a, b) => b.publishedAt.toMillis() - a.publishedAt.toMillis()).map(({ slug, title }) => ({ slug, title })),
    autoTimes: async () => (await recentAll()).filter((a) => a.autoPublished && a.publishedAt.toMillis() >= Date.now() - 864e5).map((a) => a.publishedAt.toDate()),
    sourceText: async (url) => {
      if (!url) return '';
      const seen = await firestore.collection('redaktor_seen').doc(seenKey(url)).get();
      if (seen.get('text')) return seen.get('text');
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      return res.ok ? (await res.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 12000) : '';
    },
    update: (slug, data) => col.doc(slug).update({ ...data, updatedAt: FieldValue.serverTimestamp() }),
    readLocal: (url) => fs.readFile(path.join('public', url)),
  };
}

// 1b'. kalendarz wydarzeń z cgk.czestochowa.pl (przy imporcie i przy każdym uruchomieniu redaktora, czyli co ~2 godziny)
let cgkResult = null;
if (importResult || redaktorResult || args.has('--wydarzenia')) {
  log('kalendarz wydarzeń z cgk.czestochowa.pl…');
  cgkResult = await importCgk({ maxRewrites: Number(process.env.CGK_MAX || 20), log })
    .catch((e) => ({ found: 0, added: [], rewritten: [], removed: [], errors: [e.message] }));
  log(`wydarzenia: w kanale ${cgkResult.found}, nowych ${cgkResult.added.length}, przeredagowanych ${cgkResult.rewritten.length}, zakończonych ${cgkResult.removed.length}, błędów ${cgkResult.errors.length}`);
}

// 1c. nowe ilustracje AI zamówione w panelu (generator blokuje zapytania z przeglądarki, więc robi je automat)
// gotowość zapisujemy dopiero po wdrożeniu – wtedy podgląd w panelu już się wczyta
const coverJobs = await firestore.collection('articles').where('coverPending', '==', true).get();
const coverDone = [];
for (const d of coverJobs.docs) {
  const { title = '', coverRequest = {} } = d.data();
  const store = {
    saveImage: async (p, buf) => {
      const full = path.join(MEDIA, p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buf);
      return `/media/${p}`;
    },
  };
  try {
    const image = await aiCandidate(store, { slug: d.id, title, prompt: coverRequest.prompt });
    coverDone.push([d.ref, { coverPending: false, coverCandidate: { image, prompt: coverRequest.prompt || title, at: FieldValue.serverTimestamp() }, coverError: null }]);
    log(`nowa ilustracja AI: ${d.id}`);
  } catch (e) {
    coverDone.push([d.ref, { coverPending: false, coverError: e.message }]);
    log(`ilustracja AI ${d.id}: ${e.message}`);
  }
}

// 2. zdjęcia wgrane w panelu (czekają w kolekcji „uploads” jako base64)
const uploads = await firestore.collection('uploads').get();
for (const d of uploads.docs) {
  const { path: p, data } = d.data();
  if (!p || !data || p.includes('..')) continue;
  const full = path.join(MEDIA, p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.from(data, 'base64'));
}
log(`zdjęcia z panelu: ${uploads.size}`);

// 3. przyrostowa kopia artykułów (czytamy tylko zmienione od ostatniej publikacji)
await fs.mkdir('data', { recursive: true });
const snapFile = JSON.parse(await fs.readFile(SNAP, 'utf8').catch(() => '{"since":0,"articles":{}}'));
const since = new Date(Math.max(0, (snapFile.since || 0) - 10 * 60e3)); // zapas na rozjazd zegarów
const plain = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
const changed = await firestore.collection('articles').where('updatedAt', '>', Timestamp.fromDate(since)).get();
for (const d of changed.docs) {
  const a = plain(d.data());
  if (a.status === 'deleted') delete snapFile.articles[d.id];
  else snapFile.articles[d.id] = a;
}
// miniatury 240 px dla list (dla artykułów sprzed dodania tego rozmiaru)
const sharp = (await import('sharp')).default;
let thumbs = 0;
for (const a of Object.values(snapFile.articles)) {
  const set = a.cover?.srcset;
  if (!set?.length || set.some((v) => v.w <= 300) || !set[0].url.startsWith('/media/')) continue;
  const srcFile = path.join('public', set[0].url);
  const out = srcFile.replace(/-(\d+)\.webp$/, '-240.webp');
  try {
    const info = await sharp(srcFile).resize({ width: 240 }).webp({ quality: 66, effort: 6 }).toFile(out);
    set.unshift({ w: info.width, h: info.height, url: '/' + path.relative('public', out) });
    thumbs++;
  } catch {}
}
if (thumbs) log(`dodano miniatury: ${thumbs}`);
snapFile.since = startedAt.toMillis();
await fs.writeFile(SNAP, JSON.stringify(snapFile));
log(`artykuły: zmienionych ${changed.size}, razem ${Object.keys(snapFile.articles).length}`);

// 4. banery i ustawienia (małe kolekcje – zawsze całe)
const [ads, site] = await Promise.all([firestore.collection('ads').get(), firestore.collection('config').doc('site').get()]);
await fs.writeFile('data/site.json', JSON.stringify({ ads: ads.docs.map((d) => ({ id: d.id, ...plain(d.data()) })), settings: plain(site.data() || {}) }));

// 5. build i wdrożenie
log('build…');
execSync('npx astro build', { stdio: 'inherit', env: { ...process.env, CK_DATA: 'data' } });
if (!args.has('--no-deploy')) {
  log('wdrożenie na Firebase Hosting…');
  execSync('npx firebase deploy --only hosting --project czestokocham --non-interactive --message "publikacja automatyczna"', { stdio: 'inherit' });
}

// 6. porządki. W GitHub Actions kolejkę zdjęć z panelu czyści dopiero scripts/finish.mjs po udanym zapisie w repozytorium –
// inaczej nieudany push gubił wgrane zdjęcia (plik był tylko na maszynie automatu)
const cleanup = {
  uploads: uploads.docs.map((d) => d.id),
  covers: coverDone.map(([ref, upd]) => [ref.id, upd.coverCandidate ? { ...upd, coverCandidate: { ...upd.coverCandidate, at: null } } : upd]),
};
if (process.env.GITHUB_ACTIONS) {
  await fs.mkdir('.cache', { recursive: true });
  await fs.writeFile('.cache/cleanup.json', JSON.stringify(cleanup));
} else {
  const { finish } = await import('./finish.mjs');
  await finish(cleanup);
}
const update = { dirty: false, importRequested: false, lastBuild: startedAt };
if (importResult) {
  // pora liczona od startu – import zaczęty 11:58 nie może zaliczyć importu o 12:00
  const slot = importSlot(warsawNow(startedAt.toDate()));
  if (slot) update.lastImportSlot = slot;
  // lastImportDay = odbył się ostatni import dnia (starsze wersje budzika patrzą tylko na to pole)
  if (slot?.endsWith(` ${IMPORT_HOURS.at(-1)}`)) update.lastImportDay = warsawNow(startedAt.toDate()).day;
}
if (redaktorResult) Object.assign(update, { redaktorRequested: false, lastRedaktorAt: startedAt });
// najbliższa zaplanowana publikacja (redaktor naczelny rozkłada teksty w ciągu dnia) – check.mjs i budzik uruchomią wtedy build
const upcoming = (await firestore.collection('articles').where('publishedAt', '>', new Date(Date.now() + 5 * 60e3)).orderBy('publishedAt').limit(30).select('status', 'publishedAt').get())
  .docs.find((d) => d.get('status') === 'published');
update.nextScheduledAt = upcoming ? upcoming.get('publishedAt') : null;
// nie kasujemy flagi, jeśli ktoś zapisał coś w trakcie publikacji
const latest = (await buildRef.get()).data() || {};
if (latest.dirtyAt && latest.dirtyAt.toMillis() > startedAt.toMillis()) update.dirty = true;
await buildRef.set(update, { merge: true });
log('gotowe');
