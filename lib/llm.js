// Darmowe modele AI: Google Gemini (AI Studio, darmowy pakiet; natywne API), Groq oraz Pollinations bez klucza (API zgodne z OpenAI).
// Klucze: GEMINI_API_KEY, GROQ_API_KEY (sekrety w GitHubie, opcjonalne). Model można wymusić: GEMINI_MODEL, GROQ_MODEL.

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const PROVIDERS = [
  { name: 'gemini', key: 'GEMINI_API_KEY', model: process.env.GEMINI_MODEL },
  { name: 'groq', key: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b' },
  // ostatnia deska ratunku: działa bez klucza (darmowy, anonimowy pakiet z limitami)
  { name: 'pollinations', keyless: true, base: 'https://text.pollinations.ai/openai', model: 'openai' },
];

export const llmAvailable = () => PROVIDERS.some((p) => p.keyless || process.env[p.key]?.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = async (res) => `HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`;

/** Najnowszy „Flash” z listy modeli Gemini (bez lite/image/tts/live) – darmowy pakiet obejmuje modele Flash */
async function pickGeminiModel(key) {
  // klucze z AI Studio (od 2026 „AQ.…”) przekazujemy wyłącznie nagłówkiem x-goog-api-key
  const res = await fetch(`${GEMINI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error(`Gemini /models ${await errText(res)}`);
  const ids = ((await res.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
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

function request(p, key, { system, user, temperature }) {
  if (p.name === 'gemini') {
    return fetch(`${GEMINI}/models/${p.model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature, responseMimeType: 'application/json' },
      }),
    });
  }
  return fetch(p.keyless ? p.base : `${p.base}/chat/completions`, {
    method: 'POST',
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: p.model,
      temperature,
      max_tokens: 6000,
      ...(p.keyless ? { reasoning_effort: 'low' } : {}), // darmowy limit długości – mniej „myślenia”, cała odpowiedź się mieści
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
}

function answerText(p, out) {
  if (p.name === 'gemini') {
    const c = out.candidates?.[0];
    if (!c?.content?.parts) throw new Error(`Gemini bez odpowiedzi (${c?.finishReason || out.promptFeedback?.blockReason || 'brak'})`);
    return c.content.parts.filter((x) => !x.thought).map((x) => x.text || '').join('');
  }
  return out.choices?.[0]?.message?.content;
}

/**
 * Jedno zapytanie → obiekt JSON. Próbuje kolejnych dostawców; przy limicie (429) czeka i ponawia.
 * @returns {{ data: object, provider: string, model: string }}
 */
export async function chatJson({ system, user, temperature = 0.6, log = console.log }) {
  const errors = [];
  for (const p of PROVIDERS) {
    const key = p.keyless ? '' : process.env[p.key]?.trim();
    if ((!key && !p.keyless) || p.broken) continue;
    try {
      if (!p.model) p.model = await pickGeminiModel(key);
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await request(p, key, { system, user, temperature });
        if (res.status === 429 || res.status === 402 || res.status >= 500) {
          const wait = Math.min(60, Number(res.headers.get('retry-after')) || 20 * (attempt + 1));
          log(`AI ${p.name}: HTTP ${res.status}, czekam ${wait} s`);
          await sleep(wait * 1000);
          continue;
        }
        if (!res.ok) throw new Error(await errText(res));
        try {
          return { data: parseJson(answerText(p, await res.json())), provider: p.name, model: p.model };
        } catch (e) {
          log(`AI ${p.name}: ${e.message}, ponawiam`); // słabsze modele czasem urywają odpowiedź
        }
      }
      p.broken = true; // limit/przeciążenie – do końca uruchomienia piszemy zapasowym dostawcą
      throw new Error('limit zapytań albo błędne odpowiedzi – przechodzę do zapasowego');
    } catch (e) {
      if (/API_KEY_INVALID|HTTP 40[13]/.test(e.message)) p.broken = true; // zły klucz – do końca uruchomienia pomijamy tego dostawcę
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  throw new Error(errors.length ? errors.join(' | ') : 'brak klucza AI (GEMINI_API_KEY / GROQ_API_KEY)');
}
