// Darmowe modele AI: Google Gemini (AI Studio, darmowy pakiet; natywne API), Groq oraz Pollinations bez klucza (API zgodne z OpenAI).
// Klucze: GEMINI_API_KEY, GROQ_API_KEY (sekrety w GitHubie, opcjonalne). Model można wymusić: GEMINI_MODEL, GROQ_MODEL.
//
// Darmowe limity liczą się OSOBNO dla każdego modelu (zapytania na minutę i na dzień, tokeny na minutę), więc zamiast
// czekać na jeden model przechodzimy po kolei przez wszystkie dostępne: kilka wersji Gemini Flash, Gemma, kilka modeli Groq.
// Limit minutowy – model odpoczywa tyle, ile każe serwer, a my w tym czasie pytamy następny; limit dzienny, brak modelu
// albo zawieszone połączenie – model wypada do końca uruchomienia (zawieszenie: na kilka minut). Gdy chwilowo zajęte są
// wszystkie, czekamy na pierwszy wolny i próbujemy dalej.

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ = 'https://api.groq.com/openai/v1';
// kolejność modeli Groq: od najlepszych po polsku; niedostępne u Groqa są pomijane (lista z /models)
const GROQ_PREFERRED = [
  'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile',
  'qwen/qwen3-32b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-20b',
];
const GROQ_VISION = /llama-4/;
const PROVIDERS = [
  // ocena zdjęć: modele Flash-Lite mają w darmowym pakiecie wyższe limity – nie zjadają limitu pisania
  { name: 'gemini-lite', key: 'GEMINI_API_KEY', lite: true, visionOnly: true },
  { name: 'gemini', key: 'GEMINI_API_KEY' },
  { name: 'groq', key: 'GROQ_API_KEY' },
  // ostatnia deska ratunku: działa bez klucza (darmowy, anonimowy pakiet z limitami)
  { name: 'pollinations', keyless: true },
];

export const llmAvailable = () => PROVIDERS.some((p) => p.keyless || process.env[p.key]?.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_S = 90; // jedno zapytanie – zawieszony model odkładamy i pytamy następny
const MAX_WAIT_S = 90; // dłużej na zwolnienie limitu nie czekamy
const errText = async (res) => `HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 400)}`;
const ver = (id) => parseFloat(id.match(/-([\d.]+)-/)?.[1] || '0');

/** Modele Gemini z darmowego pakietu, od najlepszego: *-latest, potem numerowane od najnowszych; do pisania także Gemma */
async function geminiModels(key, lite) {
  if (process.env.GEMINI_MODEL && !lite) return [{ id: process.env.GEMINI_MODEL, vision: true }];
  // klucze z AI Studio (od 2026 „AQ.…”) przekazujemy wyłącznie nagłówkiem x-goog-api-key
  const res = await fetch(`${GEMINI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error(`Gemini /models ${await errText(res)}`);
  const ids = ((await res.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  const flash = lite ? /^gemini-[\d.]+-flash-lite(-preview)?$/ : /^gemini-[\d.]+-flash(-preview)?$/;
  const numbered = ids.filter((id) => flash.test(id)).sort((a, b) => ver(b) - ver(a) || a.length - b.length);
  const latest = lite ? 'gemini-flash-lite-latest' : 'gemini-flash-latest';
  const list = [...(ids.includes(latest) ? [latest] : []), ...numbered].map((id) => ({ id, vision: true }));
  // Gemma: osobny, duży limit dzienny; bez instrukcji systemowej i trybu JSON – obsługujemy to w zapytaniu
  if (!lite) list.push(...ids.filter((id) => /^gemma-\d+-\d+b/.test(id)).sort((a, b) => parseInt(b.match(/(\d+)b/)[1]) - parseInt(a.match(/(\d+)b/)[1])).map((id) => ({ id, gemma: true })));
  return list;
}

async function groqModels(key) {
  if (process.env.GROQ_MODEL) return [{ id: process.env.GROQ_MODEL }];
  const res = await fetch(`${GROQ}/models`, { headers: { authorization: `Bearer ${key}` } }).catch(() => null);
  const have = res?.ok ? new Set(((await res.json()).data || []).map((m) => m.id)) : null;
  return GROQ_PREFERRED.filter((id) => !have || have.has(id)).map((id) => ({ id, vision: GROQ_VISION.test(id) }));
}

async function modelsFor(p, key) {
  if (!p.models) {
    p.models = p.name.startsWith('gemini') ? await geminiModels(key, p.lite)
      : p.name === 'groq' ? await groqModels(key)
        : [{ id: 'openai' }];
    p.models.forEach((m) => { m.until = 0; m.dead = false; });
  }
  return p.models;
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

// images: zdjęcia JPEG w base64 dołączane do wiadomości (wybór zdjęcia przez model)
function request(p, m, key, { system, user, temperature, images = [] }) {
  const signal = AbortSignal.timeout(TIMEOUT_S * 1000);
  if (p.name.startsWith('gemini')) {
    const text = m.gemma ? `${system}\n\n---\n\n${user}\n\nOdpowiedz wyłącznie obiektem JSON.` : user;
    return fetch(`${GEMINI}/models/${m.id}:generateContent`, {
      method: 'POST', signal,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(m.gemma ? {} : { systemInstruction: { parts: [{ text: system }] } }),
        contents: [{ role: 'user', parts: [{ text }, ...images.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } }))] }],
        generationConfig: { temperature, ...(m.gemma ? {} : { responseMimeType: 'application/json' }) },
      }),
    });
  }
  return fetch(p.keyless ? 'https://text.pollinations.ai/openai' : `${GROQ}/chat/completions`, {
    method: 'POST', signal,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: m.id,
      temperature,
      max_tokens: 6000,
      ...(p.keyless || /gpt-oss/.test(m.id) ? { reasoning_effort: 'low' } : {}), // mniej „myślenia” – cała odpowiedź mieści się w limicie tokenów
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, {
        role: 'user',
        content: images.length ? [{ type: 'text', text: user }, ...images.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }))] : user,
      }],
    }),
  });
}

function answerText(p, out) {
  if (p.name.startsWith('gemini')) {
    const c = out.candidates?.[0];
    if (!c?.content?.parts) throw new Error(`Gemini bez odpowiedzi (${c?.finishReason || out.promptFeedback?.blockReason || 'brak'})`);
    return c.content.parts.filter((x) => !x.thought).map((x) => x.text || '').join('');
  }
  return out.choices?.[0]?.message?.content;
}

/** Ile sekund odczekać po 429 i czy to limit dzienny (wtedy model odpada do końca uruchomienia) */
function limitInfo(res, body) {
  const daily = /per ?day|PerDay|daily|RPD|TPD/i.test(body);
  const hinted = Number(res.headers.get('retry-after')) || Number(body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1]) || Number(body.match(/try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/)?.slice(1).reduce((s, x, i) => s + (Number(x) || 0) * (i ? 1 : 60), 0));
  return { daily, wait: Math.ceil(hinted || 20) };
}

/**
 * Jedno zapytanie → obiekt JSON. Przechodzi przez dostawców i ich modele; przy limitach przełącza model albo czeka.
 * @returns {{ data: object, provider: string, model: string }}
 */
export async function chatJson({ system, user, temperature = 0.6, images = [], log = console.log }) {
  const errors = [];
  for (let round = 0; round < 4; round++) {
    let soonest = Infinity;
    for (const p of PROVIDERS) {
      const key = p.keyless ? '' : process.env[p.key]?.trim();
      if ((!key && !p.keyless) || p.dead || (!images.length && p.visionOnly)) continue;
      let models;
      try { models = await modelsFor(p, key); } catch (e) { p.dead = true; errors.push(`${p.name}: ${e.message}`); continue; }
      for (const m of models) {
        if (m.dead || (images.length && !m.vision)) continue;
        if (m.until > Date.now()) { soonest = Math.min(soonest, m.until); continue; }
        try {
          const res = await request(p, m, key, { system, user, temperature, images });
          if (res.status === 429 || res.status === 402) {
            const { daily, wait } = limitInfo(res, await res.text());
            if (daily) { m.dead = true; log(`AI ${p.name}/${m.id}: dzienny limit – przechodzę do następnego modelu`); }
            else { m.until = Date.now() + wait * 1000; soonest = Math.min(soonest, m.until); log(`AI ${p.name}/${m.id}: limit, odpoczywa ${wait} s – pytam następny`); }
            continue;
          }
          if (res.status >= 500) { m.until = Date.now() + 60e3; soonest = Math.min(soonest, m.until); log(`AI ${p.name}/${m.id}: HTTP ${res.status} (przeciążony) – pytam następny`); continue; }
          if (res.status === 401 || res.status === 403) { p.dead = true; errors.push(`${p.name}: ${await errText(res)}`); break; } // zły klucz
          if (!res.ok) { m.dead = true; errors.push(`${p.name}/${m.id}: ${await errText(res)}`); continue; } // brak modelu, zły format
          const data = parseJson(answerText(p, await res.json()));
          return { data, provider: p.name, model: m.id };
        } catch (e) {
          // zawieszone połączenie (Gemini przy przeciążeniu potrafi milczeć minutami) albo urwana odpowiedź
          const hung = e.name === 'TimeoutError';
          m.until = Date.now() + (hung ? 5 * 60e3 : 30e3);
          soonest = Math.min(soonest, m.until);
          log(`AI ${p.name}/${m.id}: ${hung ? `brak odpowiedzi w ${TIMEOUT_S} s` : e.message} – pytam następny`);
        }
      }
    }
    const wait = soonest - Date.now();
    if (!Number.isFinite(soonest) || wait > MAX_WAIT_S * 1000) break;
    log(`AI: wszystkie modele chwilowo zajęte, czekam ${Math.ceil(wait / 1000)} s`);
    await sleep(Math.max(1000, wait));
  }
  throw new Error(errors.length ? errors.slice(-4).join(' | ') : 'wszystkie modele AI chwilowo niedostępne (limity)');
}
