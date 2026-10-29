# Częstokocham – portal

Statyczny portal w Astro hostowany na Firebase Hosting (plan Spark, bez opłat).

- **Panel redakcji:** `/admin` (logowanie Google; lista dostępu w *Ustawieniach* panelu)
- **Baza:** Cloud Firestore (artykuły, banery, ustawienia)
- **Automat:** GitHub Actions (`.github/workflows/publish.yml`), co 30 min (6:00–23:30):
  - publikuje zmiany zapisane w panelu,
  - codziennie o 10:00, 12:00 i 15:00 importuje aktualności z czestochowa.pl i wczestochowie.pl (zdjęcia → WebP, dopisek „Źródło: …”; z wczestochowie.pl przez WordPress REST API, bez artykułów sponsorowanych, ostatnie 3 dni). Import trafia **tylko do szkiców** (`origin: 'import'`) – to przedruki 1:1, a opublikowane kopie cudzych tekstów zablokowały AdSense (2026-10-29). Można je opublikować dopiero po przepisaniu (np. *Napisz z AI* z linku). Audyt podobieństwa opublikowanych tekstów do źródeł: `node scripts/audit-copies.mjs` (`--apply` chowa kopie > 40%).
  - co 2 godziny (7–21) uruchamia **wirtualnego redaktora** (`lib/redaktor.js`): czyta lokalne portale (`lib/sources.js`), odsiewa powtórki i tematy, które już mamy, a z nowych pisze przez darmowe AI (`lib/llm.js`: rotacja modeli – kolejne wersje Gemini Flash, Gemma, kilka modeli Groq, na końcu Pollinations; każdy model ma osobny darmowy limit, więc przy limicie automat pyta następny model zamiast czekać) własne teksty jako **szkice** do akceptu w zakładce *Redaktor AI*. Zdjęcie główne (`lib/images.js`): bank zdjęć redakcji → archiwum miasta → Wikipedia / Wikimedia Commons z podpisem → zdjęcia ogólne (Pexels/Pixabay z kluczem, Wikimedia Commons „Quality images” bez klucza, Openverse) → opcjonalnie ilustracja AI → plansza z tytułem. Gdy tekst dotyczy konkretnej osoby: tylko jej prawdziwe zdjęcie (Wikipedia → Commons → zdjęcie z artykułu źródłowego z podpisem portalu), nigdy AI; bez zdjęcia szkic dostaje oznaczenie „brak zdjęcia osoby”.
  - zaraz po redaktorze pracuje **redaktor naczelny AI** (`lib/naczelny.js`, włącznik w zakładce *Redaktor AI*): porównuje szkic ze źródłem (fakty, aktualność, powtórki, wzmianki o innych mediach – drobne błędy poprawia), Gemini ogląda zdjęcie główne, a gdy nie pasuje albo jest ilustracją AI – wybiera lepsze spośród kandydatów z archiwum miasta, Wikipedii, Commons, Openverse i banków stockowych. Gotowe teksty publikuje z przyszłą datą co 45–65 min (7:00–22:00, najwyżej 16 dziennie; pilne od razu); `config/build.nextScheduledAt` mówi `check.mjs` i budzikowi, kiedy zbudować stronę. Wątpliwe szkice zostają w panelu z opisem (`review`), powtórki i nieaktualne odrzuca. Ręcznie: `npm run publish -- --naczelny`.
  - w edytorze: **Napisz z AI** – artykuł z tematu (Gemini szuka faktów w Google), z linku (artykuł pobiera r.jina.ai, a gdy strona blokuje – Gemini czyta adres sam; pilnuje podobieństwa do źródła jak redaktor) albo z wklejonego komunikatu/notatek; menu **AI** przy treści: popraw, skróć, rozbuduj, uprość, śródtytuły, propozycje tytułów (`src/admin/ai.ts`, działa w przeglądarce – klucz Gemini w *Ustawieniach* → `config/ai`, bez klucza zapasowo Pollinations). Edytor treści: cofnij/ponów, śródtytuł i podtytuł, linki (⌘K), listy, zdjęcia w treści z podpisem (przycisk, ⌘V lub przeciągnięcie), filmy YouTube, linia, kod HTML, pełny ekran, licznik słów i kopia robocza w przeglądarce.
  - w edytorze: wklejanie zdjęcia głównego ze schowka (⌘V), szukanie zdjęcia osoby w Wikipedii i zamawianie nowej ilustracji AI (robi ją automat przy najbliższej publikacji).
  - czas publikacji artykułów z czestochowa.pl = godzina wgrania ich zdjęć (strona podaje tylko datę).
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
