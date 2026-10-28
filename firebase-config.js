/* Das Firebase-Projekt der App. Diese Angaben sind kein Geheimnis: Jede Firebase-Web-App hat sie offen im Code.
   Geschützt wird mit App Check (nur diese Webseite darf die KI fragen) und den Regeln in Firebase.
   config: null = KI aus → Fotos werden nur nach Strichcodes durchsucht. Einrichten: Docs/App.md → KI-Lesen. */
window.FIREBASE = {
  config: {                 // `firebase apps:sdkconfig web <App-ID>` (Projekt gutscheine-2dee4, Web-App «Gutscheine»)
    apiKey: 'AIzaSyC4gUbc-Acy3CfW_h26pnwHSdhnSF2rwNo',
    authDomain: 'gutscheine-2dee4.firebaseapp.com',
    projectId: 'gutscheine-2dee4',
    storageBucket: 'gutscheine-2dee4.firebasestorage.app',
    messagingSenderId: '977471137122',
    appId: '1:977471137122:web:1f5191c99214f88321783b',
  },
  appCheck: '6LcHawUuAAAAAMt4a-F3FXQ8pL80EqdmcbASzt-E',   // reCAPTCHA-Enterprise-Site-Key (Scripts/appcheck-einrichten.cjs)
  // Firebase AI Logic → Modelle. Flash-Lite: 1–2 s und richtig (2026-10-28); gemini-3.8-flash blieb oft > 30 s hängen.
  // Stabil bis mindestens 2027-07-21 – danach (oder wenn Google es abstellt: 404) ein neueres Flash-Lite eintragen.
  modell: 'gemini-3.5-flash-lite',
  // Agent Platform (Abrechnung über Blaze, nur was gebraucht wird), Mehrfach-Region EU: Daten bleiben in der EU.
  // Zürich und einzelne EU-Regionen hatten die neuen Modelle nicht (404, 2026-10-28). null = Gemini Developer API (Prepay).
  ort: 'eu',
};
