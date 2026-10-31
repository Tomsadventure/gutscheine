/* Liest einen Gutschein auf einem Foto mit KI (Gemini über Firebase AI Logic, Agent Platform): Laden, Guthaben oder Rabatt, Code, Ablauf, …
   Braucht Internet und das Firebase-Projekt (firebase-config.js, eingerichtet von wolke.js).
   Das Foto geht dafür an Google (bezahlte Stufe: Google trainiert nicht damit). */
window.KI = (function () {
  'use strict';
  const W = window.Wolke, E = W.E || {};
  // geduld: so lange auf die erste Antwort warten, dann zusätzlich eine schnelle Reserve-Anfrage; gesamt: dann aufgeben.
  // E.kiZeit nur für die Browser-Tests (kürzer).
  const zeit = Object.assign({ geduld: 12000, gesamt: 45000 }, E.kiZeit);
  const RESERVE_DENKEN = 'MINIMAL';   // die Reserve denkt kaum nach: schneller, liest fast gleich gut (2026-10-30)
  let modell = null;           // Promise des eingerichteten Modells

  const PROMPT = 'Auf dem Foto ist ein Gutschein aus der Schweiz (Geschenkkarte, Wertgutschein, Rabatt-Code oder Ähnliches). ' +
    'Lies die Angaben heraus. Erfinde nichts: Was nicht auf dem Foto steht oder nicht lesbar ist, bleibt leer.';
  const MEHRERE = ' Die Fotos zeigen verschiedene Seiten desselben Gutscheins (z. B. Vorder- und Rückseite): Fasse alles zu einem Gutschein zusammen.';
  const VIERTEL = ' Nach jedem Foto folgen vier vergrösserte Ausschnitte davon (oben links, oben rechts, unten links, unten rechts), damit du ' +
    'auch Kleingedrucktes lesen kannst – das sind keine weiteren Seiten. Lies Datum und Jahreszahl genau.';
  const FOTO_MAX = 1600, VIERTEL_MAX = 1280;   // ganzes Foto bzw. Ausschnitte für die KI (Punkte)

  const SCHEMA = {
    type: 'object',
    properties: {
      laden: { type: 'string', description: 'Laden oder Anbieter, so geschrieben wie er sich selbst schreibt, z. B. «ifolor», «Migros». Leer, wenn unklar.' },
      art: { type: 'string', enum: ['wert', 'rabatt'], description: 'wert = Guthaben in Franken (Geschenkkarte, Wertgutschein); rabatt = Prozent oder Abzug auf einen Einkauf.' },
      betrag: { type: 'string', description: 'Nur bei art=wert: Wert in Franken als Zahl ohne Währung, z. B. «50». Sonst leer.' },
      rabatt: { type: 'string', description: 'Nur bei art=rabatt: kurz, z. B. «20 %», «CHF 10», «2 für 1». Sonst leer.' },
      code: { type: 'string', description: 'Gutschein-Code oder Kartennummer genau wie gedruckt, ohne Leerzeichen. Hat der Gutschein einen Strichcode mit Nummer: diese Nummer. Keine Telefon-, Artikel- oder Kundennummern. Leer, wenn keiner zu sehen ist.' },
      onlineCode: { type: 'string', description: 'Nur wenn zusätzlich zum Code ein anderer Code zum Einlösen im Webshop aufgedruckt ist (z. B. Strichcode-Nummer für den Laden und ein Buchstaben-Code für online): dieser Code, ohne Leerzeichen. Sonst leer.' },
      pin: { type: 'string', description: 'PIN, falls aufgedruckt. Sonst leer.' },
      gueltigBis: { type: 'string', description: 'Letzter gültiger Tag als JJJJ-MM-TT. Leer, wenn kein Datum steht.' },
      nurOnline: { type: 'boolean', description: 'true, wenn er nur online (im Webshop) einlösbar ist.' },
      shop: { type: 'string', description: 'Webadresse zum Einlösen mit https://, wenn aufgedruckt; sonst die offizielle Schweizer Webseite des Anbieters, nur wenn du sie sicher kennst; sonst leer.' },
      bedingungen: { type: 'string', description: 'Die wichtigsten Bedingungen als ein kurzer deutscher Satz, z. B. «Einmal gültig, nicht für Versandkosten.». Leer, wenn keine.' },
    },
    required: ['laden', 'art', 'betrag', 'rabatt', 'code', 'onlineCode', 'pin', 'gueltigBis', 'nurOnline', 'shop', 'bedingungen'],
  };

  // Ist die KI eingerichtet und das Handy online?
  const bereit = () => !!W.app && !!E.modell && navigator.onLine !== false;

  // Einmal einrichten (auch wenn vorbereiten() und lesen() gleichzeitig fragen)
  function holeModell() {
    if (!modell) {
      const F = W.F;
      // Agent Platform (früher Vertex AI) an einem festen Ort; ohne Ort die Gemini Developer API (braucht dort Prepay-Guthaben)
      const ai = F.getAI(W.app, { backend: E.ort ? new F.AgentPlatformBackend(E.ort) : new F.GoogleAIBackend() });
      modell = Promise.resolve(F.getGenerativeModel(ai, { model: E.modell, generationConfig: konfig(E.denken || 'LOW') }));
    }
    return modell;
  }
  const konfig = denken => ({ responseMimeType: 'application/json', responseJsonSchema: SCHEMA, thinkingConfig: { thinkingLevel: denken } });

  const base64 = blob => new Promise((ok, nein) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => nein(r.error);
    r.readAsDataURL(blob);
  });

  // «gemini-3.5-flash-lite» → «Gemini 3.5 Flash-Lite»
  const gross = w => w.charAt(0).toUpperCase() + w.slice(1);
  function modellName(id) {
    const [marke, version, ...rest] = String(id || '').split('-');
    return [gross(marke), version, rest.map(gross).join('-')].filter(Boolean).join(' ');
  }

  // Antwort prüfen: nur erwartete Felder, sauber geschrieben
  function aufraeumen(k) {
    const text = v => (typeof v === 'string' ? v.trim() : '');
    const datum = text(k.gueltigBis);
    const shop = text(k.shop);
    const nurOnline = k.nurOnline === true;
    let code = text(k.code).replace(/\s+/g, ''), onlineCode = text(k.onlineCode).replace(/\s+/g, '');
    // Nur online: der Code ist der Online-Code – kein zweiter
    if (nurOnline && !code) code = onlineCode;
    if (nurOnline || onlineCode === code) onlineCode = '';
    return {
      laden: text(k.laden),
      art: k.art === 'rabatt' ? 'rabatt' : 'wert',
      betrag: text(k.betrag),
      rabatt: text(k.rabatt),
      code,
      onlineCode,
      pin: text(k.pin),
      gueltigBis: /^\d{4}-\d{2}-\d{2}$/.test(datum) && !isNaN(new Date(datum)) ? datum : '',
      nurOnline,
      shop: /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(shop) ? shop : '',
      bedingungen: text(k.bedingungen),
    };
  }

  // Foto (Blob, möglichst in voller Grösse) → Angaben; wirft bei Fehlern. Mehrere Fotos (Blob-Liste) = Seiten desselben Gutscheins,
  // in einer Anfrage. Jede Seite geht verkleinert (FOTO_MAX) und als vier Ausschnitte (VIERTEL_MAX) mit.
  // Gemini antwortet meist in 2–4 s, braucht aber ab und zu viel länger (2026-10-30 am iPhone: zwei Seiten 29 s, am PC dieselbe
  // Karte 2,5 s). Darum: nach zeit.geduld zusätzlich die Reserve fragen, die erste läuft weiter – die schnellere Antwort gilt.
  // Schlägt die erste gleich fehl, kommt die Reserve sofort. Höchstens zwei Anfragen. signal: abbrechen (z. B. neue Seite dazu).
  async function lesen(fotos, signal) {
    const liste = Array.isArray(fotos) ? fotos : [fotos];
    const m = await holeModell();
    const S = window.Scanner;
    const teile = [{ text: (liste.length > 1 ? PROMPT + MEHRERE : PROMPT) + VIERTEL }];
    for (const b of liste) {
      for (const x of [await S.verkleinern(b, FOTO_MAX), ...await S.viertel(b, VIERTEL_MAX)]) {
        teile.push({ inlineData: { mimeType: 'image/jpeg', data: await base64(x) } });
      }
    }
    const halt = new AbortController(), start = Date.now();
    if (signal) signal.addEventListener('abort', () => halt.abort());
    // Dazu, welches Modell genau gelesen hat (meldet Google in der Antwort) und ob es die Reserve war
    const frage = denken => m.generateContent({ contents: [{ role: 'user', parts: teile }], generationConfig: konfig(denken) },
      { timeout: Math.max(1000, zeit.gesamt - (Date.now() - start)), signal: halt.signal })
      .then(r => Object.assign(aufraeumen(JSON.parse(r.response.text())),
        { modell: modellName(r.response.modelVersion || E.modell), reserve: denken === RESERVE_DENKEN }));
    return new Promise((ok, nein) => {
      let offen = 0, reserve = false, uhr = 0;
      const fertig = x => { clearTimeout(uhr); halt.abort(); ok(x); };
      const frag = denken => {
        offen++;
        frage(denken).then(fertig, e => { offen--; if (!reserve && !halt.signal.aborted) frageReserve(); else if (!offen) nein(e); });
      };
      const frageReserve = () => { clearTimeout(uhr); if (!reserve && !halt.signal.aborted) { reserve = true; frag(RESERVE_DENKEN); } };
      frag(E.denken || 'LOW');
      uhr = setTimeout(frageReserve, zeit.geduld);
    });
  }

  // Beim Öffnen der Kamera: das Modell schon einrichten
  function vorbereiten() {
    if (bereit()) holeModell().catch(() => {});
  }

  return { bereit, lesen, vorbereiten, zeit };
})();
