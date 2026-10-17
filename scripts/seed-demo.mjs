// Lokalny podgląd bez bazy: importuje prawdziwe aktualności do demo/articles.json i public/media
import fs from 'node:fs/promises';
import path from 'node:path';
import { importLatest } from '../lib/importer.js';
const file = 'demo/articles.json';
await fs.mkdir('demo', { recursive: true });
const snap = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{"since":0,"articles":{}}'));
const store = {
  exists: async (id) => Boolean(snap.articles[id]),
  saveImage: async (p, buf) => {
    const full = path.join('public/media', p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf);
    return '/media/' + p;
  },
  saveArticle: async (id, doc) => { snap.articles[id] = doc; await fs.writeFile(file, JSON.stringify(snap, null, 1)); },
};
const r = await importLatest(store, { pages: Number(process.argv[2] || 3), limit: 40 });
console.log(JSON.stringify({ ...r, imported: r.imported.length }));
