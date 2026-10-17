// Połączenie z Firestore przez konto serwisowe (GOOGLE_APPLICATION_CREDENTIALS albo FIREBASE_SERVICE_ACCOUNT z JSON-em)
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export function db() {
  if (!getApps().length) {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT;
    initializeApp(json ? { credential: cert(JSON.parse(json)) } : { projectId: 'czestokocham' });
  }
  return getFirestore();
}

/** Data w strefie Europe/Warsaw: { day: 'YYYY-MM-DD', hour } */
export function warsawNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((x) => [x.type, x.value])
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export const IMPORT_HOUR = 15;
