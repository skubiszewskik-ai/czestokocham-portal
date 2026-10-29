// Budzik automatu Częstokocham – Google Apps Script (darmowy, działa na serwerach Google, konto skubiszewskik@gmail.com).
// Harmonogram GitHuba potrafi pominąć większość uruchomień, więc co 15 minut budzik sam sprawdza w Firestore
// to samo co scripts/check.mjs (zmiany z panelu, import o 10, 12 i 15, redaktor co 2 godziny 7–21,
// zaplanowane publikacje redaktora naczelnego) i tylko wtedy
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
  const scheduledDue = !!millis(b.nextScheduledAt) && millis(b.nextScheduledAt) <= Date.now(); // zaplanowana publikacja redaktora naczelnego
  return importDue ? 'import' : redaktorDue ? 'redaktor' : bool(b.dirty) || scheduledDue ? 'build' : 'none';
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

// ---------- Licznik polubień Facebooka (strona główna) ----------
// Ten sam projekt jest wdrożony jako aplikacja internetowa (Wdróż → Aplikacja internetowa, „Każdy”).
// Strona pyta ją co kilka sekund; skrypt pyta Facebooka najwyżej raz na FB_TTL sekund, resztę podaje z pamięci
// podręcznej, więc niezależnie od liczby czytelników mieści się w limicie 20 000 zapytań dziennie.
// Token strony leży we Właściwościach skryptu (FB_PAGE_TOKEN), nigdy w kodzie ani w przeglądarce.
const FB_PAGE = 'czestokocham';
const FB_TTL = 6; // sekund

function doGet() {
  return ContentService.createTextOutput(JSON.stringify(fbCounts())).setMimeType(ContentService.MimeType.JSON);
}

function fbCounts() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('fb');
  if (hit) return JSON.parse(hit);
  const props = PropertiesService.getScriptProperties();
  let out;
  try {
    const res = UrlFetchApp.fetch(`https://graph.facebook.com/v26.0/${props.getProperty('FB_PAGE_ID') || FB_PAGE}?fields=fan_count,followers_count&access_token=${encodeURIComponent(props.getProperty('FB_PAGE_TOKEN'))}`, { muteHttpExceptions: true });
    const j = JSON.parse(res.getContentText());
    if (!j.fan_count) throw new Error(JSON.stringify(j.error || j));
    out = { likes: j.fan_count, followers: j.followers_count || null, t: Date.now() };
    props.setProperty('FB_LAST', JSON.stringify(out));
  } catch (e) {
    console.error(`Facebook: ${e}`);
    out = JSON.parse(props.getProperty('FB_LAST') || '{}'); // ostatnia znana liczba zamiast błędu na stronie
    out.stale = true;
  }
  cache.put('fb', JSON.stringify(out), out.stale ? 30 : FB_TTL);
  return out;
}

// Jednorazowo: wklej we Właściwościach skryptu FB_USER_TOKEN (długoterminowy token użytkownika z Graph API Explorer)
// i uruchom tę funkcję – zamieni go na bezterminowy token strony (aplikacja Meta „Czestokocham Licznik”, ID 1147762300971771)
// i usunie token użytkownika.
function ustawFacebook() {
  const props = PropertiesService.getScriptProperties();
  const user = props.getProperty('FB_USER_TOKEN');
  if (!user) throw new Error('Brak FB_USER_TOKEN we Właściwościach skryptu');
  // strona należy do portfolio firmowego, więc nie ma jej w me/accounts – pytamy ją wprost o token
  const page = JSON.parse(UrlFetchApp.fetch(`https://graph.facebook.com/v26.0/${FB_PAGE}?fields=id,name,access_token&access_token=${encodeURIComponent(user)}`, { muteHttpExceptions: true }).getContentText());
  if (page.error || !page.access_token) throw new Error(page.error ? page.error.message : 'Facebook nie zwrócił tokena strony');
  props.setProperty('FB_PAGE_TOKEN', page.access_token);
  props.setProperty('FB_PAGE_ID', page.id);
  props.deleteProperty('FB_USER_TOKEN');
  CacheService.getScriptCache().remove('fb');
  console.log(`token strony „${page.name}” zapisany:`, fbCounts());
}
