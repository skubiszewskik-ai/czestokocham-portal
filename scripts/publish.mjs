// Publikacja portalu: (import z czestochowa.pl i wczestochowie.pl) → zdjęcia z panelu → zmiany z bazy → build Astro → Firebase Hosting
// Użycie: node scripts/publish.mjs [--import] [--no-deploy]
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db, warsawNow } from '../lib/firestore.js';
import { importLatest, importWczestochowie } from '../lib/importer.js';

const args = new Set(process.argv.slice(2));
const firestore = db();
const MEDIA = 'public/media';
const SNAP = 'data/articles.json';
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

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
      (await firestore.collection('articles').where('publishedAt', '>=', since).select('keywords').get()).docs.map((d) => ({ slug: d.id, keywords: d.get('keywords') })),
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

// 6. porządki
await Promise.all(uploads.docs.map((d) => d.ref.delete()));
const update = { dirty: false, importRequested: false, lastBuild: startedAt };
if (importResult) update.lastImportDay = warsawNow().day;
// nie kasujemy flagi, jeśli ktoś zapisał coś w trakcie publikacji
const latest = (await buildRef.get()).data() || {};
if (latest.dirtyAt && latest.dirtyAt.toMillis() > startedAt.toMillis()) update.dirty = true;
await buildRef.set(update, { merge: true });
log('gotowe');
