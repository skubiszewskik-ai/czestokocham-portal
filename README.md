# Częstokocham – portal

Statyczny portal w Astro hostowany na Firebase Hosting (plan Spark, bez opłat).

- **Panel redakcji:** `/admin` (logowanie Google; lista dostępu w *Ustawieniach* panelu)
- **Baza:** Cloud Firestore (artykuły, banery, ustawienia)
- **Automat:** GitHub Actions (`.github/workflows/publish.yml`), co 30 min (6:00–23:30):
  - publikuje zmiany zapisane w panelu,
  - codziennie po 15:00 importuje aktualności z czestochowa.pl (zdjęcia → WebP, dopisek „Źródło: czestochowa.pl”).
- **Zdjęcia:** `public/media` (w repozytorium), dane: `data/` – zapisuje je automat.

## Ręcznie

```bash
npm ci
GOOGLE_APPLICATION_CREDENTIALS=~/.config/czestokocham/sa.json FIREBASE_SERVICE_ACCOUNT="$(cat ~/.config/czestokocham/sa.json)" npm run publish          # build + wdrożenie
GOOGLE_APPLICATION_CREDENTIALS=~/.config/czestokocham/sa.json FIREBASE_SERVICE_ACCOUNT="$(cat ~/.config/czestokocham/sa.json)" npm run publish:import   # + import z czestochowa.pl
npm run seed:demo && npm run dev   # podgląd lokalny na danych demo
```

Sekret w GitHubie: `FIREBASE_SERVICE_ACCOUNT` (zawartość klucza konta serwisowego Firebase).
