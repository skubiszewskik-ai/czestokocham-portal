// Po udanym zapisie zdjęć w repozytorium: usuwa wgrane zdjęcia z kolejki „uploads” i oznacza gotowe ilustracje AI.
// Użycie (GitHub Actions, po git push): node scripts/finish.mjs – czyta .cache/cleanup.json zapisany przez publish.mjs
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestore.js';

export async function finish({ uploads = [], covers = [] }) {
  const firestore = db();
  await Promise.all(uploads.map((id) => firestore.collection('uploads').doc(id).delete()));
  await Promise.all(covers.map(([id, upd]) => {
    if (upd.coverCandidate) upd.coverCandidate.at = FieldValue.serverTimestamp();
    return firestore.collection('articles').doc(id).update(upd);
  }));
  console.log(`porządki: zdjęć z panelu ${uploads.length}, ilustracji AI ${covers.length}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = await fs.readFile('.cache/cleanup.json', 'utf8').catch(() => null);
  if (raw) await finish(JSON.parse(raw));
  else console.log('porządki: brak pliku .cache/cleanup.json');
}
