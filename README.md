# Częstokocham – portal

Statyczny portal w Astro hostowany na Firebase Hosting (plan Spark, bez opłat).

- **Panel redakcji:** `/admin` (logowanie Google; lista dostępu w *Ustawieniach* panelu)
- **Baza:** Cloud Firestore (artykuły, banery, ustawienia)
- **Automat:** GitHub Actions (`.github/workflows/publish.yml`), co 30 min (6:00–23:30):
  - publikuje zmiany zapisane w panelu,
  - codziennie po 15:00 importuje aktualności z czestochowa.pl i wczestochowie.pl (zdjęcia → WebP, dopisek „Źródło: …”; z wczestochowie.pl przez WordPress REST API, bez artykułów sponsorowanych, ostatnie 3 dni).
  - co 2 godziny (7–21) uruchamia **wirtualnego redaktora** (`lib/redaktor.js`): czyta lokalne portale (`lib/sources.js`), odsiewa powtórki i tematy, które już mamy, a z nowych pisze przez darmowe AI (`lib/llm.js`: Google Gemini, zapasowo Groq) własne teksty jako **szkice** do akceptu w zakładce *Redaktor AI*. Zdjęć konkurencji nie używa (`lib/images.js`: bank zdjęć redakcji → Wikimedia Commons z podpisem → opcjonalnie ilustracja AI → plansza z tytułem).
- **Zdjęcia:** `public/media` (w repozytorium), dane: `data/` – zapisuje je automat.

## Ręcznie

```bash
npm ci
GOOGLE_APPLICATION_CREDENTIALS=~/.config/czestokocham/sa.json FIREBASE_SERVICE_ACCOUNT="$(cat ~/.config/czestokocham/sa.json)" npm run publish          # build + wdrożenie
GOOGLE_APPLICATION_CREDENTIALS=~/.config/czestokocham/sa.json FIREBASE_SERVICE_ACCOUNT="$(cat ~/.config/czestokocham/sa.json)" npm run publish:import   # + import z czestochowa.pl i wczestochowie.pl
npm run seed:demo && npm run dev   # podgląd lokalny na danych demo
```

Sekrety w GitHubie:
- `FIREBASE_SERVICE_ACCOUNT` – zawartość klucza konta serwisowego Firebase,
- `GEMINI_API_KEY` – darmowy klucz z https://aistudio.google.com/apikey (bez niego redaktor nie pracuje),
- `GROQ_API_KEY` – opcjonalny zapasowy, darmowy klucz z https://console.groq.com/keys.

Redaktor ręcznie: `npm run publish -- --redaktor` (z tymi samymi zmiennymi co wyżej oraz `GEMINI_API_KEY`).
