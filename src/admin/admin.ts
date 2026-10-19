// Panel redakcji Częstokocham – logowanie Google, pulpit, artykuły, banery, redaktor AI, import, ustawienia
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, orderBy, limit, startAfter, where,
  Timestamp, serverTimestamp, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { firebaseConfig } from '../lib/firebase-config';
import { SLOTS, type SlotKey } from '../lib/slots';
import { CATEGORIES } from '../lib/site';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => [...document.querySelectorAll(s)] as T[];
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (d?: Date | null) => (d ? d.toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const toDate = (v: any): Date | null => (v ? (v.toDate ? v.toDate() : new Date(v)) : null);
const cats = CATEGORIES as Record<string, { name: string; color: string }>;

type Variant = { w: number; h: number; url: string };
type Img = { srcset: Variant[]; w: number; h: number; alt: string };

// ---------------- powiadomienia i potwierdzenia ----------------
function toast(text: string, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = text;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, err ? 6000 : 3200);
}
function confirmBox(title: string, text: string, yes = 'Usuń'): Promise<boolean> {
  const d = $('#confirm') as HTMLDialogElement;
  $('#cf-t').textContent = title;
  $('#cf-m').textContent = text;
  $('#cf-yes').textContent = yes;
  d.showModal();
  return new Promise((res) => {
    const done = (v: boolean) => { d.close(); $('#cf-yes').onclick = $('#cf-no').onclick = null; res(v); };
    $('#cf-yes').onclick = () => done(true);
    $('#cf-no').onclick = () => done(false);
  });
}
const tagHtml = (cat: string) => { const c = cats[cat]; return c ? `<span class="pill" style="background:color-mix(in srgb, ${c.color} 12%, #fff);color:color-mix(in srgb, ${c.color} 76%, #000)">${c.name}</span>` : ''; };

// ---------------- widoki ----------------
const TITLES: Record<string, string> = { dashboard: 'Pulpit', articles: 'Artykuły', editor: 'Artykuł', ads: 'Banery', redaktor: 'Redaktor AI', import: 'Import', settings: 'Ustawienia' };
const views = Object.keys(TITLES);
function show(v: string) {
  views.forEach((x) => ($(`#v-${x}`).hidden = x !== v));
  $$('.side-nav button').forEach((b) => b.toggleAttribute('aria-current', b.dataset.tab === v || (v === 'editor' && b.dataset.tab === 'articles')));
  $('#page-title').textContent = TITLES[v];
  $('#app').classList.remove('nav-open');
  scrollTo({ top: 0 });
  buildStatus().catch(() => {});
  if (v === 'dashboard') loadDashboard();
  if (v === 'articles') loadArticles(true);
  if (v === 'ads') loadAds();
  if (v === 'redaktor') loadRedaktor();
  if (v === 'import') loadImports();
  redCount().catch(() => {});
  if (v === 'settings') loadSettings();
}
$$('.side-nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab!)));
$$('[data-tab-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tabGo!)));
$('#burger').addEventListener('click', () => $('#app').classList.toggle('nav-open'));
$('#side-scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));
$$('.qa').forEach((b) => b.addEventListener('click', () => {
  const g = b.dataset.go;
  if (g === 'new-article') openEditor(null);
  if (g === 'new-ad') { show('ads'); openAd(null); }
  if (g === 'import') { show('import'); runImport(); }
}));

// ---------------- logowanie ----------------
$('#login').addEventListener('click', async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e: any) { if (e.code !== 'auth/popup-closed-by-user') { $('#login-err').textContent = e.message; $('#login-err').hidden = false; } }
});
$('#logout').addEventListener('click', () => signOut(auth));
onAuthStateChanged(auth, async (u: User | null) => {
  if (!u) { $('#app').hidden = true; $('#v-login').hidden = false; return; }
  try {
    await getDoc(doc(db, 'config', 'admins')); // reguły wpuszczą tylko administratorów
    $('#who').textContent = u.email || '';
    $('#me-ava').textContent = (u.displayName || u.email || '?').charAt(0);
    $('#v-login').hidden = true;
    $('#app').hidden = false;
    show('dashboard');
    catchUp().catch(() => {});
  } catch {
    $('#app').hidden = true;
    $('#v-login').hidden = false;
    $('#login-err').textContent = `Konto ${u.email} nie ma dostępu do panelu. Poproś administratora o dopisanie adresu w Ustawieniach.`;
    $('#login-err').hidden = false;
    signOut(auth);
  }
});

// ---------------- status publikacji ----------------
const markDirty = async (extra: Record<string, unknown> = {}) => {
  await setDoc(doc(db, 'config', 'build'), { dirty: true, dirtyAt: serverTimestamp(), ...extra }, { merge: true });
  kickPublish();
};
// Szybka publikacja: harmonogram GitHuba bywa opóźniony o godziny, więc po zmianie od razu uruchamiamy automat
// (token GitHuba z uprawnieniem tylko do uruchamiania automatu w tym repozytorium, zapisany w config/github)
const REPO = 'skubiszewskik-ai/czestokocham-portal';
let kickTimer = 0;
let kickedAt = 0;
function kickPublish() {
  clearTimeout(kickTimer);
  kickTimer = window.setTimeout(async () => {
    try {
      const token = (await getDoc(doc(db, 'config', 'github'))).data()?.token;
      if (!token) return;
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/publish.yml/dispatches`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        body: JSON.stringify({ ref: 'main', inputs: { mode: 'build' } }),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      kickedAt = Date.now();
      buildStatus();
    } catch (err: any) {
      toast(`Nie udało się uruchomić publikacji od razu (${err.message}) – zrobi to automat według harmonogramu.`, true);
    }
  }, 3000);
}
// Harmonogram GitHuba potrafi pominąć większość uruchomień – po wejściu do panelu nadrabiamy zaległy import (po 15:00)
// i wirtualnego redaktora (co 2 godziny, 7–21), tak samo jak scripts/check.mjs
async function catchUp() {
  const b = (await getDoc(doc(db, 'config', 'build'))).data() || {};
  if (b.importRequested || b.redaktorRequested) return;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour);
  if (hour >= 15 && b.lastImportDay !== day) return markDirty({ importRequested: true });
  if (hour >= 7 && hour <= 21 && Date.now() - (toDate(b.lastRedaktorAt)?.getTime() || 0) >= 2.5 * 3600e3) return markDirty({ redaktorRequested: true });
}
async function buildStatus() {
  const b = (await getDoc(doc(db, 'config', 'build'))).data() || {};
  const last = toDate(b.lastBuild);
  const wait = b.dirty || b.importRequested;
  const el = $('#pub');
  el.classList.toggle('wait', !!wait);
  el.classList.toggle('ok', !wait);
  const kicked = Date.now() - kickedAt < 15 * 60e3;
  el.querySelector('.pub-t')!.textContent = wait ? (kicked ? 'Publikuję zmiany – zwykle 2–6 minut' : 'Zmiany czekają na publikację') : `Strona aktualna${last ? ` · ${fmt(last)}` : ''}`;
  return b;
}

// ---------------- obrazy → WebP ----------------
// crop169: pionowe zdjęcie przycinamy do 16:9 z górnej części (tam zwykle jest twarz) – listy i tak pokazują kadr poziomy
async function toWebp(file: Blob, width: number, quality = 0.78, crop169 = false): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const sh = crop169 && bmp.width / bmp.height < 1.2 ? Math.round((bmp.width * 9) / 16) : bmp.height;
  const sy = Math.round((bmp.height - sh) * 0.2);
  const w = Math.min(width, bmp.width);
  const h = Math.round((sh * w) / bmp.width);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, sy, bmp.width, sh, 0, 0, w, h);
  const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Przeglądarka nie obsługuje WebP'))), 'image/webp', quality));
  return { blob, w, h };
}
// Plan Spark nie ma Storage: plik czeka w kolekcji „uploads” (base64), automat zapisuje go w public/media przy publikacji.
const preview = new Map<string, string>();
const src = (url: string) => preview.get(url) || url;
const b64 = (blob: Blob): Promise<string> =>
  new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
async function stage(path: string, blob: Blob, contentType: string): Promise<string> {
  if (blob.size > 700 * 1024) throw new Error('Plik po kompresji jest za duży (maks. 700 KB). Zmniejsz grafikę.');
  await setDoc(doc(collection(db, 'uploads')), { path, contentType, data: await b64(blob), createdAt: serverTimestamp() });
  const url = `/media/${path}`;
  preview.set(url, URL.createObjectURL(blob));
  return url;
}
// zdjęcie wgrane, ale jeszcze nieopublikowane (np. po odświeżeniu panelu) – podgląd prosto z kolejki „uploads”
const tried = new Set<string>();
document.addEventListener('error', async (e) => {
  const img = e.target as HTMLImageElement;
  if (img?.tagName !== 'IMG') return;
  const path = new URL(img.src, location.href).pathname.match(/^\/media\/(.+)$/)?.[1];
  if (!path || tried.has(path)) return;
  tried.add(path);
  try {
    const hit = (await getDocs(query(collection(db, 'uploads'), where('path', '==', decodeURIComponent(path)), limit(1)))).docs[0];
    if (!hit) return;
    const url = `/media/${path}`;
    preview.set(url, `data:${hit.get('contentType') || 'image/webp'};base64,${hit.get('data')}`);
    img.src = preview.get(url)!;
  } catch {}
}, true);
async function uploadPhoto(file: Blob, base: string, alt: string, widths: number[]): Promise<Img> {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const srcset: Variant[] = [];
  const bmp = await createImageBitmap(file);
  for (const width of [...new Set(widths.map((w) => Math.min(w, bmp.width)))]) {
    const { blob, w, h } = await toWebp(file, width, width > 1000 ? 0.72 : 0.78, widths === COVER_W);
    srcset.push({ w, h, url: await stage(`${base}/${stamp}-${w}.webp`, blob, 'image/webp') });
  }
  const big = srcset[srcset.length - 1];
  return { srcset, w: big.w, h: big.h, alt };
}
const COVER_W = [240, 640, 1280];
const GALLERY_W = [480, 1200];

// strefy „upuść plik”
$$('[data-drop]').forEach((zone) => {
  const input = zone.querySelector('input') as HTMLInputElement;
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (!e.dataTransfer?.files.length) return;
    input.files = e.dataTransfer.files;
    input.dispatchEvent(new Event('change'));
  });
});
const busy = (sel: string, on: boolean) => $(sel).closest('.drop')?.classList.toggle('busy', on);

// ---------------- HTML z edytora ----------------
const ALLOWED = new Set(['P', 'STRONG', 'B', 'EM', 'I', 'A', 'UL', 'OL', 'LI', 'H2', 'H3', 'BR', 'BLOCKQUOTE']);
function cleanHtml(html: string): string {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = d.body.firstElementChild!;
  const walk = (el: Element) => {
    for (const ch of [...el.children]) {
      walk(ch);
      if (!ALLOWED.has(ch.tagName)) { ch.replaceWith(...ch.childNodes); continue; }
      const href = ch.tagName === 'A' ? ch.getAttribute('href') : null;
      for (const a of [...ch.attributes]) ch.removeAttribute(a.name);
      if (href && /^(https?:|mailto:|\/)/.test(href)) { ch.setAttribute('href', href); if (/^https?:/.test(href) && !href.includes('czestokocham')) ch.setAttribute('rel', 'noopener'); }
    }
  };
  walk(root);
  let out = root.innerHTML.replace(/<b>/g, '<strong>').replace(/<\/b>/g, '</strong>').replace(/<i>/g, '<em>').replace(/<\/i>/g, '</em>');
  if (!/^\s*<(p|h2|h3|ul|ol|blockquote)/.test(out) && out.trim()) out = `<p>${out}</p>`;
  return out.replace(/<p>\s*(<br>)?\s*<\/p>/g, '').trim();
}
const normalizeWord = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const keywordsFor = (...parts: string[]) =>
  [...new Set(normalizeWord(parts.join(' ')).split(/[^a-z0-9]+/).filter((w) => w.length > 2))].slice(0, 80);
const slugify = (s: string) => normalizeWord(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);

// ---------------- wiersz artykułu ----------------
function rowHtml(id: string, d: any) {
  const img = d.cover?.srcset?.[0]?.url;
  const status = (d.origin === 'redaktor' ? '<span class="pill ai">AI</span>' : '') + (d.status === 'published' ? '<span class="pill on">Opublikowany</span>' : '<span class="pill off">Szkic</span>');
  return `<button class="arow" data-id="${esc(id)}" type="button">
    <span class="arow-img" style="${img ? `background-image:url('${esc(src(img))}')` : ''}"></span>
    <span><span class="arow-t">${esc(d.title || '(bez tytułu)')}</span>
      <span class="arow-m">${tagHtml(d.category)}<span>${fmt(toDate(d.publishedAt))}</span><span>· ${esc(d.source?.name || 'redakcja')}</span></span></span>
    <span class="arow-r">${d.featured ? '<span class="pill star">★ Główny</span>' : ''}${status}</span>
  </button>`;
}
const bindRows = (root: string) => $$(`${root} [data-id]`).forEach((b) => b.addEventListener('click', () => openEditor(b.dataset.id!)));

// ---------------- pulpit ----------------
async function loadDashboard() {
  const [arts, adsSnap, imps, b] = await Promise.all([
    getDocs(query(collection(db, 'articles'), orderBy('publishedAt', 'desc'), limit(200))),
    getDocs(query(collection(db, 'ads'), where('active', '==', true))),
    getDocs(query(collection(db, 'imports'), orderBy('at', 'desc'), limit(1))),
    buildStatus(),
  ]);
  const docs = arts.docs.filter((d) => d.data().status !== 'deleted');
  const today = new Date().toDateString();
  $('#st-pub').textContent = String(docs.filter((d) => d.data().status === 'published').length);
  $('#st-today').textContent = String(docs.filter((d) => toDate(d.data().publishedAt)?.toDateString() === today).length);
  $('#st-ads').textContent = String(adsSnap.size);
  const imp = imps.docs[0]?.data();
  $('#st-imp').textContent = imp ? `+${(imp.imported || []).length}` : '—';
  $('#st-imp-s').textContent = imp ? `nowych · ${fmt(toDate(imp.at))}` : 'jeszcze nie było';
  void b;
  $('#dash-list').innerHTML = docs.slice(0, 6).map((d) => rowHtml(d.id, d.data())).join('') || '<p class="empty-s">Brak artykułów.</p>';
  bindRows('#dash-list');
}

// ---------------- lista artykułów ----------------
let lastDoc: QueryDocumentSnapshot | null = null;
let rows: { id: string; d: any }[] = [];
let catFilter = '';
async function loadArticles(reset = false) {
  if (reset) { lastDoc = null; rows = []; $('#a-list').innerHTML = '<p class="empty-s">Wczytuję…</p>'; }
  const parts: any[] = [collection(db, 'articles')];
  if (catFilter) parts.push(where('category', '==', catFilter));
  parts.push(orderBy('publishedAt', 'desc'));
  if (lastDoc) parts.push(startAfter(lastDoc));
  parts.push(limit(50));
  const snap = await getDocs((query as any)(...parts));
  snap.docs.forEach((d) => rows.push({ id: d.id, d: d.data() }));
  lastDoc = snap.docs[snap.docs.length - 1] || lastDoc;
  $('#a-more').hidden = snap.size < 50;
  renderArticles();
}
function renderArticles() {
  const q = normalizeWord(($('#a-q') as HTMLInputElement).value);
  const list = rows.filter((r) => r.d.status !== 'deleted' && (!q || normalizeWord(r.d.title || '').includes(q)));
  $('#a-list').innerHTML = list.map((r) => rowHtml(r.id, r.d)).join('') || '<p class="empty-s">Brak artykułów.</p>';
  bindRows('#a-list');
}
$('#a-q').addEventListener('input', renderArticles);
$$('#a-cat button').forEach((b) => b.addEventListener('click', () => {
  catFilter = b.dataset.cat || '';
  $$('#a-cat button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadArticles(true);
}));
$('#a-more').addEventListener('click', () => loadArticles());
$('#a-new').addEventListener('click', () => openEditor(null));

// ---------------- edytor ----------------
let current: { id: string | null; cover: Img | null; gallery: Img[]; data: any; imageSource: string | null } = { id: null, cover: null, gallery: [], data: {}, imageSource: null };
const form = $('#e-form') as HTMLFormElement;
const F = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const grow = () => { const t = F('title'); t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };

async function openEditor(id: string | null) {
  form.reset();
  current = { id, cover: null, gallery: [], data: {}, imageSource: null };
  if (id) current.data = (await getDoc(doc(db, 'articles', id))).data() || {};
  const d = current.data;
  show('editor');
  $('#e-h').textContent = id ? 'Edycja artykułu' : 'Nowy artykuł';
  F('title').value = d.title || '';
  F('slug').value = d.slug || id || '';
  F('slug').readOnly = !!id;
  F('lead').value = d.lead || '';
  F('category').value = d.category || 'miasto';
  $('#slug-cat').textContent = F('category').value;
  F('status').value = d.status === 'draft' ? 'draft' : 'published';
  F('publishedAt').value = localInput(toDate(d.publishedAt) || new Date());
  F('featured').checked = !!d.featured;
  F('author').value = d.author || 'Redakcja';
  F('photoCredit').value = d.photoCredit || '';
  F('sourceName').value = d.source?.name || '';
  F('sourceUrl').value = d.source?.url || '';
  F('coverAlt').value = d.cover?.alt || '';
  $('#rte').innerHTML = d.body || '';
  const ai = d.origin === 'redaktor' && d.basedOn;
  $('#e-ai').hidden = !ai;
  if (ai) {
    const also = (d.basedOn.alsoIn || []).map((x: any) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>`).join(', ');
    $('#e-ai-t').innerHTML = `Napisany na podstawie: <a href="${esc(d.basedOn.url)}" target="_blank" rel="noopener">${esc(d.basedOn.title || d.basedOn.name)}</a> (${esc(d.basedOn.name)})${also ? `. Ten sam temat także: ${also}` : ''}.<br>Zdjęcie: ${esc(IMG_SRC[d.imageSource] || '—')}${d.imagePage ? ` (<a href="${esc(d.imagePage)}" target="_blank" rel="noopener">licencja</a>)` : ''}. ${d.source ? 'Pod artykułem pojawi się źródło, bo to własny materiał portalu.' : 'Bez dopisku źródła (komunikat instytucji lub wydarzenie).'} Sprawdź fakty przed publikacją.${d.copyRisk ? `<br><strong>Uwaga: ${d.copyRisk}% zwrotów pokrywa się ze źródłem – przeredaguj tekst przed publikacją.</strong>` : ''}`;
  }
  $('#e-approve').hidden = !ai || d.status !== 'draft';
  current.cover = d.cover || null;
  current.imageSource = d.imageSource || null;
  current.gallery = d.gallery || [];
  resetCoverTools(d);
  renderCover(); renderGallery(); updateView();
  $('#e-del').hidden = !id;
  requestAnimationFrame(grow);
  if (!id) F('title').focus();
}
function updateView() {
  const v = $('#e-view') as HTMLAnchorElement;
  v.hidden = !current.id || current.data.status !== 'published';
  if (current.id) v.href = `/${current.data.category || F('category').value}/${current.id}`;
}
F('title').addEventListener('input', () => { grow(); if (!current.id) F('slug').value = slugify(F('title').value); });
F('category').addEventListener('change', () => ($('#slug-cat').textContent = F('category').value));
$('#e-back').addEventListener('click', () => show(current.data.origin === 'redaktor' && current.data.status === 'draft' ? 'redaktor' : 'articles'));
$('#e-approve').addEventListener('click', () => {
  F('status').value = 'published';
  F('publishedAt').value = localInput(new Date());
  $('#e-approve').hidden = true;
  form.requestSubmit();
});

function renderCover() {
  const c = current.cover;
  $('#cover').innerHTML = c ? `<img src="${esc(src(c.srcset[Math.min(1, c.srcset.length - 1)].url))}" alt="">` : '';
}
function renderGallery() {
  $('#gal').innerHTML = current.gallery.map((g, i) => `<figure><img src="${esc(src(g.srcset[0].url))}" alt=""><button type="button" data-rm="${i}" aria-label="Usuń zdjęcie">×</button></figure>`).join('');
  $('#gal-n').textContent = current.gallery.length ? `${current.gallery.length} zdj.` : '';
  $$('#gal [data-rm]').forEach((b) => b.addEventListener('click', () => { current.gallery.splice(+b.dataset.rm!, 1); renderGallery(); }));
}
const slugBase = () => `u/${F('slug').value || 'nowy'}`;
const AI_CREDIT = 'Ilustracja wygenerowana przez AI';
/** Nowe zdjęcie główne z pliku, schowka, generatora AI albo Wikipedii; credit === undefined → podpis wpisuje redakcja */
async function setCover(file: Blob, source: string, credit?: string) {
  busy('#cover-in', true);
  try {
    current.cover = await uploadPhoto(file, slugBase(), F('coverAlt').value || F('title').value, COVER_W);
    current.imageSource = source;
    if (credit !== undefined) F('photoCredit').value = credit;
    else if (F('photoCredit').value === AI_CREDIT || current.data.photoCredit === F('photoCredit').value) F('photoCredit').value = '';
    renderCover();
    $('#c-note').hidden = true;
    toast(credit === undefined ? 'Zdjęcie główne podmienione – wpisz autora zdjęć' : 'Zdjęcie główne podmienione');
    if (credit === undefined) F('photoCredit').focus();
  } catch (err: any) { toast(err.message, true); }
  busy('#cover-in', false);
}
$('#cover-in').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await setCover(file, 'wlasne');
  (e.target as HTMLInputElement).value = '';
});

// wklejanie ze schowka (⌘V / Ctrl+V) – obraz trafia do zdjęcia głównego
const imageFrom = (dt: DataTransfer | null) => [...(dt?.files || [])].find((f) => f.type.startsWith('image/')) || null;
document.addEventListener('paste', async (e: ClipboardEvent) => {
  if ($('#v-editor').hidden) return;
  const target = e.target as HTMLElement;
  const inText = !!target.closest?.('#rte, input, textarea');
  const text = e.clipboardData?.getData('text/plain')?.trim() || '';
  const img = imageFrom(e.clipboardData);
  // w treści lub polu tekstowym wklejony tekst zostaje tekstem (Word dokłada obrazek akapitu)
  if (inText && (text || !img)) return;
  if (img) {
    e.preventDefault(); e.stopPropagation();
    return setCover(img, 'wlasne');
  }
  // „Kopiuj adres obrazu” – spróbujemy pobrać; wiele stron na to nie pozwala
  const url = /^https?:\/\/\S+$/.test(text) ? text : new DOMParser().parseFromString(e.clipboardData?.getData('text/html') || '', 'text/html').querySelector('img')?.src;
  if (!url) return;
  e.preventDefault();
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    if (!res.ok || !blob.type.startsWith('image/')) throw new Error();
    await setCover(blob, 'wlasne');
  } catch { toast('Ta strona nie pozwala pobrać zdjęcia z adresu. Kliknij zdjęcie prawym przyciskiem → „Kopiuj obraz” i wklej ponownie.', true); }
}, true);

// ---------------- narzędzia zdjęcia głównego: nowa ilustracja AI, wyszukiwanie zdjęcia ----------------
const personName = () => ($('#c-person') as HTMLInputElement).value.trim();
let articlePerson = ''; // artykuł o konkretnej osobie (wykrył redaktor) – bez ilustracji AI
function resetCoverTools(d: any) {
  const person = (articlePerson = d.ai?.person?.name || '');
  ($('#c-person') as HTMLInputElement).value = person;
  ($('#c-prompt') as HTMLTextAreaElement).value = d.ai?.illustrationPrompt || '';
  $('#c-ai-box').hidden = !d.coverPending && !d.coverCandidate;
  renderAiCandidate();
  $('#c-find-box').hidden = !person;
  $('#c-res').innerHTML = '';
  const note = $('#c-note');
  note.hidden = !person;
  note.classList.toggle('need', !!d.needsPhoto);
  note.textContent = d.needsPhoto
    ? `Artykuł o osobie (${person}) – redaktor nie znalazł jej zdjęcia. Wklej prawdziwe zdjęcie (⌘V) albo wyszukaj poniżej.`
    : person ? `Artykuł o osobie (${person}) – na miniaturze musi być jej prawdziwe zdjęcie, nie ilustracja AI.` : '';
  syncCoverTools();
}
function syncCoverTools() {
  const ai = $('#c-ai') as HTMLButtonElement;
  ai.disabled = !!articlePerson;
  ai.title = articlePerson ? 'Artykuł o osobie – użyj jej prawdziwego zdjęcia' : '';
  if (articlePerson) $('#c-ai-box').hidden = true;
  ($('#c-google') as HTMLAnchorElement).href = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(personName() || F('title').value)}`;
}
$('#c-person').addEventListener('input', syncCoverTools);
// Enter w polu wyszukiwania otwiera Google Grafika (zamiast zapisywać artykuł)
$('#c-person').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  syncCoverTools();
  $('#c-google').click();
});
$('#c-ai').addEventListener('click', () => {
  const box = $('#c-ai-box');
  box.hidden = !box.hidden;
  const p = $('#c-prompt') as HTMLTextAreaElement;
  if (!p.value) p.value = F('title').value;
  if (!box.hidden) p.focus();
});
$('#c-find').addEventListener('click', () => {
  const box = $('#c-find-box');
  box.hidden = !box.hidden;
  syncCoverTools();
  if (!box.hidden) ($('#c-person') as HTMLInputElement).focus();
});

// Generator ilustracji blokuje zapytania z przeglądarki – grafikę robi automat (publikacja uruchamia się od razu),
// a gotowy podgląd czeka w artykule (coverCandidate), dopóki redakcja go nie użyje.
let aiPoll = 0;
function renderAiCandidate() {
  const d = current.data;
  const prev = $('#c-ai-prev');
  const go = $('#c-ai-go') as HTMLButtonElement;
  clearTimeout(aiPoll);
  $('#c-ai-use').hidden = !d.coverCandidate || !!d.coverPending;
  go.disabled = !!d.coverPending;
  go.textContent = d.coverPending ? 'Generuję…' : d.coverCandidate ? 'Generuj jeszcze raz' : 'Generuj';
  if (d.coverPending) {
    prev.className = 'cover wait';
    prev.textContent = 'Automat tworzy ilustrację – zwykle 2–6 minut. Możesz w tym czasie pracować dalej.';
    aiPoll = window.setTimeout(async () => {
      if (!current.id || $('#v-editor').hidden) return;
      const fresh = (await getDoc(doc(db, 'articles', current.id))).data() || {};
      Object.assign(current.data, { coverPending: fresh.coverPending, coverCandidate: fresh.coverCandidate, coverError: fresh.coverError });
      if (!fresh.coverPending && fresh.coverError) toast(`Nie udało się wygenerować ilustracji: ${fresh.coverError}`, true);
      renderAiCandidate();
    }, 20000);
  } else if (d.coverCandidate) {
    prev.className = 'cover';
    prev.innerHTML = `<img src="${esc(d.coverCandidate.image.srcset[Math.min(1, d.coverCandidate.image.srcset.length - 1)].url)}" alt="">`;
  } else { prev.className = 'cover'; prev.innerHTML = ''; }
}
$('#c-ai-go').addEventListener('click', async () => {
  if (!current.id) return toast('Najpierw zapisz artykuł – potem zamów ilustrację.', true);
  const prompt = ($('#c-prompt') as HTMLTextAreaElement).value.trim() || F('title').value.trim();
  if (!prompt) return toast('Opisz, co ma być na ilustracji.', true);
  try {
    await updateDoc(doc(db, 'articles', current.id), { coverPending: true, coverRequest: { prompt, at: serverTimestamp() }, coverError: null });
    current.data.coverPending = true;
    await markDirty();
    renderAiCandidate();
    toast('Zamówiono nową ilustrację – podgląd pojawi się tutaj.');
  } catch (err: any) { toast(err.message, true); }
});
$('#c-ai-use').addEventListener('click', () => {
  const c = current.data.coverCandidate;
  if (!c) return;
  current.cover = { ...c.image, alt: F('coverAlt').value || F('title').value };
  current.imageSource = 'ai';
  F('photoCredit').value = AI_CREDIT;
  $('#c-note').hidden = true;
  renderCover();
  $('#c-ai-box').hidden = true;
  toast('Ilustracja ustawiona – zapisz artykuł.');
});

// Wikipedia i Wikimedia Commons (API pozwala na zapytania z przeglądarki: origin=*)
type Found = { thumb: string; url: string; credit: string };
const FREE = /^(CC0|CC BY(-SA)? [\d.]+|Public domain)/i;
async function mw(host: string, params: Record<string, string>) {
  const u = new URL(`https://${host}/w/api.php`);
  Object.entries({ format: 'json', formatversion: '2', origin: '*', ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
  return (await fetch(u)).json();
}
const IMGINFO = { prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '1600' };
function found(p: any): Found | null {
  const ii = p?.imageinfo?.[0];
  const meta = ii?.extmetadata || {};
  const license = meta.LicenseShortName?.value || '';
  if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || ii.width < 400 || !FREE.test(license)) return null;
  const artist = (meta.Artist?.value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'autor nieznany';
  return { thumb: ii.thumburl.replace(/\/\d+px-/, '/500px-'), url: ii.thumburl || ii.url, credit: `${artist} / Wikimedia Commons, ${license}` };
}
let results: Found[] = [];
$('#c-find-go').addEventListener('click', async () => {
  const name = personName();
  if (!name) return toast('Wpisz, czego szukasz.', true);
  const btn = $('#c-find-go') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = 'Szukam…';
  results = [];
  try {
    const wiki = await mw('pl.wikipedia.org', { action: 'query', titles: name, redirects: '1', prop: 'pageprops', ppprop: 'page_image_free' });
    const file = wiki.query?.pages?.[0]?.pageprops?.page_image_free;
    const titles = file ? [`File:${file}`] : [];
    const search = await mw('commons.wikimedia.org', { action: 'query', list: 'search', srnamespace: '6', srlimit: '12', srsearch: `"${name}" filetype:bitmap` });
    // z wyszukiwarki Commons tylko pliki, które mają w nazwie wszystkie szukane słowa (opis bywa o czymś innym)
    const words = normalizeWord(name).split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    titles.push(...(search.query?.search || []).map((x: any) => x.title).filter((t: string) => words.every((w) => normalizeWord(t).includes(w))));
    if (titles.length) {
      const info = await mw('commons.wikimedia.org', { action: 'query', titles: [...new Set(titles)].slice(0, 12).join('|'), ...IMGINFO });
      const order = new Map(titles.map((t, i) => [t.replace(/_/g, ' '), i]));
      results = (info.query?.pages || []).sort((a: any, b: any) => (order.get(a.title) ?? 99) - (order.get(b.title) ?? 99)).map(found).filter(Boolean) as Found[];
    }
  } catch { toast('Wikipedia nie odpowiada – spróbuj za chwilę.', true); }
  $('#c-res').innerHTML = results.map((r, i) => `<figure><button type="button" data-pick="${i}" title="${esc(r.credit)}"><img src="${esc(r.thumb)}" alt="" loading="lazy"></button></figure>`).join('');
  $('#c-res-n').textContent = results.length
    ? 'Kliknij zdjęcie, aby ustawić je jako główne (sprawdź, czy to ta osoba). Podpis uzupełni się sam.'
    : 'Brak zdjęć na wolnej licencji. Otwórz Google Grafika, kliknij zdjęcie prawym → „Kopiuj obraz”, wróć tu i naciśnij ⌘V.';
  $$('#c-res [data-pick]').forEach((b) => b.addEventListener('click', async () => {
    const r = results[+b.dataset.pick!];
    try {
      const blob = await (await fetch(r.url)).blob();
      await setCover(blob, 'wikimedia', r.credit);
    } catch { toast('Nie udało się pobrać zdjęcia.', true); }
  }));
  btn.disabled = false; btn.textContent = 'Wikipedia';
});
$('#gal-in').addEventListener('change', async (e) => {
  const files = [...((e.target as HTMLInputElement).files || [])];
  busy('#gal-in', true);
  for (const [i, file] of files.entries()) {
    $('#gal-n').textContent = `Przetwarzam ${i + 1} z ${files.length}…`;
    try { current.gallery.push(await uploadPhoto(file, slugBase(), `${F('title').value} – zdjęcie`, GALLERY_W)); renderGallery(); }
    catch (err: any) { toast(err.message, true); break; }
  }
  busy('#gal-in', false);
  renderGallery();
  if (files.length) toast(`Dodano zdjęcia: ${files.length}`);
});

// pasek formatowania
$$('.rte-bar [data-cmd]').forEach((b) => b.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const c = b.dataset.cmd!;
  $('#rte').focus();
  if (c === 'bold' || c === 'italic') document.execCommand(c);
  else if (c === 'h2') document.execCommand('formatBlock', false, 'h2');
  else if (c === 'p') document.execCommand('formatBlock', false, 'p');
  else if (c === 'quote') document.execCommand('formatBlock', false, 'blockquote');
  else if (c === 'ul') document.execCommand('insertUnorderedList');
  else if (c === 'ol') document.execCommand('insertOrderedList');
  else if (c === 'link') { const u = prompt('Adres linku (https://…)'); if (u) document.execCommand('createLink', false, u); }
  else if (c === 'clear') document.execCommand('removeFormat');
}));
document.execCommand('defaultParagraphSeparator', false, 'p');
$('#rte').addEventListener('paste', (e: ClipboardEvent) => {
  e.preventDefault();
  const html = e.clipboardData?.getData('text/html');
  const text = e.clipboardData?.getData('text/plain') || '';
  const clean = html ? cleanHtml(html) : text.split(/\n{2,}|\r\n\r\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
  document.execCommand('insertHTML', false, clean);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = F('title').value.trim();
  const slug = F('slug').value.trim();
  if (!title) return toast('Wpisz tytuł artykułu.', true);
  if (!/^[a-z0-9-]+$/.test(slug)) return toast('Adres może zawierać tylko małe litery, cyfry i myślniki.', true);
  const id = current.id || slug;
  if (!current.id && (await getDoc(doc(db, 'articles', id))).exists()) return toast('Artykuł o takim adresie już istnieje – zmień adres.', true);
  const lead = F('lead').value.trim();
  if (current.cover) current.cover.alt = F('coverAlt').value || title;
  const data = {
    slug: id, title, lead,
    body: cleanHtml($('#rte').innerHTML),
    category: F('category').value,
    status: F('status').value,
    featured: F('featured').checked,
    publishedAt: Timestamp.fromDate(new Date(F('publishedAt').value)),
    author: F('author').value.trim() || 'Redakcja',
    photoCredit: F('photoCredit').value.trim() || null,
    source: F('sourceName').value.trim() ? { name: F('sourceName').value.trim(), url: F('sourceUrl').value.trim() } : null,
    cover: current.cover,
    imageSource: current.imageSource,
    ...(current.data.coverCandidate && current.cover?.srcset?.[0]?.url === current.data.coverCandidate.image?.srcset?.[0]?.url ? { coverCandidate: null } : {}),
    needsPhoto: !!current.data.needsPhoto && current.imageSource === 'plansza',
    gallery: current.gallery,
    keywords: keywordsFor(title, lead),
    updatedAt: serverTimestamp(),
  };
  const btn = $('#e-save') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = 'Zapisuję…';
  try {
    await setDoc(doc(db, 'articles', id), data, { merge: true });
    if (data.featured) {
      const others = await getDocs(query(collection(db, 'articles'), where('featured', '==', true)));
      await Promise.all(others.docs.filter((d) => d.id !== id).map((d) => updateDoc(d.ref, { featured: false, updatedAt: serverTimestamp() })));
    }
    await markDirty();
    current.id = id;
    current.data = { ...current.data, ...data };
    F('slug').readOnly = true;
    $('#e-del').hidden = false;
    $('#e-h').textContent = 'Edycja artykułu';
    updateView();
    buildStatus();
    toast('Zapisano. Automat opublikuje zmianę w ciągu ok. 30 minut.');
  } catch (err: any) { toast(err.message, true); }
  btn.disabled = false; btn.textContent = 'Zapisz';
});
$('#e-del').addEventListener('click', async () => {
  if (!current.id || !(await confirmBox('Usunąć artykuł?', 'Artykuł zniknie ze strony po najbliższej publikacji.'))) return;
  await updateDoc(doc(db, 'articles', current.id), { status: 'deleted', featured: false, updatedAt: serverTimestamp() });
  await markDirty();
  toast('Artykuł usunięty');
  show('articles');
});

// ---------------- banery ----------------
let adRows: { id: string; d: any }[] = [];
let adCur: { id: string | null; desktop: Variant | null; mobile: Variant | null } = { id: null, desktop: null, mobile: null };
const af = $('#ad-form') as HTMLFormElement;
const A = (n: string) => af.elements.namedItem(n) as HTMLInputElement;
const dstr = (d: Date | null) => (d ? localInput(d).slice(0, 10) : '');

async function loadAds() {
  const snap = await getDocs(query(collection(db, 'ads'), orderBy('slot')));
  adRows = snap.docs.map((d) => ({ id: d.id, d: d.data() }));
  $('#ad-list').innerHTML = adRows.map((r) => {
    const s = (SLOTS as any)[r.d.slot];
    const img = r.d.desktop?.url || r.d.mobile?.url;
    const end = toDate(r.d.end);
    const expired = end && +end < Date.now();
    return `<button class="adcard" data-id="${esc(r.id)}" type="button">
      <span class="adcard-img" style="${img ? `background-image:url('${esc(src(img))}')` : ''}"></span>
      <span class="adcard-b"><strong>${esc(r.d.client || 'Bez nazwy')}</strong>
        <small>${esc(s?.name || r.d.slot)} · ${s ? s.desktop.join('×') : ''}</small>
        <small>${dstr(toDate(r.d.start)) || 'od zaraz'} → ${dstr(end) || 'bez końca'}</small>
        <span>${expired ? '<span class="pill">Zakończony</span>' : r.d.active ? '<span class="pill on">Aktywny</span>' : '<span class="pill off">Wstrzymany</span>'}</span></span>
    </button>`;
  }).join('') || '<div class="card"><p class="empty-s">Nie ma jeszcze banerów. Dodaj pierwszy – pojawi się w wybranym miejscu na stronie.</p></div>';
  $$('#ad-list [data-id]').forEach((b) => b.addEventListener('click', () => openAd(b.dataset.id!)));
}
function slotDims() {
  const s = SLOTS[A('slot').value as SlotKey];
  $('#dim-d').textContent = `Grafika – komputer (${s.desktop.join('×')} px)`;
  $('#ad-m-wrap').hidden = !s.mobile;
  if (s.mobile) $('#dim-m').textContent = `Grafika – telefon (${s.mobile.join('×')} px)`;
}
function renderAdPrev() {
  $('#ad-d').innerHTML = adCur.desktop ? `<img src="${esc(src(adCur.desktop.url))}" alt="">` : 'brak grafiki';
  $('#ad-m').innerHTML = adCur.mobile ? `<img src="${esc(src(adCur.mobile.url))}" alt="">` : 'brak grafiki';
}
function drawer(open: boolean) { $('#ad-drawer').hidden = !open; $('#ad-scrim').hidden = !open; }
function openAd(id: string | null) {
  af.reset();
  const d = adRows.find((x) => x.id === id)?.d || {};
  adCur = { id, desktop: d.desktop || null, mobile: d.mobile || null };
  $('#ad-h').textContent = id ? `Baner: ${d.client}` : 'Nowy baner';
  if (id) {
    A('slot').value = d.slot; A('client').value = d.client || ''; A('link').value = d.link || ''; A('alt').value = d.alt || '';
    A('start').value = dstr(toDate(d.start)); A('end').value = dstr(toDate(d.end)); A('weight').value = d.weight || 1; A('active').checked = !!d.active;
  }
  $('#ad-del').hidden = !id;
  slotDims(); renderAdPrev(); drawer(true);
}
A('slot').addEventListener('change', slotDims);
$('#ad-new').addEventListener('click', () => openAd(null));
$('#ad-cancel').addEventListener('click', () => drawer(false));
$('#ad-scrim').addEventListener('click', () => drawer(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape') drawer(false); });

async function uploadBanner(file: File, need: readonly [number, number]): Promise<Variant> {
  const bmp = await createImageBitmap(file);
  const [w, h] = need;
  const ok = (bmp.width === w && bmp.height === h) || (bmp.width === w * 2 && bmp.height === h * 2);
  if (!ok) throw new Error(`Zły wymiar: ${bmp.width}×${bmp.height} px. Wymagane ${w}×${h} px (albo ${w * 2}×${h * 2} px).`);
  const stamp = Date.now().toString(36);
  let blob: Blob = file, ext = 'gif', type = 'image/gif';
  if (file.type !== 'image/gif') { blob = (await toWebp(file, bmp.width, 0.86)).blob; ext = 'webp'; type = 'image/webp'; }
  return { w, h, url: await stage(`ads/${stamp}-${w}x${h}.${ext}`, blob, type) };
}
for (const which of ['d', 'm'] as const) {
  $(`#ad-${which}-in`).addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const s = SLOTS[A('slot').value as SlotKey];
    const need = which === 'd' ? s.desktop : s.mobile;
    if (!need) return;
    busy(`#ad-${which}-in`, true);
    try {
      const v = await uploadBanner(file, need);
      if (which === 'd') adCur.desktop = v; else adCur.mobile = v;
      renderAdPrev(); toast('Grafika gotowa');
    } catch (err: any) { toast(err.message, true); }
    busy(`#ad-${which}-in`, false);
  });
}
af.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = SLOTS[A('slot').value as SlotKey];
  if (!A('client').value.trim() || !/^https?:\/\//.test(A('link').value)) return toast('Podaj klienta i adres docelowy (https://…).', true);
  if (!adCur.desktop && !adCur.mobile) return toast('Dodaj co najmniej jedną grafikę.', true);
  const data = {
    slot: A('slot').value,
    client: A('client').value.trim(),
    link: A('link').value.trim(),
    alt: A('alt').value.trim() || A('client').value.trim(),
    start: A('start').value ? Timestamp.fromDate(new Date(A('start').value + 'T00:00:00')) : null,
    end: A('end').value ? Timestamp.fromDate(new Date(A('end').value + 'T23:59:59')) : null,
    weight: Math.max(1, Number(A('weight').value) || 1),
    active: A('active').checked,
    desktop: adCur.desktop,
    mobile: s.mobile ? adCur.mobile : null,
    updatedAt: serverTimestamp(),
  };
  try {
    const id = adCur.id || doc(collection(db, 'ads')).id;
    await setDoc(doc(db, 'ads', id), data, { merge: true });
    await markDirty();
    drawer(false);
    toast('Baner zapisany. Pojawi się na stronie w ciągu ok. 30 minut.');
    loadAds(); buildStatus();
  } catch (err: any) { toast(err.message, true); }
});
$('#ad-del').addEventListener('click', async () => {
  if (!adCur.id || !(await confirmBox('Usunąć baner?', 'Baner zniknie ze strony po najbliższej publikacji.'))) return;
  await deleteDoc(doc(db, 'ads', adCur.id));
  await markDirty();
  drawer(false);
  toast('Baner usunięty');
  loadAds();
});

// ---------------- redaktor AI ----------------
const IMG_SRC: Record<string, string> = { bank: 'bank zdjęć redakcji', wikimedia: 'Wikimedia Commons', ai: 'ilustracja AI', plansza: 'plansza z tytułem', zrodlo: 'zdjęcie z artykułu źródłowego', wlasne: 'wgrane przez redakcję' };
async function redCount() {
  const snap = await getDocs(query(collection(db, 'articles'), where('origin', '==', 'redaktor'), where('status', '==', 'draft')));
  $('#red-n').textContent = String(snap.size);
  $('#red-n').hidden = !snap.size;
  return snap;
}
async function loadRedaktor() {
  const [drafts, runs, cfg, photos] = await Promise.all([
    redCount(),
    getDocs(query(collection(db, 'redaktor_runs'), orderBy('at', 'desc'), limit(20))),
    getDoc(doc(db, 'config', 'redaktor')),
    getDocs(collection(db, 'photos')),
  ]);
  ($('#red-ai') as HTMLInputElement).checked = !!cfg.data()?.aiImages;
  const list = drafts.docs.map((d) => ({ id: d.id, d: d.data() as any })).sort((a, b) => +(toDate(b.d.publishedAt) || 0) - +(toDate(a.d.publishedAt) || 0));
  $('#red-count').textContent = list.length ? `${list.length} do przejrzenia` : '';
  $('#red-list').innerHTML = list.map(({ id, d }) => {
    const img = d.cover?.srcset?.[Math.min(1, (d.cover?.srcset?.length || 1) - 1)]?.url;
    return `<div class="rcard" data-rid="${esc(id)}">
      <span class="rcard-img" style="${img ? `background-image:url('${esc(src(img))}')` : ''}"></span>
      <div class="rcard-b">
        <span class="rcard-m">${tagHtml(d.category)}<span>${fmt(toDate(d.publishedAt))}</span><span>· na podstawie <a href="${esc(d.basedOn?.url)}" target="_blank" rel="noopener">${esc(d.basedOn?.name)}</a></span><span>· zdjęcie: ${esc(IMG_SRC[d.imageSource] || '—')}</span>${d.needsPhoto ? `<span class="pill off" title="Artykuł o osobie – wklej jej prawdziwe zdjęcie">brak zdjęcia osoby</span>` : ''}${d.copyRisk ? `<span class="pill off" title="Tyle zwrotów pokrywa się ze źródłem – przeredaguj przed publikacją">podobny do źródła ${d.copyRisk}%</span>` : ''}</span>
        <span class="rcard-t">${esc(d.title)}</span>
        <span class="rcard-l">${esc(d.lead)}</span>
        <span class="rcard-a">
          <button class="btn ghost" data-act="open" type="button">Edytuj</button>
          <button class="btn red" data-act="pub" type="button">Opublikuj</button>
          <button class="btn ghost danger" data-act="rej" type="button">Odrzuć</button>
        </span>
      </div>
    </div>`;
  }).join('');
  $$('#red-list [data-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest<HTMLElement>('[data-rid]')!.dataset.rid!;
    const act = b.dataset.act;
    if (act === 'open') return openEditor(id);
    try {
      if (act === 'pub') {
        await updateDoc(doc(db, 'articles', id), { status: 'published', publishedAt: Timestamp.now(), updatedAt: serverTimestamp() });
        toast('Opublikowano – pojawi się na stronie w ciągu ok. 30 minut.');
      } else {
        if (!(await confirmBox('Odrzucić szkic?', 'Szkic zniknie z listy, a redaktor nie wróci do tego tematu.', 'Odrzuć'))) return;
        await updateDoc(doc(db, 'articles', id), { status: 'deleted', updatedAt: serverTimestamp() });
        toast('Szkic odrzucony');
      }
      await markDirty();
      loadRedaktor();
      buildStatus();
    } catch (err: any) { toast(err.message, true); }
  }));
  $('#red-hist').innerHTML = runs.docs.map((r) => {
    const x = r.data();
    const err = (x.errors || []).length;
    const sk = (x.skipped || []).length;
    return `<tr><td>${fmt(toDate(x.at))}${x.trigger === 'manual' ? ' · ręcznie' : ''}</td><td>${x.checked ?? 0}</td><td><strong>${(x.drafts || []).length}</strong></td><td>${sk ? `<span title="${esc((x.skipped || []).join('\n'))}">${sk}</span>` : '0'}</td><td>${x.duplicates ?? 0}</td><td>${err ? `<span class="pill off" title="${esc((x.errors || []).join('; '))}">${err}</span>` : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="6">Redaktor jeszcze nie pracował.</td></tr>';
  const last = runs.docs[0]?.data();
  $('#red-last').textContent = last
    ? `Ostatnie uruchomienie: ${fmt(toDate(last.at))} – nowe szkice: ${(last.drafts || []).length}${(last.errors || []).length ? `, problem: ${(last.errors || [])[0]}` : ''}`
    : 'Redaktor jeszcze nie pracował.';
  renderBank(photos.docs.map((p) => ({ id: p.id, ...(p.data() as any) })));
}
function renderBank(items: any[]) {
  $('#bank-n').textContent = items.length ? `${items.length} zdj.` : '';
  $('#bank').innerHTML = items.map((p) => `<figure><img src="${esc(src(p.image?.srcset?.[1]?.url || p.image?.srcset?.[0]?.url || ''))}" alt="" loading="lazy"><figcaption>${esc((p.tags || []).join(', '))}${p.credit ? `<br><small>Fot. ${esc(p.credit)}</small>` : ''}</figcaption><button type="button" data-pid="${esc(p.id)}" aria-label="Usuń zdjęcie">×</button></figure>`).join('');
  $$('#bank [data-pid]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmBox('Usunąć zdjęcie z banku?', 'Artykuły, które już go używają, zachowają zdjęcie.'))) return;
    await deleteDoc(doc(db, 'photos', b.dataset.pid!));
    loadRedaktor();
  }));
}
$('#bank-in').addEventListener('change', async (e) => {
  const files = [...((e.target as HTMLInputElement).files || [])];
  const tags = ($('#bank-tags') as HTMLInputElement).value.split(',').map((t) => t.trim()).filter(Boolean);
  if (!files.length) return;
  if (!tags.length) { toast('Najpierw wpisz słowa kluczowe – po nich redaktor dobiera zdjęcia.', true); (e.target as HTMLInputElement).value = ''; return; }
  busy('#bank-in', true);
  let ok = 0;
  for (const [i, file] of files.entries()) {
    $('#bank-n').textContent = `Przetwarzam ${i + 1} z ${files.length}…`;
    try {
      const image = await uploadPhoto(file, 'bank', tags.join(', '), COVER_W);
      await setDoc(doc(collection(db, 'photos')), { tags, credit: ($('#bank-credit') as HTMLInputElement).value.trim() || null, image, createdAt: serverTimestamp() });
      ok++;
    } catch (err: any) { toast(err.message, true); break; }
  }
  busy('#bank-in', false);
  (e.target as HTMLInputElement).value = '';
  if (ok) { await markDirty(); toast(`Dodano do banku: ${ok}`); }
  loadRedaktor();
});
$('#red-ai').addEventListener('change', async (e) => {
  try {
    await setDoc(doc(db, 'config', 'redaktor'), { aiImages: (e.target as HTMLInputElement).checked }, { merge: true });
    toast((e.target as HTMLInputElement).checked ? 'Ilustracje AI włączone' : 'Ilustracje AI wyłączone');
  } catch (err: any) { toast(err.message, true); }
});
$('#red-run').addEventListener('click', async () => {
  try {
    await markDirty({ redaktorRequested: true });
    toast('Zlecono pracę redaktora – szkice pojawią się tu w ciągu ok. 30–40 minut.');
    buildStatus();
  } catch (err: any) { toast(err.message, true); }
});

// ---------------- import ----------------
async function loadImports() {
  const snap = await getDocs(query(collection(db, 'imports'), orderBy('at', 'desc'), limit(30)));
  $('#imp-list').innerHTML = snap.docs.map((d) => {
    const x = d.data();
    const err = (x.errors || []).length;
    return `<tr><td>${fmt(toDate(x.at))}</td><td>${x.trigger === 'manual' ? 'Ręcznie' : 'Automatycznie (15:00)'}</td><td>${x.checked ?? 0}</td><td><strong>${(x.imported || []).length}</strong></td><td>${err ? `<span class="pill off" title="${esc((x.errors || []).join('; '))}">${err}</span>` : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="5">Jeszcze nie było importu.</td></tr>';
}
async function runImport() {
  try {
    await markDirty({ importRequested: true });
    toast('Zlecono import – automat pobierze nowości przy najbliższym sprawdzeniu (do 30 min).');
    buildStatus();
  } catch (err: any) { toast(err.message, true); }
}
$('#imp-run').addEventListener('click', runImport);

// ---------------- ustawienia ----------------
const sf = $('#s-form') as HTMLFormElement;
const S = (n: string) => sf.elements.namedItem(n) as HTMLInputElement;
async function loadSettings() {
  const [site, admins] = await Promise.all([getDoc(doc(db, 'config', 'site')), getDoc(doc(db, 'config', 'admins'))]);
  const s = site.data() || {};
  S('adsenseEnabled').checked = !!s.adsenseEnabled;
  S('adsenseClient').value = s.adsenseClient || '';
  for (const k of Object.keys(SLOTS)) S(`slot_${k}`).value = s.adsenseSlots?.[k] || '';
  S('adsTxt').value = s.adsTxt || '';
  S('analyticsId').value = s.analyticsId || '';
  S('admins').value = (admins.data()?.emails || []).join('\n');
  const gh = (await getDoc(doc(db, 'config', 'github'))).data();
  S('ghToken').value = '';
  S('ghToken').placeholder = gh?.token ? 'Token zapisany ✓ – wklej nowy, aby zmienić' : 'github_pat_…';
  $('#gh-del').hidden = !gh?.token;
}
$('#gh-del').addEventListener('click', async () => {
  if (!(await confirmBox('Usunąć token?', 'Publikacja wróci do harmonogramu GitHuba (może się opóźniać).'))) return;
  await setDoc(doc(db, 'config', 'github'), { token: null });
  toast('Token usunięty');
  loadSettings();
});
sf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const emails = S('admins').value.split(/\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const me = auth.currentUser?.email?.toLowerCase();
  if (me && !emails.includes(me)) return toast('Nie możesz usunąć własnego adresu z listy dostępu.', true);
  const client = S('adsenseClient').value.trim();
  if (client && !/^ca-pub-\d+$/.test(client)) return toast('Identyfikator wydawcy ma postać ca-pub-1234567890.', true);
  const adsenseSlots: Record<string, string> = {};
  for (const k of Object.keys(SLOTS)) { const v = S(`slot_${k}`).value.trim(); if (v) adsenseSlots[k] = v; }
  try {
    await Promise.all([
      setDoc(doc(db, 'config', 'site'), { adsenseEnabled: S('adsenseEnabled').checked, adsenseClient: client, adsenseSlots, adsTxt: S('adsTxt').value.trim(), analyticsId: S('analyticsId').value.trim() }),
      setDoc(doc(db, 'config', 'admins'), { emails }),
      ...(S('ghToken').value.trim() ? [setDoc(doc(db, 'config', 'github'), { token: S('ghToken').value.trim() })] : []),
    ]);
    await markDirty();
    toast('Ustawienia zapisane – zadziałają po najbliższej publikacji.');
    loadSettings();
    buildStatus();
  } catch (err: any) { toast(err.message, true); }
});

// panel jako aplikacja (PWA) – instalowalny na telefonie redaktora; sam panel zawsze ładuje się z sieci
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
