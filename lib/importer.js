// Import aktualności z czestochowa.pl do bazy portalu
import { fetchText, fetchBuffer, parseList, parseArticle, parsePlDate, guessCategory, toWebpVariants, LIST_URL } from './scraper.js';

const MAX_GALLERY = 10;
const COVER_WIDTHS = [240, 640, 1280]; // 240 – miniatury na listach
const GALLERY_WIDTHS = [480, 1200];

export function keywordsFor(...parts) {
  const words = parts.join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return [...new Set(words)].slice(0, 80);
}

/**
 * store: { exists(id) → bool, saveImage(path, buffer) → url, saveArticle(id, data) }
 */
export async function importLatest(store, { pages = 3, limit = 30, log = console.log } = {}) {
  const found = [];
  for (let p = 1; p <= pages; p++) {
    const url = p === 1 ? LIST_URL : `${LIST_URL}?1=${p}`;
    const items = parseList(await fetchText(url));
    found.push(...items);
    // gdy na stronie są już znane artykuły, starsze też są w bazie
    const known = await Promise.all(items.map((i) => store.exists(i.slug)));
    if (known.some(Boolean)) break;
  }
  const order = new Map(found.map((it, i) => [it.slug, i]));
  const result = { checked: found.length, imported: [], skipped: 0, errors: [] };
  for (const item of found.slice(0, limit).reverse()) {
    try {
      if (await store.exists(item.slug)) { result.skipped++; continue; }
      const art = parseArticle(await fetchText(item.url), item.url);
      const title = art.title || item.title;
      const lead = art.lead || item.lead;
      const images = [];
      for (const [idx, src] of art.images.slice(0, MAX_GALLERY + 1).entries()) {
        try {
          const variants = await toWebpVariants(await fetchBuffer(src), idx === 0 ? COVER_WIDTHS : GALLERY_WIDTHS);
          const srcset = [];
          for (const v of variants) {
            const url = await store.saveImage(`articles/${item.slug}/${idx}-${v.width}.webp`, v.buffer);
            srcset.push({ w: v.width, h: v.height, url });
          }
          const big = srcset[srcset.length - 1];
          images.push({ srcset, w: big.w, h: big.h, alt: idx === 0 ? title : `${title} – zdjęcie ${idx}` });
        } catch (e) {
          log(`zdjęcie pominięte ${src}: ${e.message}`);
        }
      }
      await store.saveArticle(item.slug, {
        slug: item.slug,
        title,
        lead,
        body: art.body,
        category: guessCategory(title, lead),
        cover: images[0] || null,
        gallery: images.slice(1),
        author: 'Redakcja',
        photoCredit: art.photoCredit,
        source: { name: 'czestochowa.pl', url: item.url },
        status: 'published',
        featured: false,
        publishedAt: new Date(parsePlDate(art.date || item.date).getTime() - order.get(item.slug) * 60000),
        keywords: keywordsFor(title, lead),
        importedAt: new Date(),
      });
      result.imported.push(item.slug);
      log(`zaimportowano: ${item.slug}`);
    } catch (e) {
      result.errors.push(`${item.slug}: ${e.message}`);
      log(`błąd ${item.slug}: ${e.message}`);
    }
  }
  return result;
}
