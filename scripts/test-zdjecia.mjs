import { coverFor } from '../lib/images.js';
import fs from 'node:fs/promises';
const OUT = process.argv[2];
const store = { saveImage: async (p, b) => { const f = `${OUT}/${p.replace(/\//g, '_')}`; await fs.writeFile(f, b); return f; } };
const cases = [
  { slug: 'siatkowka', title: 'Siatkarskie superpuchary już u nas', lead: 'W weekend w Częstochowie rozegrane zostaną mecze o Superpuchar Polski siatkarzy i siatkarek.', stockQueries: ['volleyball match', 'volleyball', 'sports hall'], illustrationPrompt: 'Volleyball players during a match in a modern sports hall' },
  { slug: 'grypa', title: 'Bezpłatne szczepienia przeciwko grypie', lead: 'Seniorzy mogą zaszczepić się bezpłatnie w przychodniach.', stockQueries: ['flu vaccine', 'vaccination', 'clinic'], illustrationPrompt: 'A nurse preparing a flu vaccine in a clinic' },
  { slug: 'bilet', title: 'Wspólny bilet z korzyścią dla pasażerów', lead: 'Nowy bilet łączy komunikację miejską i kolej.', stockQueries: ['city bus', 'public transport', 'bus stop'], illustrationPrompt: 'City bus at a stop on an autumn street' },
  { slug: 'policja', title: 'Policja podsumowała weekend na drogach', lead: 'Prawie 50 kolizji i jeden wypadek.', stockQueries: ['police car', 'traffic police', 'police'], illustrationPrompt: 'Police car on a road at night' },
];
for (const c of cases) {
  const t = Date.now();
  const r = await coverFor(store, { ...c, log: (m) => console.log('  ', m) });
  console.log(`${c.slug}: ${r.imageSource || 'brak'} ${r.photoCredit || ''} (${Math.round((Date.now() - t) / 1000)} s)\n`);
}
