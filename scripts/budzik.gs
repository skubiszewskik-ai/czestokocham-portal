// Budzik automatu Częstokocham – Google Apps Script (darmowy, działa na serwerach Google, konto skubiszewskik@gmail.com).
// Harmonogram GitHuba potrafi pominąć większość uruchomień, więc co 15 minut budzik sam sprawdza w Firestore
// to samo co scripts/check.mjs (zmiany z panelu, import o 10, 12 i 15, redaktor co 2 godziny 7–21) i tylko wtedy
// uruchamia automat na GitHubie – nie zużywa minut GitHub Actions, gdy nic nie czeka.
// Token GitHuba bierze z bazy (config/github – ten sam, który zapisuje panel w Ustawieniach).
//
// Instalacja: script.google.com → Nowy projekt → wklej ten plik oraz scripts/budzik.appsscript.json jako appsscript.json
// (Ustawienia projektu → „Pokaż plik manifestu appsscript.json”), potem uruchom funkcję „instaluj” i zezwól na dostęp.

const REPO = 'skubiszewskik-ai/czestokocham-portal';
const DOCS = 'https://firestore.googleapis.com/v1/projects/czestokocham/databases/(default)/documents';
const IMPORT_HOURS = [10, 12, 15]; // jak lib/firestore.js

function firestoreDoc(path) {
  const res = UrlFetchApp.fetch(`${DOCS}/${path}`, { headers: { authorization: `Bearer ${ScriptApp.getOAuthToken()}` }, muteHttpExceptions: true });
  if (res.getResponseCode() === 404) return {};
  if (res.getResponseCode() !== 200) throw new Error(`Firestore ${res.getResponseCode()}: ${res.getContentText()}`);
  return JSON.parse(res.getContentText()).fields || {};
}
const bool = (f) => !!(f && f.booleanValue);
const millis = (f) => (f && f.timestampValue ? new Date(f.timestampValue).getTime() : 0);

/** To samo co scripts/check.mjs: 'import' | 'redaktor' | 'build' | 'none' */
function whatToDo() {
  const b = firestoreDoc('config/build');
  const day = Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd');
  const hour = Number(Utilities.formatDate(new Date(), 'Europe/Warsaw', 'H'));
  const h = IMPORT_HOURS.filter((x) => x <= hour).pop();
  const slot = h === undefined ? null : `${day} ${h}`;
  const importDue = (!!slot && (b.lastImportSlot || {}).stringValue !== slot) || bool(b.importRequested);
  const redaktorDue = bool(b.redaktorRequested) || (hour >= 7 && hour <= 21 && Date.now() - millis(b.lastRedaktorAt) >= 2 * 3600e3);
  return importDue ? 'import' : redaktorDue ? 'redaktor' : bool(b.dirty) ? 'build' : 'none';
}

function budzik() {
  const hour = Number(Utilities.formatDate(new Date(), 'Europe/Warsaw', 'H'));
  if (hour < 6) return; // w nocy automat nic nie robi
  const run = whatToDo();
  if (run === 'none') return;
  // automat publikuje już coś od niedawna – nie dokładamy kolejnego uruchomienia do kolejki
  const token = (firestoreDoc('config/github').token || {}).stringValue;
  if (!token) throw new Error('Brak tokena GitHuba w config/github (panel → Ustawienia)');
  const gh = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const runs = JSON.parse(UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/actions/runs?per_page=5`, { headers: gh }).getContentText()).workflow_runs || [];
  if (runs.some((r) => r.status !== 'completed' && Date.now() - new Date(r.created_at).getTime() < 40 * 60e3)) return;
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/actions/workflows/publish.yml/dispatches`, {
    method: 'post', contentType: 'application/json', headers: gh, muteHttpExceptions: true,
    payload: JSON.stringify({ ref: 'main', inputs: { mode: 'auto' } }),
  });
  if (res.getResponseCode() !== 204) throw new Error(`GitHub ${res.getResponseCode()}: ${res.getContentText()}`);
  console.log(`uruchomiono automat (${run})`);
}

function instaluj() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('budzik').timeBased().everyMinutes(15).create();
  console.log(`teraz: ${whatToDo()}`);
  budzik();
}
