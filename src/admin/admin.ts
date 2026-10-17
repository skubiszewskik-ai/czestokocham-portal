// Panel redakcji Częstokocham – logowanie Google, artykuły, banery, import, ustawienia
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
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (d?: Date | null) => (d ? d.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const toDate = (v: any): Date | null => (v ? (v.toDate ? v.toDate() : new Date(v)) : null);
const msg = (sel: string, text: string, err = false) => { const el = $(sel); el.textContent = text; el.classList.toggle('err', err); };

type Variant = { w: number; h: number; url: string };
type Img = { srcset: Variant[]; w: number; h: number; alt: string };

// ---------------- widoki ----------------
const views = ['login', 'articles', 'editor', 'ads', 'import', 'settings'];
function show(v: string) {
  views.forEach((x) => ($(`#v-${x}`).hidden = x !== v));
  $$('.adm-tabs button').forEach((b) => b.toggleAttribute('aria-current', b.dataset.tab === v || (v === 'editor' && b.dataset.tab === 'articles')));
  buildStatus().catch(() => {});
  if (v === 'articles') loadArticles(true);
  if (v === 'ads') loadAds();
  if (v === 'import') loadImports();
  if (v === 'settings') loadSettings();
}
$$('.adm-tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab!)));

// ---------------- logowanie ----------------
$('#login').addEventListener('click', async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e: any) { msg('#login-err', e.message, true); $('#login-err').hidden = false; }
});
$('#logout').addEventListener('click', () => signOut(auth));
onAuthStateChanged(auth, async (u: User | null) => {
  $('#who').textContent = u?.email || '';
  $('#logout').hidden = !u;
  if (!u) { $('.adm-tabs').hidden = true; show('login'); return; }
  try {
    await getDoc(doc(db, 'config', 'admins')); // reguły wpuszczą tylko administratorów
    $('.adm-tabs').hidden = false;
    show('articles');
  } catch {
    $('.adm-tabs').hidden = true;
    show('login');
    msg('#login-err', `Konto ${u.email} nie ma dostępu do panelu. Poproś administratora o dopisanie adresu w Ustawieniach.`, true);
    $('#login-err').hidden = false;
  }
});

// ---------------- obrazy → WebP ----------------
async function toWebp(file: File, width: number, quality = 0.78): Promise<{ blob: Blob; w: number; h: number }> {
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
// Plan Spark nie ma Storage: plik czeka w kolekcji „uploads” (base64), a automat publikacji zapisuje go
// w public/media i wdraża razem ze stroną. Do tego czasu panel pokazuje podgląd z pamięci przeglądarki.
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
// każda zmiana zaznacza, że stronę trzeba opublikować ponownie
const markDirty = (extra: Record<string, unknown> = {}) =>
  setDoc(doc(db, 'config', 'build'), { dirty: true, dirtyAt: serverTimestamp(), ...extra }, { merge: true });
async function buildStatus() {
  const b = (await getDoc(doc(db, 'config', 'build'))).data() || {};
  const last = toDate(b.lastBuild);
  $('#pub').textContent = b.dirty || b.importRequested
    ? `Zmiany czekają na publikację (automat sprawdza co 30 minut)${last ? ` · ostatnia publikacja ${fmt(last)}` : ''}`
    : `Strona aktualna${last ? ` · ostatnia publikacja ${fmt(last)}` : ''}`;
}

// ---------------- czyszczenie HTML z edytora ----------------
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
  // luźny tekst i <div> → akapity
  let out = root.innerHTML.replace(/<b>/g, '<strong>').replace(/<\/b>/g, '</strong>').replace(/<i>/g, '<em>').replace(/<\/i>/g, '</em>');
  if (!/^\s*<(p|h2|h3|ul|ol|blockquote)/.test(out) && out.trim()) out = `<p>${out}</p>`;
  return out.replace(/<p>\s*(<br>)?\s*<\/p>/g, '').trim();
}
const normalizeWord = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const keywordsFor = (...parts: string[]) =>
  [...new Set(normalizeWord(parts.join(' ')).split(/[^a-z0-9]+/).filter((w) => w.length > 2))].slice(0, 80);
const slugify = (s: string) =>
  normalizeWord(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);

// ---------------- lista artykułów ----------------
let lastDoc: QueryDocumentSnapshot | null = null;
let rows: { id: string; d: any }[] = [];
async function loadArticles(reset = false) {
  if (reset) { lastDoc = null; rows = []; }
  const cat = ($('#a-cat') as HTMLSelectElement).value;
  const parts: any[] = [collection(db, 'articles')];
  if (cat) parts.push(where('category', '==', cat));
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
  $('#a-list').innerHTML = rows
    .filter((r) => r.d.status !== 'deleted' && (!q || normalizeWord(r.d.title || '').includes(q)))
    .map((r) => `<tr data-id="${esc(r.id)}"><td>${esc(r.d.title || '(bez tytułu)')}${r.d.featured ? ' <span class="pill on">wyróżniony</span>' : ''}</td><td>${esc((CATEGORIES as any)[r.d.category]?.name || '')}</td><td><span class="pill ${r.d.status === 'published' ? 'on' : 'off'}">${r.d.status === 'published' ? 'opublikowany' : 'szkic'}</span></td><td>${fmt(toDate(r.d.publishedAt))}</td><td>${esc(r.d.source?.name || 'redakcja')}</td></tr>`)
    .join('') || '<tr><td colspan="5">Brak artykułów.</td></tr>';
  $$('#a-list tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openEditor(tr.dataset.id!)));
}
$('#a-q').addEventListener('input', renderArticles);
$('#a-cat').addEventListener('change', () => loadArticles(true));
$('#a-more').addEventListener('click', () => loadArticles());
$('#a-new').addEventListener('click', () => openEditor(null));

// ---------------- edytor ----------------
let current: { id: string | null; cover: Img | null; gallery: Img[]; data: any } = { id: null, cover: null, gallery: [], data: {} };
const form = $('#e-form') as HTMLFormElement;
const F = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

async function openEditor(id: string | null) {
  form.reset();
  msg('#e-msg', '');
  current = { id, cover: null, gallery: [], data: {} };
  if (id) {
    const snap = await getDoc(doc(db, 'articles', id));
    current.data = snap.data() || {};
  }
  const d = current.data;
  $('#e-h').textContent = id ? 'Edycja artykułu' : 'Nowy artykuł';
  F('title').value = d.title || '';
  F('slug').value = d.slug || id || '';
  F('slug').readOnly = !!id;
  F('lead').value = d.lead || '';
  F('category').value = d.category || 'miasto';
  F('status').value = d.status || 'published';
  F('publishedAt').value = localInput(toDate(d.publishedAt) || new Date());
  F('featured').checked = !!d.featured;
  F('author').value = d.author || 'Redakcja';
  F('photoCredit').value = d.photoCredit || '';
  F('sourceName').value = d.source?.name || '';
  F('sourceUrl').value = d.source?.url || '';
  F('coverAlt').value = d.cover?.alt || '';
  $('#rte').innerHTML = d.body || '<p></p>';
  current.cover = d.cover || null;
  current.gallery = d.gallery || [];
  renderCover(); renderGallery();
  $('#e-del').hidden = !id;
  const view = $('#e-view') as HTMLAnchorElement;
  view.hidden = !id || d.status !== 'published';
  if (id) view.href = `/${d.category}/${id}`;
  show('editor');
}
F('title').addEventListener('input', () => { if (!current.id) F('slug').value = slugify(F('title').value); });
$('#e-back').addEventListener('click', () => show('articles'));

function renderCover() {
  const c = current.cover;
  $('#cover').innerHTML = c ? `<img src="${esc(src(c.srcset[0].url))}" alt="">` : '';
}
function renderGallery() {
  $('#gal').innerHTML = current.gallery.map((g, i) => `<figure><img src="${esc(src(g.srcset[0].url))}" alt=""><button type="button" data-rm="${i}">Usuń</button></figure>`).join('');
  $$('#gal [data-rm]').forEach((b) => b.addEventListener('click', () => { current.gallery.splice(+b.dataset.rm!, 1); renderGallery(); }));
}
const slugOrTmp = () => `u/${F('slug').value || 'nowy'}`;
$('#cover-in').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  msg('#e-msg', 'Przetwarzam zdjęcie…');
  try { current.cover = await uploadPhoto(file, slugOrTmp(), F('coverAlt').value || F('title').value, COVER_W); renderCover(); msg('#e-msg', 'Zdjęcie dodane.'); }
  catch (err: any) { msg('#e-msg', err.message, true); }
});
$('#gal-in').addEventListener('change', async (e) => {
  const files = [...((e.target as HTMLInputElement).files || [])];
  for (const [i, file] of files.entries()) {
    msg('#e-msg', `Przetwarzam zdjęcie ${i + 1} z ${files.length}…`);
    try { current.gallery.push(await uploadPhoto(file, slugOrTmp(), `${F('title').value} – zdjęcie`, GALLERY_W)); renderGallery(); }
    catch (err: any) { msg('#e-msg', err.message, true); return; }
  }
  msg('#e-msg', 'Galeria zaktualizowana.');
});

// pasek formatowania
$$('.rte-bar [data-cmd]').forEach((b) => b.addEventListener('click', () => {
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
// wklejanie: zachowaj tylko akapity
$('#rte').addEventListener('paste', (e: ClipboardEvent) => {
  e.preventDefault();
  const html = e.clipboardData?.getData('text/html');
  const text = e.clipboardData?.getData('text/plain') || '';
  const clean = html ? cleanHtml(html) : text.split(/\n{2,}|\r\n\r\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
  document.execCommand('insertHTML', false, clean);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const slug = F('slug').value.trim();
  if (!/^[a-z0-9-]+$/.test(slug)) return msg('#e-msg', 'Adres może zawierać tylko małe litery, cyfry i myślniki.', true);
  const id = current.id || slug;
  if (!current.id) {
    const exists = await getDoc(doc(db, 'articles', id));
    if (exists.exists()) return msg('#e-msg', 'Artykuł o takim adresie już istnieje – zmień adres.', true);
  }
  const title = F('title').value.trim();
  const lead = F('lead').value.trim();
  if (current.cover) current.cover.alt = F('coverAlt').value || title;
  const data = {
    slug: id,
    title,
    lead,
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
  try {
    await setDoc(doc(db, 'articles', id), data, { merge: true });
    await markDirty();
    // tylko jeden artykuł wyróżniony naraz
    if (data.featured) {
      const others = await getDocs(query(collection(db, 'articles'), where('featured', '==', true)));
      await Promise.all(others.docs.filter((d) => d.id !== id).map((d) => updateDoc(d.ref, { featured: false, updatedAt: serverTimestamp() })));
    }
    current.id = id;
    F('slug').readOnly = true;
    $('#e-del').hidden = false;
    const view = $('#e-view') as HTMLAnchorElement;
    view.href = `/${data.category}/${id}`;
    view.hidden = data.status !== 'published';
    msg('#e-msg', 'Zapisano. Automat opublikuje zmianę w ciągu ok. 30 minut.');
    buildStatus();
  } catch (err: any) { msg('#e-msg', err.message, true); }
});
$('#e-del').addEventListener('click', async () => {
  if (!current.id || !confirm('Na pewno usunąć ten artykuł? Tej operacji nie można cofnąć.')) return;
  // oznaczamy jako usunięty, żeby automat publikacji zdjął go ze strony
  await updateDoc(doc(db, 'articles', current.id), { status: 'deleted', featured: false, updatedAt: serverTimestamp() });
  await markDirty();
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
    return `<tr data-id="${esc(r.id)}"><td>${esc(r.d.client || '')}</td><td>${esc(s?.name || r.d.slot)}</td><td>${dstr(toDate(r.d.start)) || 'od zawsze'} – ${dstr(toDate(r.d.end)) || 'bez końca'}</td><td><span class="pill ${r.d.active ? 'on' : 'off'}">${r.d.active ? 'tak' : 'nie'}</span></td></tr>`;
  }).join('') || '<tr><td colspan="5">Brak banerów.</td></tr>';
  $$('#ad-list tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openAd(tr.dataset.id!)));
}
function slotDims() {
  const s = SLOTS[A('slot').value as SlotKey];
  $('#dim-d').textContent = `Grafika – komputer (${s.desktop.join('×')} px)`;
  $('#ad-m-wrap').hidden = !s.mobile;
  if (s.mobile) $('#dim-m').textContent = `Grafika – telefon (${s.mobile.join('×')} px)`;
}
function renderAdPrev() {
  $('#ad-d').innerHTML = adCur.desktop ? `<img src="${esc(src(adCur.desktop.url))}" alt="">` : 'brak';
  $('#ad-m').innerHTML = adCur.mobile ? `<img src="${esc(src(adCur.mobile.url))}" alt="">` : 'brak';
}
function openAd(id: string | null) {
  af.reset();
  msg('#ad-msg', '');
  const r = adRows.find((x) => x.id === id);
  const d = r?.d || {};
  adCur = { id, desktop: d.desktop || null, mobile: d.mobile || null };
  $('#ad-h').textContent = id ? `Baner: ${d.client}` : 'Nowy baner';
  if (id) {
    A('slot').value = d.slot; A('client').value = d.client || ''; A('link').value = d.link || ''; A('alt').value = d.alt || '';
    A('start').value = dstr(toDate(d.start)); A('end').value = dstr(toDate(d.end)); A('weight').value = d.weight || 1; A('active').checked = !!d.active;
  }
  $('#ad-del').hidden = !id;
  af.hidden = false;
  slotDims(); renderAdPrev();
  af.scrollIntoView({ behavior: 'smooth' });
}
A('slot').addEventListener('change', slotDims);
$('#ad-new').addEventListener('click', () => openAd(null));
$('#ad-cancel').addEventListener('click', () => (af.hidden = true));

async function uploadBanner(file: File, need: readonly [number, number]): Promise<Variant> {
  const bmp = await createImageBitmap(file);
  const [w, h] = need;
  const ok = (bmp.width === w && bmp.height === h) || (bmp.width === w * 2 && bmp.height === h * 2);
  if (!ok) throw new Error(`Zły wymiar: ${bmp.width}×${bmp.height} px. Wymagane ${w}×${h} px (albo ${w * 2}×${h * 2} px).`);
  const stamp = Date.now().toString(36);
  let blob: Blob = file;
  let ext = 'gif';
  let contentType = 'image/gif';
  if (file.type !== 'image/gif') {
    blob = (await toWebp(file, bmp.width, 0.86)).blob;
    ext = 'webp'; contentType = 'image/webp';
  }
  return { w, h, url: await stage(`ads/${stamp}-${w}x${h}.${ext}`, blob, contentType) };
}
for (const which of ['d', 'm'] as const) {
  $(`#ad-${which}-in`).addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const s = SLOTS[A('slot').value as SlotKey];
    const need = which === 'd' ? s.desktop : s.mobile;
    if (!need) return;
    msg('#ad-msg', 'Wgrywam grafikę…');
    try {
      const v = await uploadBanner(file, need);
      if (which === 'd') adCur.desktop = v; else adCur.mobile = v;
      renderAdPrev(); msg('#ad-msg', 'Grafika gotowa.');
    } catch (err: any) { msg('#ad-msg', err.message, true); }
  });
}
af.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = SLOTS[A('slot').value as SlotKey];
  if (!adCur.desktop && !adCur.mobile) return msg('#ad-msg', 'Dodaj co najmniej jedną grafikę.', true);
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
    adCur.id = id;
    msg('#ad-msg', 'Baner zapisany. Automat opublikuje go w ciągu ok. 30 minut.');
    loadAds();
  } catch (err: any) { msg('#ad-msg', err.message, true); }
});
$('#ad-del').addEventListener('click', async () => {
  if (!adCur.id || !confirm('Usunąć ten baner?')) return;
  await deleteDoc(doc(db, 'ads', adCur.id));
  await markDirty();
  af.hidden = true;
  loadAds();
});

// ---------------- import ----------------
async function loadImports() {
  const snap = await getDocs(query(collection(db, 'imports'), orderBy('at', 'desc'), limit(30)));
  $('#imp-list').innerHTML = snap.docs.map((d) => {
    const x = d.data();
    return `<tr><td>${fmt(toDate(x.at))}</td><td>${x.trigger === 'manual' ? 'ręcznie' : 'automatycznie 15:00'}</td><td>${x.checked ?? 0}</td><td>${(x.imported || []).length}</td><td>${esc((x.errors || []).join('; ')) || '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="5">Jeszcze nie było importu.</td></tr>';
}
$('#imp-run').addEventListener('click', async () => {
  try {
    await markDirty({ importRequested: true });
    msg('#imp-msg', 'Zlecono import. Automat pobierze nowe aktualności przy najbliższym sprawdzeniu (do 30 minut).');
    buildStatus();
  } catch (err: any) { msg('#imp-msg', err.message, true); }
});

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
  if (me && !emails.includes(me)) return msg('#s-msg', 'Nie możesz usunąć własnego adresu z listy dostępu.', true);
  const adsenseSlots: Record<string, string> = {};
  for (const k of Object.keys(SLOTS)) { const v = S(`slot_${k}`).value.trim(); if (v) adsenseSlots[k] = v; }
  try {
    await Promise.all([
      setDoc(doc(db, 'config', 'site'), {
        adsenseEnabled: S('adsenseEnabled').checked,
        adsenseClient: S('adsenseClient').value.trim(),
        adsenseSlots,
        adsTxt: S('adsTxt').value.trim(),
        analyticsId: S('analyticsId').value.trim(),
      }),
      setDoc(doc(db, 'config', 'admins'), { emails }),
    ]);
    await markDirty();
    msg('#s-msg', 'Ustawienia zapisane. Na stronie zadziałają po najbliższej publikacji.');
  } catch (err: any) { msg('#s-msg', err.message, true); }
});
