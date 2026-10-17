import type { APIRoute } from 'astro';
import { settings } from '../lib/db';
// ads.txt dla Google AdSense – generowany z ustawień panelu
export const GET: APIRoute = async () => {
  const s = await settings();
  const pub = s.adsenseClient.replace(/^ca-/, '');
  const lines = [s.adsTxt?.trim(), pub ? `google.com, ${pub}, DIRECT, f08c47fec0942fa0` : ''].filter(Boolean);
  return new Response((lines.join('\n') || '# brak') + '\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
