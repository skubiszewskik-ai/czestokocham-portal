import { defineConfig } from 'astro/config';

// Strona w pełni statyczna – budowana przez scripts/publish.mjs i hostowana na Firebase Hosting (plan Spark)
export default defineConfig({
  site: process.env.SITE_URL || 'https://czestokocham.pl',
  output: 'static',
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'always', format: 'directory' },
  compressHTML: true,
});
