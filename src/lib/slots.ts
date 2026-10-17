// Miejsca reklamowe – wymiary obowiązują w panelu i na stronie
export const SLOTS = {
  billboard: { name: 'Billboard pod nagłówkiem', desktop: [970, 250], mobile: [300, 250], where: 'Strona główna, kategorie' },
  'home-wide': { name: 'Baner szeroki na stronie głównej', desktop: [1200, 300], mobile: [300, 250], where: 'Strona główna, między działami' },
  sidebar: { name: 'Skyscraper boczny', desktop: [300, 600], mobile: null, where: 'Lista wiadomości, artykuł (tylko komputer)' },
  'list-inline': { name: 'Między wiadomościami', desktop: [750, 200], mobile: [300, 250], where: 'Listy wiadomości' },
  'article-inline': { name: 'W treści artykułu', desktop: [750, 200], mobile: [300, 250], where: 'Po drugim akapicie artykułu' },
  'article-bottom': { name: 'Pod artykułem', desktop: [970, 250], mobile: [300, 250], where: 'Koniec artykułu' },
} as const;
export type SlotKey = keyof typeof SLOTS;
