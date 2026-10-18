// Szybkie sprawdzenie (GitHub Actions co 30 min): czy trzeba publikować i czy pora na import (czestochowa.pl, wczestochowie.pl)
// albo na wirtualnego redaktora
import { appendFileSync } from 'node:fs';
import { db, warsawNow, IMPORT_HOUR } from '../lib/firestore.js';

const snap = await db().collection('config').doc('build').get();
const b = snap.data() || {};
const now = warsawNow();
const importDue = (now.hour >= IMPORT_HOUR && b.lastImportDay !== now.day) || !!b.importRequested;
// wirtualny redaktor co 2 godziny w ciągu dnia (7–21) albo na żądanie z panelu
const redaktorDue = !!b.redaktorRequested || (now.hour >= 7 && now.hour <= 21 && Date.now() - (b.lastRedaktorAt?.toMillis() || 0) >= 2 * 3600e3);
const run = importDue ? 'import' : redaktorDue ? 'redaktor' : b.dirty || !snap.exists ? 'build' : 'none';
console.log(`Warszawa ${now.day} ${now.hour}:00 → ${run}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
