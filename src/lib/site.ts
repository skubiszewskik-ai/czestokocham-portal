export const SITE = {
  name: 'Częstokocham',
  tagline: 'Wiadomości z Częstochowy i powiatu',
  description:
    'Częstokocham – portal informacyjny Częstochowy i powiatu częstochowskiego. Wiadomości z miasta, powiatu, kraju i sport.',
  email: 'czestokocham@gmail.com',
  phone: '884 971 219',
  facebook: 'https://www.facebook.com/czestokocham',
  // licznik polubień na żywo – aplikacja internetowa Budzika (scripts/budzik.gs → doGet)
  fbCounter: 'https://script.google.com/macros/s/AKfycbx43lRfEsc9KoGwBX8H8A6kkhxedYCmZd8DSIb_vjMJWK8orc57XPP2zZSBIb9iU5ov/exec',
  // adres Workera czatu (worker/index.js); puste = czat wyłączony
  chatApi: 'https://czestokocham-czat.czestokocham-pl.workers.dev',
  lang: 'pl',
  // kody weryfikacji: Google Search Console (google-site-verification) i Bing Webmaster Tools (msvalidate.01); puste = brak tagu
  // (IndexNow – klucz to plik public/<32 znaki hex>.txt, zgłoszenia wysyła scripts/publish.mjs)
  verify: { google: '', bing: '' },
};

// Wydawca portalu – stowarzyszenie zwykłe (dane z rejestru REGON; nazwiska uzupełnić po stronie stowarzyszenia)
export const PUBLISHER = {
  name: 'Stowarzyszenie Częstokocham',
  kind: 'stowarzyszenie zwykłe',
  street: 'ul. Kopernika 43/23',
  city: '42-217 Częstochowa',
  nip: '5732874304',
  regon: '365739159',
  representative: '', // przedstawiciel stowarzyszenia (imię i nazwisko)
  editorInChief: '', // redaktor naczelny (wymaga tego prawo prasowe)
};
export const PUBLISHER_ADDRESS = `${PUBLISHER.street}, ${PUBLISHER.city}`;

export const CATEGORIES = {
  miasto: { name: 'Miasto', title: 'Częstochowa', color: '#e3141b', lede: 'Co się dzieje w Częstochowie: urząd, inwestycje, drogi, kultura i ludzie.' },
  powiat: { name: 'Powiat', title: 'Powiat częstochowski', color: '#0b7a54', lede: 'Wiadomości z gmin powiatu: od Blachowni po Koniecpol.' },
  kraj: { name: 'Kraj', title: 'Z kraju', color: '#2f55d4', lede: 'Najważniejsze sprawy z Polski, które dotyczą także nas.' },
  sport: { name: 'Sport', title: 'Sport', color: '#b85200', lede: 'Raków, Włókniarz i cała reszta: wyniki, zapowiedzi, relacje.' },
} as const;

export type CategoryKey = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as CategoryKey[];
export const isCategory = (v: string | undefined): v is CategoryKey => !!v && v in CATEGORIES;

export const articleUrl = (a: { category: string; slug: string }) => `/${a.category}/${a.slug}`;

const tz = 'Europe/Warsaw';
export const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }).format(d);
export const fmtShort = (d: Date) =>
  new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', timeZone: tz }).format(d);
export const fmtTime = (d: Date) =>
  new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d);
export const fmtDay = (d: Date) =>
  new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(d);
export const isToday = (d: Date) => fmtShort(d) === fmtShort(new Date());
/** „14:05” dla dzisiejszych, „16.10” dla starszych */
export const fmtWhen = (d: Date) => (isToday(d) ? fmtTime(d) : fmtShort(d));

/** „3 min czytania” */
export const readTime = (html: string) => Math.max(1, Math.round(html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length / 200));

/** „2 godz. temu”, „wczoraj”, „16 paź” */
export function ago(d: Date, now = new Date()) {
  const m = Math.round((+now - +d) / 60000);
  if (m < 1) return 'przed chwilą';
  if (m < 60) return `${m} min temu`;
  if (m < 24 * 60 && isToday(d)) return `${Math.floor(m / 60)} godz. temu`;
  const y = new Date(+now - 864e5);
  if (fmtShort(d) === fmtShort(y)) return `wczoraj, ${fmtTime(d)}`;
  return new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', timeZone: tz }).format(d);
}

/** Rozmiar tytułu dobierany do długości, żeby mieścił się w dwóch liniach */
export const titleSize = (t: string) => (t.length <= 34 ? 'xl' : t.length <= 56 ? 'l' : t.length <= 80 ? 'm' : 's');

/** Kalendarz wydarzeń (CGK) – własny kolor, poza działami wiadomości */
export const EVENTS = { name: 'Wydarzenia', title: 'Co, gdzie, kiedy', color: '#0f7c8c', lede: 'Koncerty, spektakle, wystawy i spotkania w Częstochowie – na dziś i na najbliższe tygodnie.' };
