// Panel redakcji Częstokocham – logowanie Google, pulpit, artykuły, banery, import, ustawienia
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
const TITLES: Record<string, string> = { dashboard: 'Pulpit', articles: 'Artykuły', editor: 'Artykuł', ads: 'Banery', import: 'Import', settings: 'Ustawienia' };
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
  if (v === 'import') loadImports();
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
  } catch {
    $('#app').hidden = true;
    $('#v-login').hidden = false;
    $('#login-err').textContent = `Konto ${u.email} nie ma dostępu do panelu. Poproś administratora o dopisanie adresu w Ustawieniach.`;
    $('#login-err').hidden = false;
    signOut(auth);
  }
});

// ---------------- status publikacji ----------------
const markDirty = (extra: Record<string, unknown> = {}) =>
  setDoc(doc(db, 'config', 'build'), { dirty: true, dirtyAt: serverTimestamp(), ...extra }, { merge: true });
async function buildStatus() {
  const b = (await getDoc(doc(db, 'config', 'build'))).data() || {};
  const last = toDate(b.lastBuild);
  const wait = b.dirty || b.importRequested;
  const el = $('#pub');
  el.classList.toggle('wait', !!wait);
  el.classList.toggle('ok', !wait);
  el.querySelector('.pub-t')!.textContent = wait ? 'Zmiany czekają na publikację (do 30 min)' : `Strona aktualna${last ? ` · ${fmt(last)}` : ''}`;
  return b;
}

// ---------------- obrazy → WebP ----------------
async function toWebp(file: Blob, width: number, quality = 0.78): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const w = Math.min(width, bmp.width);
  const h = Math.round((bmp.height * w) / bmp.width);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
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
async function uploadPhoto(file: File, base: string, alt: string, widths: number[]): Promise<Img> {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const srcset: Variant[] = [];
  const bmp = await createImageBitmap(file);
  for (const width of [...new Set(widths.map((w) => Math.min(w, bmp.width)))]) {
    const { blob, w, h } = await toWebp(file, width, width > 1000 ? 0.72 : 0.78);
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
  const status = d.status === 'published' ? '<span class="pill on">Opublikowany</span>' : '<span class="pill off">Szkic</span>';
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
let current: { id: string | null; cover: Img | null; gallery: Img[]; data: any } = { id: null, cover: null, gallery: [], data: {} };
const form = $('#e-form') as HTMLFormElement;
const F = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const grow = () => { const t = F('title'); t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };

async function openEditor(id: string | null) {
  form.reset();
  current = { id, cover: null, gallery: [], data: {} };
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
  current.cover = d.cover || null;
  current.gallery = d.gallery || [];
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
$('#e-back').addEventListener('click', () => show('articles'));

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
$('#cover-in').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  busy('#cover-in', true);
  try { current.cover = await uploadPhoto(file, slugBase(), F('coverAlt').value || F('title').value, COVER_W); renderCover(); toast('Zdjęcie główne dodane'); }
  catch (err: any) { toast(err.message, true); }
  busy('#cover-in', false);
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
}
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
    ]);
    await markDirty();
    toast('Ustawienia zapisane – zadziałają po najbliższej publikacji.');
    buildStatus();
  } catch (err: any) { toast(err.message, true); }
});
