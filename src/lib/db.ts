// Dane strony wczytywane podczas budowania: data/ (zrzut z Firestore robiony przez scripts/publish.mjs)
// albo demo/ przy pracy lokalnej.
import { readFileSync } from 'node:fs';
import type { CategoryKey } from './site';
import type { SlotKey } from './slots';

export type ImgVariant = { w: number; h: number; url: string };
export type Img = { srcset: ImgVariant[]; w: number; h: number; alt: string };
export type Article = {
  id: string;
  slug: string;
  title: string;
  lead: string;
  body: string;
  category: CategoryKey;
  cover: Img | null;
  gallery: Img[];
  author: string;
  photoCredit: string | null;
  source: { name: string; url: string } | null;
  status: 'published' | 'draft';
  featured: boolean;
  publishedAt: Date;
  updatedAt?: Date;
  keywords: string[];
};
export type Ad = {
  id: string;
  slot: SlotKey;
  client: string;
  link: string;
  alt: string;
  desktop: ImgVariant | null;
  mobile: ImgVariant | null;
  start: Date | null;
  end: Date | null;
  weight: number;
};
export type Settings = {
  adsenseEnabled: boolean;
  adsenseClient: string;
  adsenseSlots: Partial<Record<SlotKey, string>>;
  adsTxt: string;
  analyticsId: string;
};

const DIR = process.env.CK_DATA || 'demo';
const read = (f: string, fallback: any) => {
  try {
    return JSON.parse(readFileSync(`${process.cwd()}/${DIR}/${f}`, 'utf8'));
  } catch {
    return fallback;
  }
};
const toDate = (v: any): Date | null => (v ? new Date(v) : null);

function normArticle(id: string, d: any): Article {
  return {
    id,
    slug: d.slug || id,
    title: d.title || '',
    lead: d.lead || '',
    body: d.body || '',
    category: d.category || 'miasto',
    cover: d.cover || null,
    gallery: d.gallery || [],
    author: d.author || 'Redakcja',
    photoCredit: d.photoCredit || null,
    source: d.source?.name ? d.source : null,
    status: d.status || 'draft',
    featured: !!d.featured,
    publishedAt: toDate(d.publishedAt) || new Date(),
    updatedAt: toDate(d.updatedAt) || undefined,
    keywords: d.keywords || [],
  };
}

const now = Date.now();
const snap = read('articles.json', { articles: {} });
// opublikowane, bez zaplanowanych na przyszłość
const ALL: Article[] = Object.entries(snap.articles || {})
  .map(([id, d]) => normArticle(id, d))
  .filter((a) => a.status === 'published' && +a.publishedAt <= now + 5 * 60e3)
  .sort((a, b) => +b.publishedAt - +a.publishedAt);

const site = read('site.json', { ads: [], settings: {} });
const SETTINGS: Settings = { adsenseEnabled: false, adsenseClient: '', adsenseSlots: {}, adsTxt: '', analyticsId: '', ...site.settings };
const ADS: Partial<Record<SlotKey, Ad[]>> = {};
for (const x of site.ads || []) {
  if (!x.active || (!x.desktop && !x.mobile)) continue;
  const ad: Ad = {
    id: x.id, slot: x.slot, client: x.client || '', link: x.link || '', alt: x.alt || x.client || 'Reklama',
    desktop: x.desktop || null, mobile: x.mobile || null, start: toDate(x.start), end: toDate(x.end), weight: Number(x.weight) || 1,
  };
  if (ad.end && +ad.end < now) continue;
  (ADS[ad.slot] ||= []).push(ad);
}

export const allArticles = () => ALL;
export const latest = ({ category, limit = 20, offset = 0 }: { category?: CategoryKey; limit?: number; offset?: number } = {}) =>
  ALL.filter((a) => !category || a.category === category).slice(offset, offset + limit);
export const featured = () => ALL.find((a) => a.featured) || null;
export const related = (a: Article, n = 4) => latest({ category: a.category, limit: n + 1 }).filter((x) => x.id !== a.id).slice(0, n);
export const settings = () => SETTINGS;
export const ads = () => ADS;
