/* Firebase einmal einrichten: App, App Check, Anmeldung, Firestore (mit Speicher auf dem Gerät → geht auch ohne Internet).
   Gebraucht von daten.js (gemeinsame Liste) und ki.js (KI-Lesen). Projekt-Angaben: firebase-config.js.
   Die Tests setzen dort `emulator` → Anmeldung und Firestore laufen dann im Firebase-Emulator auf dem PC. */
window.Wolke = (function () {
  'use strict';
  const E = window.FIREBASE || {};
  const F = window.Firebase;
  if (!E.config || !F) return { fehler: 'Firebase lädt nicht.' };
  const app = F.initializeApp(E.config);
  if (E.appCheck) F.initializeAppCheck(app, { provider: new F.ReCaptchaEnterpriseProvider(E.appCheck), isTokenAutoRefreshEnabled: true });
  const auth = F.initializeAuth(app, { persistence: [F.indexedDBLocalPersistence, F.browserLocalPersistence] });
  auth.languageCode = 'de';   // E-Mails von Firebase (Passwort vergessen) auf Deutsch
  const db = F.initializeFirestore(app, {
    localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
    ignoreUndefinedProperties: true,
  });
  if (E.emulator) {
    F.connectAuthEmulator(auth, E.emulator.auth, { disableWarnings: true });
    F.connectFirestoreEmulator(db, E.emulator.firestore.host, E.emulator.firestore.port);
  }
  return { F, E, app, auth, db };
})();
