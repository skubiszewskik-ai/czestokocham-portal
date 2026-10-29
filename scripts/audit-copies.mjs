// Jednorazowy audyt: ile treści opublikowanych artykułów pokrywa się ze źródłem (source.url / basedOn.url)
// Użycie: node scripts/audit-copies.mjs [--apply]   (--apply: kopie > 40% → szkic z origin 'import')
import fs from 'node:fs/promises';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestore.js';
import { copyRatio } from '../lib/redaktor.js';

const LIMIT = 0.4;
const apply = process.argv.includes('--apply');
const firestore = db();
const docs = (await firestore.collection('articles').where('status', '==', 'published').get()).docs;
const rows = [];
for (const d of docs) {
  const a = d.data();
  const url = a.source?.url || a.basedOn?.url;
  if (!url) { rows.push({ slug: d.id, ratio: null }); continue; }
  let src = '';
  try { src = await (await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) })).text(); } catch {}
  const ratio = src ? copyRatio(`${a.lead || ''} ${a.body || ''}`, src) : null;
  rows.push({ slug: d.id, url, from: a.source ? 'source' : 'basedOn', ratio });
  console.log(`${ratio == null ? '  ?' : String(Math.round(ratio * 100)).padStart(3) + '%'} ${a.source ? 'S' : 'B'} ${d.id}`);
}
await fs.writeFile(process.env.OUT || 'audit-copies.json', JSON.stringify(rows, null, 1));
const bad = rows.filter((r) => r.ratio > LIMIT || (r.ratio == null && r.from === 'source'));
console.log(`opublikowanych ${docs.length}, z linkiem ${rows.filter((r) => r.url).length}, kopii (>${LIMIT * 100}% lub źródło niedostępne) ${bad.length}`);
if (apply) {
  for (const r of bad) await firestore.collection('articles').doc(r.slug).update({ status: 'draft', origin: 'import', hiddenReason: 'kopia źródła (AdSense)', updatedAt: FieldValue.serverTimestamp() });
  await firestore.collection('config').doc('build').set({ dirty: true, dirtyAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(`przeniesiono do szkiców: ${bad.length}`);
}
