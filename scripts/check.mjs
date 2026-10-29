// Szybkie sprawdzenie (GitHub Actions co 30 min): czy trzeba publikować i czy pora na import o 10, 12 lub 15 (czestochowa.pl, wczestochowie.pl)
// albo na wirtualnego redaktora, albo czy minęła pora zaplanowanej publikacji
import { appendFileSync } from 'node:fs';
import { db, warsawNow, importSlot } from '../lib/firestore.js';

const snap = await db().collection('config').doc('build').get();
const b = snap.data() || {};
const now = warsawNow();
const slot = importSlot(now);
const importDue = (!!slot && b.lastImportSlot !== slot) || !!b.importRequested;
// wirtualny redaktor co 2 godziny w ciągu dnia (7–21) albo na żądanie z panelu
const redaktorDue = !!b.redaktorRequested || (now.hour >= 7 && now.hour <= 21 && Date.now() - (b.lastRedaktorAt?.toMillis() || 0) >= 2 * 3600e3);
// artykuł zaplanowany przez redaktora naczelnego – jego pora minęła, czas go wpuścić na stronę
const scheduledDue = !!b.nextScheduledAt && b.nextScheduledAt.toMillis() <= Date.now();
const run = importDue ? 'import' : redaktorDue ? 'redaktor' : b.dirty || scheduledDue || !snap.exists ? 'build' : 'none';
console.log(`Warszawa ${now.day} ${now.hour}:00 → ${run}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
