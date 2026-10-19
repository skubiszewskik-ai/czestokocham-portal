// Budzik automatu Częstokocham – Google Apps Script (darmowy, działa na serwerach Google).
// Harmonogram GitHuba potrafi pominąć większość uruchomień, więc co godzinę prosimy GitHuba o „auto”
// (rzadziej niż harmonogram, żeby nie przekroczyć darmowych 2000 minut GitHub Actions miesięcznie):
// automat sam sprawdza (scripts/check.mjs), czy coś czeka – import po 15:00, redaktor, zmiany z panelu – i tylko wtedy publikuje.
//
// Instalacja (raz):
// 1. script.google.com → Nowy projekt → wklej ten plik.
// 2. Ustawienia projektu (koło zębate) → Właściwości skryptu → dodaj GITHUB_TOKEN = token z uprawnieniem
//    „Actions: Read and write” tylko do repozytorium czestokocham-portal (może być ten sam, co w panelu → Ustawienia).
// 3. Wybierz funkcję „instaluj” i kliknij Uruchom (Google poprosi o zgodę na wysyłanie zapytań).

const REPO = 'skubiszewskik-ai/czestokocham-portal';

function budzik() {
  const hour = Number(Utilities.formatDate(new Date(), 'Europe/Warsaw', 'H'));
  if (hour < 6) return; // w nocy automat i tak nic nie robi
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/actions/workflows/publish.yml/dispatches`, {
    method: 'post',
    contentType: 'application/json',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    payload: JSON.stringify({ ref: 'main', inputs: { mode: 'auto' } }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 204) throw new Error(`GitHub ${res.getResponseCode()}: ${res.getContentText()}`);
}

function instaluj() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('budzik').timeBased().everyHours(1).create();
  budzik();
}
