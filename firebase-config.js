/* Das Firebase-Projekt der App. Diese Angaben sind kein Geheimnis: Jede Firebase-Web-App hat sie offen im Code.
   Geschützt wird mit App Check (nur diese Webseite darf die KI fragen) und den Regeln in Firebase.
   config: null = noch nicht eingerichtet → Fotos werden nur nach Strichcodes durchsucht, die KI liest nicht. */
window.FIREBASE = {
  config: null,             // { apiKey, authDomain, projectId, appId, … } aus der Firebase-Konsole bzw. `firebase apps:sdkconfig`
  appCheck: null,           // reCAPTCHA-Enterprise-Schlüssel der Webseite (App Check)
  modell: 'gemini-3.8-flash',   // Firebase AI Logic → Modelle; Google stellt alte Modelle ab, dann hier ersetzen
};
