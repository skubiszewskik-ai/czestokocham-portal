// Kalendarz wydarzeń (data/events.json – zapisuje go lib/cgk.js podczas publikacji)
import { readFileSync } from 'node:fs';
import type { Img } from './db';

export type EventDate = { day: string; time: string | null };
export type CityEvent = {
  slug: string;
  title: string;
  lead: string;
  body: string;
  type: string;
  place: string;
  address: string | null;
  dates: EventDate[];
  cover: Img | null;
  photoCredit: string;
  tickets: string | null;
  price: string | null;
  organizer: string | null;
  source: { name: string; url: string };
  ready: boolean; // opis przeredagowany – ma własną stronę; bez niego odsyłamy do CGK
};
export type Occurrence = { e: CityEvent; d: EventDate };

const read = (dir: string) => {
  try { return JSON.parse(readFileSync(`${process.cwd()}/${dir}/events.json`, 'utf8')); } catch { return null; }
};
const raw = read(process.env.CK_DATA || 'demo') || read('data') || { events: {} };

const tz = 'Europe/Warsaw';
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());

const ALL: CityEvent[] = Object.values<any>(raw.events || {})
  .map((x) => ({
    slug: x.slug, title: x.title, lead: x.lead || '', body: x.body || '', type: x.type || 'Wydarzenie',
    place: x.place || '', address: x.address || null, dates: x.dates || [], cover: x.cover || null,
    photoCredit: x.photoCredit || 'cgk.czestochowa.pl', tickets: x.tickets || null, price: x.price || null,
    organizer: x.organizer || null, source: x.source, ready: !!x.ai && !!x.body,
  }))
  .filter((e) => e.dates.some((d: EventDate) => d.day >= today()));

/** Trwające kilka dni bez godzin (wystawy, konkursy) – osobno, żeby nie zapełniały każdego dnia kalendarza */
export const isOngoing = (e: CityEvent) => e.dates.length >= 3 && e.dates.every((d) => !d.time);

const key = (o: Occurrence) => `${o.d.day} ${o.d.time || '00:00'}`;
export const upcoming = (): Occurrence[] =>
  ALL.filter((e) => !isOngoing(e))
    .flatMap((e) => e.dates.filter((d) => d.day >= today()).map((d) => ({ e, d })))
    .sort((a, b) => key(a).localeCompare(key(b)));
export const ongoing = () => ALL.filter(isOngoing).sort((a, b) => a.dates[a.dates.length - 1].day.localeCompare(b.dates[b.dates.length - 1].day));
/** Najbliższe wydarzenia, każde raz (na stronę główną) */
export const next = (n = 8) => {
  const seen = new Set<string>();
  return upcoming().filter((o) => o.e.cover && !seen.has(o.e.slug) && seen.add(o.e.slug)).slice(0, n);
};
export const allEvents = () => ALL;
export const eventTypes = () => [...new Set(ALL.map((e) => e.type))].sort((a, b) => a.localeCompare(b, 'pl'));
export const eventUrl = (e: CityEvent) => (e.ready ? `/wydarzenia/${e.slug}` : e.source.url);

const asDate = (day: string) => new Date(`${day}T12:00:00Z`);
const f = (o: Intl.DateTimeFormatOptions) => (day: string) => new Intl.DateTimeFormat('pl-PL', { ...o, timeZone: 'UTC' }).format(asDate(day));
export const dayNum = f({ day: 'numeric' });
export const monthShort = f({ month: 'short' });
export const weekday = f({ weekday: 'long' });
export const dayLong = f({ weekday: 'long', day: 'numeric', month: 'long' });
export const dayMed = f({ day: 'numeric', month: 'long' });
/** „dziś”, „jutro” albo „czwartek, 23 października” */
export function dayLabel(day: string) {
  const t = today();
  if (day === t) return 'Dziś';
  if (day === new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date(Date.now() + 864e5))) return 'Jutro';
  const s = dayLong(day);
  return s[0].toUpperCase() + s.slice(1);
}
/** „23 października, 19:00” */
export const whenText = (d: EventDate) => `${dayMed(d.day)}${d.time ? `, ${d.time}` : ''}`;
/** „do 15 listopada” dla trwających */
export const untilText = (e: CityEvent) => `do ${dayMed(e.dates[e.dates.length - 1].day)}`;
