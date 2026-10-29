// Redaktor naczelny AI: przegląda szkice wirtualnego redaktora zamiast człowieka. Sprawdza fakty ze źródłem, aktualność,
// powtórki i wzmianki o innych mediach (drobne błędy poprawia sam), ogląda zdjęcie główne i – gdy nie pasuje – wybiera
// lepsze spośród kandydatów ze wszystkich źródeł. Gotowe teksty publikuje rozłożone w ciągu dnia (7–21), pilne od razu.
// Szkice z wątpliwościami zostają w panelu z opisem, co poprawić; powtórki i nieaktualne tematy odrzuca.
import { chatJson } from './llm.js';
import { copyRatio } from './redaktor.js';
import { mentionsRival, stripRivalSentences, stripRivalsHtml } from './sources.js';
import { sanitizeHtml } from './scraper.js';
import { coverCandidates, personCandidates, judgeCovers, useCandidate } from './images.js';
import { warsawNow } from './firestore.js';
import { NACZELNY as SYSTEM, MIN_WORDS } from './naczelny-prompt.js';

const GAP = 45 * 60e3; // odstęp między publikacjami automatu
const HOURS = [7, 21]; // publikujemy od 7:00 do 21:59 (czas polski)
const FIX_COPY_LIMIT = 0.25;
const words = (h) => String(h || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

function userPrompt(d, source, ours) {
  const today = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
  return `DZISIEJSZA DATA: ${today}

NASZE ARTYKUŁY z ostatnich dni (adres | tytuł):
${ours.map((o) => `${o.slug} | ${o.title}`).join('\n') || '(brak)'}

SZKIC
Tytuł: ${d.title}
Lead: ${d.lead || '-'}
Treść:
${d.body}

MATERIAŁ ŹRÓDŁOWY (${d.basedOn?.name || 'brak'}${d.basedOn?.date ? `, ${new Date(d.basedOn.date?.toDate?.() || d.basedOn.date).toISOString().slice(0, 10)}` : ''})
Tytuł: ${d.basedOn?.title || '-'}
${source ? source.slice(0, 7000) : '(treść źródła niedostępna)'}`;
}

/** Najbliższy wolny termin publikacji: po ostatnim zaplanowanym + odstęp (z losowym przesunięciem), tylko 7–21, najwyżej perDay dziennie */
export function nextSlot(taken, now = new Date(), { perDay = 16, urgent = false, rand = Math.random } = {}) {
  const inHours = (t) => { const h = warsawNow(t).hour; return h >= HOURS[0] && h <= HOURS[1]; };
  const perDayOk = (t) => taken.filter((x) => warsawNow(x).day === warsawNow(t).day).length < perDay;
  let t = new Date(now.getTime() + 5 * 60e3);
  if (!(urgent && inHours(t) && perDayOk(t))) {
    const last = Math.max(0, ...taken.map((x) => +x));
    t = new Date(Math.max(t.getTime(), last + GAP + Math.round(rand() * 20) * 60e3));
  }
  for (let i = 0; i < 24 * 30 && !(inHours(t) && perDayOk(t)); i++) {
    const fresh = !inHours(t);
    t = new Date(t.getTime() + 5 * 60e3);
    if (fresh && inHours(t)) t = new Date(t.getTime() + Math.round(rand() * 25) * 60e3); // rano nie zawsze o 7:00
  }
  return t;
}

/**
 * store: {
 *   drafts() → szkice redaktora do przeglądu [{ slug, title, lead, body, basedOn, cover, imageSource, ai, copyRisk, ... }],
 *   recent(since) → nasze opublikowane i zaplanowane [{ slug, title }], autoTimes() → [Date] publikacji automatu (ostatnia doba i przyszłe),
 *   sourceText(url) → tekst źródła, update(slug, data), readLocal('/media/…') → Buffer,
 *   + jak w coverFor: photos(), usePhoto(id), cityArticles(), saveImage(path, buf)
 * }
 */
export async function runNaczelny(store, { perDay = 16, deadline = Infinity, log = console.log, chat = chatJson, now = () => new Date() } = {}) {
  const result = { checked: 0, published: [], held: [], rejected: [], newPhotos: 0, errors: [] };
  const drafts = (await store.drafts()).sort((a, b) => (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0));
  const ours = (await store.recent(new Date(Date.now() - 4 * 864e5))).slice(0, 80);
  const taken = await store.autoTimes();
  for (const d of drafts) {
    if (Date.now() > deadline) { log('naczelny: koniec czasu, pozostałe szkice przy następnym uruchomieniu'); break; }
    result.checked++;
    const hold = (problems, extra = {}) => {
      result.held.push(`${d.title} – ${problems.join('; ')}`);
      log(`naczelny: do człowieka – ${d.title} (${problems.join('; ')})`);
      return store.update(d.slug, { ...extra, review: { verdict: 'hold', problems, at: now() } });
    };
    try {
      const source = await store.sourceText(d.basedOn?.url).catch(() => '');
      const { data: r, provider } = await chat({ system: SYSTEM, user: userPrompt(d, source, ours.filter((o) => o.slug !== d.slug)), temperature: 0.2, log });
      const problems = (Array.isArray(r.problems) ? r.problems : []).map(String).filter(Boolean).slice(0, 6);
      if (r.verdict === 'reject') {
        await store.update(d.slug, { status: 'deleted', review: { verdict: 'reject', problems, duplicateOf: r.duplicateOf || null, provider, at: now() } });
        result.rejected.push(`${d.title} – ${problems.join('; ') || 'odrzucony'}`);
        log(`naczelny: odrzucony – ${d.title} (${problems.join('; ')})`);
        continue;
      }
      // poprawki naczelnego przyjmujemy tylko, gdy nie przybliżają tekstu do źródła i nie wnoszą nazw innych mediów
      const upd = {};
      if (r.fixed && typeof r.fixed === 'object') {
        const f = r.fixed;
        const title = String(f.title || d.title).trim().slice(0, 160);
        const lead = stripRivalSentences(String(f.lead || d.lead || '').trim()).text.slice(0, 400);
        const body = stripRivalsHtml(sanitizeHtml(String(f.body || d.body), 'https://czestokocham.pl')).html;
        const ok = !mentionsRival(title) && words(body) >= Math.min(MIN_WORDS, words(d.body)) * 0.9 && (!source || copyRatio(`${lead} ${body}`, source) <= FIX_COPY_LIMIT);
        if (ok) Object.assign(upd, { title, lead, body });
        else log(`naczelny: poprawki odrzucone (za krótkie, za bliskie źródłu albo z nazwą innego medium) – ${d.title}`);
      }
      const final = { ...d, ...upd };
      if (r.verdict !== 'publish') { await hold(problems.length ? problems : ['wymaga sprawdzenia'], upd); continue; }
      if (d.copyRisk && !upd.body) { await hold([`${d.copyRisk}% zwrotów pokrywa się ze źródłem`], upd); continue; }
      if (words(final.body) < MIN_WORDS) { await hold([`za krótki tekst (${words(final.body)} słów)`], upd); continue; }

      // zdjęcie: najpierw ocena obecnego; ilustrację AI i zdjęcie, które nie pasuje, próbujemy zastąpić prawdziwym
      const person = d.ai?.person?.name ? d.ai.person : null;
      const current = d.cover ? { image: d.cover, credit: d.photoCredit, page: d.imagePage, kind: d.imageSource || 'obecne', current: true } : null;
      let pick = current ? await judgeCovers({ title: final.title, lead: final.lead, person, candidates: [current], readLocal: store.readLocal, log }) : null;
      if (person && !pick) {
        const found = (await personCandidates(person, [d.basedOn, ...(d.basedOn?.alsoIn || [])].filter((s) => s?.url), log)).filter((c) => c.page !== d.imagePage);
        if (found.length) pick = await judgeCovers({ title: final.title, lead: final.lead, person, candidates: found, readLocal: store.readLocal, log });
      }
      if (!person && (!pick || d.imageSource === 'ai')) {
        const found = await coverCandidates(store, {
          title: final.title,
          tags: d.ai?.tags || [],
          photoQueries: [...new Set([...(r.photoQueries || []), ...(d.ai?.photoQueries || [])].filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim()))].slice(0, 5),
          stockQueries: [...(r.stockQueries || []), ...(d.ai?.stockQueries || [])].filter((q) => typeof q === 'string' && q.trim()).slice(0, 4),
          illustrationPrompt: d.ai?.illustrationPrompt || '',
          log,
        });
        const others = found.filter((c) => !(current?.image && c.image?.srcset?.[0]?.url === current.image.srcset?.[0]?.url));
        // pasująca ilustracja AI zostaje ostatnią deską ratunku – prawdziwe zdjęcie ma pierwszeństwo
        const better = others.length ? await judgeCovers({ title: final.title, lead: final.lead, candidates: others, readLocal: store.readLocal, log }) : null;
        if (better) pick = better;
      }
      if (!pick) { await hold([person ? 'brak pasującego zdjęcia osoby' : 'brak pasującego zdjęcia'], upd); continue; }
      if (!pick.current) {
        Object.assign(upd, await useCandidate(store, d.slug, pick, final.title));
        result.newPhotos++;
        log(`naczelny: nowe zdjęcie (${pick.kind}) – ${final.title}`);
      }

      const at = nextSlot(taken, now(), { perDay, urgent: !!r.urgent });
      taken.push(at);
      ours.unshift({ slug: d.slug, title: final.title });
      await store.update(d.slug, { ...upd, status: 'published', publishedAt: at, autoPublished: true, review: { verdict: 'publish', problems, urgent: !!r.urgent, provider, photo: pick.reason || null, at: now() } });
      result.published.push(`${final.title} – ${at.toISOString()}`);
      log(`naczelny: publikacja ${at.toISOString()} – ${final.title}`);
    } catch (e) {
      result.errors.push(`${d.title} – ${e.message}`);
      log(`naczelny: błąd ${d.title}: ${e.message}`);
    }
  }
  return result;
}
