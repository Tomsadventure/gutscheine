/* Liest einen Gutschein auf einem Foto mit KI (Gemini über Firebase AI Logic): Laden, Guthaben oder Rabatt, Code, Ablauf, …
   Braucht Internet und das Firebase-Projekt (firebase-config.js). Firebase lädt erst beim ersten Foto.
   Das Foto geht dafür an Google (bezahlte Stufe: Google trainiert nicht damit). */
window.KI = (function () {
  'use strict';
  const E = window.FIREBASE || {};
  const ZEIT_MS = 40000;
  let modell = null;

  const PROMPT = 'Auf dem Foto ist ein Gutschein aus der Schweiz (Geschenkkarte, Wertgutschein, Rabatt-Code oder Ähnliches). ' +
    'Lies die Angaben heraus. Erfinde nichts: Was nicht auf dem Foto steht oder nicht lesbar ist, bleibt leer.';

  const SCHEMA = {
    type: 'object',
    properties: {
      laden: { type: 'string', description: 'Laden oder Anbieter, so geschrieben wie er sich selbst schreibt, z. B. «ifolor», «Migros». Leer, wenn unklar.' },
      art: { type: 'string', enum: ['wert', 'rabatt'], description: 'wert = Guthaben in Franken (Geschenkkarte, Wertgutschein); rabatt = Prozent oder Abzug auf einen Einkauf.' },
      betrag: { type: 'string', description: 'Nur bei art=wert: Wert in Franken als Zahl ohne Währung, z. B. «50». Sonst leer.' },
      rabatt: { type: 'string', description: 'Nur bei art=rabatt: kurz, z. B. «20 %», «CHF 10», «2 für 1». Sonst leer.' },
      code: { type: 'string', description: 'Gutschein-Code oder Kartennummer genau wie gedruckt, ohne Leerzeichen. Keine Telefon-, Artikel- oder Kundennummern. Leer, wenn keiner zu sehen ist.' },
      pin: { type: 'string', description: 'PIN, falls aufgedruckt. Sonst leer.' },
      gueltigBis: { type: 'string', description: 'Letzter gültiger Tag als JJJJ-MM-TT. Leer, wenn kein Datum steht.' },
      nurOnline: { type: 'boolean', description: 'true, wenn er nur online (im Webshop) einlösbar ist.' },
      shop: { type: 'string', description: 'Webadresse zum Einlösen mit https://, wenn aufgedruckt; sonst die offizielle Schweizer Webseite des Anbieters, nur wenn du sie sicher kennst; sonst leer.' },
      bedingungen: { type: 'string', description: 'Die wichtigsten Bedingungen als ein kurzer deutscher Satz, z. B. «Einmal gültig, nicht für Versandkosten.». Leer, wenn keine.' },
    },
    required: ['laden', 'art', 'betrag', 'rabatt', 'code', 'pin', 'gueltigBis', 'nurOnline', 'shop', 'bedingungen'],
  };

  // Ist die KI eingerichtet und das Handy online?
  const bereit = () => !!E.config && navigator.onLine !== false;

  function ladeFirebase() {
    if (window.Firebase) return Promise.resolve();
    return new Promise((ok, nein) => {
      const s = document.createElement('script');
      s.src = 'lib/firebase/firebase.js?v=' + window.BUILD;
      s.onload = ok;
      s.onerror = () => nein(new Error('Firebase lädt nicht'));
      document.head.appendChild(s);
    });
  }

  async function holeModell() {
    if (modell) return modell;
    await ladeFirebase();
    const F = window.Firebase;
    const app = F.initializeApp(E.config);
    if (E.appCheck) F.initializeAppCheck(app, { provider: new F.ReCaptchaEnterpriseProvider(E.appCheck), isTokenAutoRefreshEnabled: true });
    const ai = F.getAI(app, { backend: new F.GoogleAIBackend() });
    modell = F.getGenerativeModel(ai, {
      model: E.modell,
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA, thinkingConfig: { thinkingLevel: 'LOW' } },
    });
    return modell;
  }

  const base64 = blob => new Promise((ok, nein) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => nein(r.error);
    r.readAsDataURL(blob);
  });

  function mitZeit(promise, ms) {
    let t = 0;
    return Promise.race([promise, new Promise((_, nein) => { t = setTimeout(() => nein(new Error('Zeit abgelaufen')), ms); })])
      .finally(() => clearTimeout(t));
  }

  // Antwort prüfen: nur erwartete Felder, sauber geschrieben
  function aufraeumen(k) {
    const text = v => (typeof v === 'string' ? v.trim() : '');
    const datum = text(k.gueltigBis);
    const shop = text(k.shop);
    return {
      laden: text(k.laden),
      art: k.art === 'rabatt' ? 'rabatt' : 'wert',
      betrag: text(k.betrag),
      rabatt: text(k.rabatt),
      code: text(k.code).replace(/\s+/g, ''),
      pin: text(k.pin),
      gueltigBis: /^\d{4}-\d{2}-\d{2}$/.test(datum) && !isNaN(new Date(datum)) ? datum : '',
      nurOnline: k.nurOnline === true,
      shop: /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(shop) ? shop : '',
      bedingungen: text(k.bedingungen),
    };
  }

  // Foto (Blob, JPEG) → Angaben; wirft bei Fehlern
  async function lesen(blob) {
    const m = await holeModell();
    const daten = await base64(blob);
    const r = await mitZeit(m.generateContent([{ text: PROMPT }, { inlineData: { mimeType: blob.type || 'image/jpeg', data: daten } }]), ZEIT_MS);
    return aufraeumen(JSON.parse(r.response.text()));
  }

  return { bereit, lesen };
})();
