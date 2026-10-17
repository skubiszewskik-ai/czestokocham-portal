export const PER = 30;
export const pageUrl = (cat: string, page: number) => (page <= 1 ? `/${cat}` : `/${cat}/strona/${page}`);
