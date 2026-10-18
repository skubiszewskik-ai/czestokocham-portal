// Darmowe modele AI przez API zgodne z OpenAI: Google Gemini (AI Studio, darmowy pakiet) i zapasowo Groq.
// Klucze: GEMINI_API_KEY, GROQ_API_KEY (sekrety w GitHubie). Model można wymusić: GEMINI_MODEL, GROQ_MODEL.

const PROVIDERS = [
  { name: 'gemini', key: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: process.env.GEMINI_MODEL },
  { name: 'groq', key: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b' },
];

export const llmAvailable = () => PROVIDERS.some((p) => process.env[p.key]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Gemini: nowsze klucze (np. „AQ.…”) wymagają natywnego nagłówka x-goog-api-key – wysyłamy oba
const authHeaders = (p, key) => ({ authorization: `Bearer ${key}`, ...(p.name === 'gemini' ? { 'x-goog-api-key': key } : {}) });

/** Najnowszy „Flash” z listy modeli Gemini (bez lite/image/tts/live) – darmowy pakiet obejmuje modele Flash */
async function pickGeminiModel(p) {
  const res = await fetch(`${p.base}/models`, { headers: authHeaders(p, process.env[p.key].trim()) });
  if (!res.ok) throw new Error(`Gemini /models HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
  const ids = (await res.json()).data.map((m) => m.id.replace(/^models\//, ''))
    .filter((id) => /^gemini-[\d.]+-flash(-latest)?$/.test(id) || id === 'gemini-flash-latest');
  if (ids.includes('gemini-flash-latest')) return 'gemini-flash-latest';
  const ver = (id) => parseFloat(id.match(/gemini-([\d.]+)/)?.[1] || '0');
  ids.sort((a, b) => ver(b) - ver(a));
  if (!ids[0]) throw new Error('Gemini: brak modelu Flash');
  return ids[0];
}

/** Wyciąga obiekt JSON z odpowiedzi (także gdy model owinie go w ```json) */
export function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('odpowiedź AI nie jest JSON-em');
}

/**
 * Jedno zapytanie → obiekt JSON. Próbuje kolejnych dostawców; przy limicie (429) czeka i ponawia.
 * @returns {{ data: object, provider: string, model: string }}
 */
export async function chatJson({ system, user, temperature = 0.6, log = console.log }) {
  const errors = [];
  for (const p of PROVIDERS) {
    const key = process.env[p.key]?.trim();
    if (!key) continue;
    try {
      if (!p.model) p.model = await pickGeminiModel(p);
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${p.base}/chat/completions`, {
          method: 'POST',
          headers: { ...authHeaders(p, key), 'content-type': 'application/json' },
          body: JSON.stringify({
            model: p.model,
            temperature,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          }),
        });
        if (res.status === 429 || res.status >= 500) {
          const wait = Math.min(60, Number(res.headers.get('retry-after')) || 20 * (attempt + 1));
          log(`AI ${p.name}: HTTP ${res.status}, czekam ${wait} s`);
          await sleep(wait * 1000);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const out = await res.json();
        return { data: parseJson(out.choices?.[0]?.message?.content), provider: p.name, model: p.model };
      }
      throw new Error('limit zapytań – spróbuję później');
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  throw new Error(errors.length ? errors.join(' | ') : 'brak klucza AI (GEMINI_API_KEY / GROQ_API_KEY)');
}
