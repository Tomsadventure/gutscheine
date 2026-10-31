/* Gutscheine: Anmelden, Liste, Erfassen (Kamera, Foto oder von Hand), einen Gutschein ansehen, an der Kasse zeigen.
   Gemeinsame Liste und Konto: daten.js (Firebase: wolke.js) · Kamera und Lesen: scanner.js · Foto mit KI lesen: ki.js ·
   Strichcode zeichnen: strichcode.js */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const D = window.Daten, S = window.Scanner, B = window.Strichcode, K = window.KI;
  const BALD_TAGE = 30;        // so viele Tage vor dem Ablauf gilt ein Gutschein als «läuft bald ab»
  const FOTO_MAX = 1600;       // Fotos werden höchstens so breit gespeichert
  const SUCHE_AB = 5;          // ab so vielen Gutscheinen (aktiv + Archiv) gibt es das Suchfeld
  const FARBEN = ['#0E7C66', '#2563A8', '#B4542D', '#7A4FB3', '#A8326E', '#3E7D2B', '#94650A', '#2F6F7A'];
  const CODE_HINWEIS = 'Strichcode oder QR-Code ins Feld halten.<br>Er wird von selbst gelesen.';

  const chfFormat = new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF' });
  const chf = n => chfFormat.format(n || 0);

  let alle = [];               // alle Gutscheine
  let zugang = 'unbekannt';    // abgemeldet | gesperrt (Konto noch nicht freigeschaltet) | ok
  let reiter = 'aktiv';
  let ansichtJetzt = 'liste';
  let detailStand = '';        // so steht der gezeigte Gutschein (geaendert) – Änderungen vom anderen Handy neu zeigen
  let entwurf = null;          // was im Formular steht: { id, laden, …, gelesen, formatGewaehlt, fotos: [{ id } | { blob, url }] }
  let sperre = null;           // Bildschirm wach halten an der Kasse
  let installEvent = null;
  const fotoUrls = new Map();
  const svgCache = new Map();

  // ---------- Hilfen ----------
  function datum(iso) {
    return new Date(iso + 'T00:00').toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function tageBis(iso) {
    const heute = new Date();
    heute.setHours(0, 0, 0, 0);
    return Math.round((new Date(iso + 'T00:00') - heute) / 864e5);
  }
  // «50», «25.50», «25,50», «CHF 50.–» → Zahl; leer → null; Unsinn → false
  function betragLesen(text) {
    const t = String(text || '').replace(/chf|fr\.?|\s|'|’/gi, '').replace(',', '.').replace(/\.[-–]$/, '');
    if (!t) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return false;
    return Math.round(parseFloat(t) * 100) / 100;
  }
  const gerundet = n => Math.round(n * 100) / 100;
  // Lange Nummern in Vierergruppen zeigen (nur zum Lesen, gespeichert wird ohne Abstände)
  const codeZeigen = code => (/^\d{9,}$/.test(code) ? code.replace(/(\d{4})(?=\d)/g, '$1 ') : code);
  function farbe(name) {
    let h = 0;
    for (const z of name.toLowerCase()) h = (h * 31 + z.charCodeAt(0)) >>> 0;
    return FARBEN[h % FARBEN.length];
  }
  function logo(el, name) {
    el.textContent = (name.trim()[0] || '?').toUpperCase();
    el.style.background = farbe(name);
  }
  const lies = key => { try { return localStorage.getItem('gutscheine.' + key); } catch { return null; } };
  const merke = (key, wert) => { try { localStorage.setItem('gutscheine.' + key, wert); } catch { /* egal */ } };

  // Wie steht es um den Gutschein? k: ok | bald | abgelaufen | archiv
  function lage(g) {
    if (g.status === 'archiv') {
      const eingeloest = g.verlauf.some(e => e.art === 'eingeloest');
      return { k: 'archiv', text: g.rest === 0 ? 'Aufgebraucht' : eingeloest && g.rest === null ? 'Eingelöst' : 'Im Archiv' };
    }
    if (!g.gueltigBis) return { k: 'ok', text: 'Ohne Ablaufdatum' };
    const t = tageBis(g.gueltigBis);
    if (t < 0) return { k: 'abgelaufen', text: 'Abgelaufen am ' + datum(g.gueltigBis) };
    if (t === 0) return { k: 'bald', text: 'Läuft heute ab' };
    if (t <= BALD_TAGE) return { k: 'bald', text: `Noch ${t} ${t === 1 ? 'Tag' : 'Tage'} gültig` };
    return { k: 'ok', text: 'Gültig bis ' + datum(g.gueltigBis) };
  }

  let meldungTimer = 0;
  function melde(text) {
    const m = $('meldung');
    m.textContent = text;
    m.classList.add('zeigt');
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(() => m.classList.remove('zeigt'), 2600);
  }

  function strichcodeSvg(code, art) {
    const key = art + '|' + code;
    if (!svgCache.has(key)) svgCache.set(key, B.svg(code, art).catch(() => null));
    return svgCache.get(key);
  }

  async function fotoUrl(id) {
    if (!fotoUrls.has(id)) {
      const blob = await D.foto(id);
      if (!blob) return '';   // ohne Internet noch nicht da → später nochmals versuchen
      fotoUrls.set(id, URL.createObjectURL(blob));
    }
    return fotoUrls.get(id);
  }
  function fotoGross(url) {
    $('foto-gross-bild').src = url;
    $('foto-gross').hidden = false;
  }

  async function neuLaden() { alle = await D.alle(); }

  // ---------- Navigation (mit dem Zurück des Handys) ----------
  function zeige(v, daten, ersetzen) {
    const st = Object.assign({ v }, daten);
    if (ersetzen) history.replaceState(st, ''); else history.pushState(st, '');
    rendere(st);
  }
  const zurueck = () => history.back();
  window.addEventListener('popstate', e => rendere(e.state || { v: 'liste' }));

  function rendere(st) {
    const v = st.v || 'liste';
    // Ohne freigeschaltetes Konto nur Anmelden bzw. «Fast geschafft» (auch mit der Zurück-Taste)
    if (zugang === 'abgemeldet' && v !== 'anmelden') return zeige('anmelden', {}, true);
    if (zugang === 'gesperrt' && v !== 'gesperrt') return zeige('gesperrt', {}, true);
    if (zugang === 'ok' && (v === 'anmelden' || v === 'gesperrt')) return zeige('liste', {}, true);
    const g = st.id ? alle.find(x => x.id === st.id) : null;
    if ((v === 'detail' || v === 'kasse') && !g) return zeige('liste', {}, true);
    if (v === 'formular' && !entwurf) return zeige('liste', {}, true);
    if (v !== 'scan') schliesseScanner();
    if (v !== 'kasse') schliesseKasse();
    $('dlg-einloesen').open && $('dlg-einloesen').close();
    $('foto-gross').hidden = true;

    const seite = v === 'scan' ? 'liste' : v === 'kasse' ? 'detail' : v;
    for (const id of ['anmelden', 'gesperrt', 'liste', 'formular', 'detail']) $(id).hidden = id !== seite;
    document.body.dataset.view = v;
    $('aktionen').hidden = seite !== 'liste';
    $('zurueck').hidden = ['liste', 'anmelden', 'gesperrt'].includes(seite);
    $('titel').textContent = seite === 'formular' ? (entwurf.id ? 'Bearbeiten' : 'Neuer Gutschein')
      : seite === 'detail' ? 'Gutschein' : 'Gutscheine';
    const neueSeite = seite !== (ansichtJetzt === 'scan' ? 'liste' : ansichtJetzt === 'kasse' ? 'detail' : ansichtJetzt);
    ansichtJetzt = v;

    if (seite === 'liste') zeigeListe();
    if (seite === 'formular') fuelleFormular();
    if (seite === 'detail') zeigeDetail(g);
    if (v === 'scan') oeffneScanner();
    if (v === 'kasse') oeffneKasse(g);
    if (neueSeite) window.scrollTo(0, 0);
  }

  // ---------- Liste ----------
  // Suche: Laden, Codes, Notiz, Rabatt, Betrag, Webseite. Gross/klein und Umlaute egal (füssli = fussli = fuessli), Codes auch
  // ohne Leerzeichen; mehrere Wörter = alle müssen vorkommen («orell 20»).
  const ohneAkzente = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  function passt(g, woerter) {
    const roh = [g.laden, g.code, g.onlineCode, g.notiz, g.rabatt, g.betrag === null || g.betrag === undefined ? '' : String(g.betrag), g.shop]
      .filter(Boolean).join(' ').toLowerCase();
    const text = [ohneAkzente(roh), roh.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'), roh.replace(/\s+/g, '')].join(' | ');
    return woerter.every(w => text.includes(w));
  }

  function zeigeListe() {
    const aktive = alle.filter(g => g.status !== 'archiv');
    const archiv = alle.filter(g => g.status === 'archiv');
    const nutzbar = aktive.filter(g => lage(g).k !== 'abgelaufen');
    const bald = aktive.filter(g => lage(g).k === 'bald').length;
    $('summe-betrag').textContent = chf(nutzbar.reduce((s, g) => s + (g.rest || 0), 0));
    $('summe-text').textContent = !aktive.length ? 'Noch keine Gutscheine'
      : [`${nutzbar.length} ${nutzbar.length === 1 ? 'Gutschein' : 'Gutscheine'}`,
        bald ? `${bald} ${bald === 1 ? 'läuft' : 'laufen'} bald ab` : ''].filter(Boolean).join(' · ');
    $('anzahl-aktiv').textContent = aktive.length || '';
    $('anzahl-archiv').textContent = archiv.length || '';
    $('reiter-aktiv').setAttribute('aria-selected', reiter === 'aktiv');
    $('reiter-archiv').setAttribute('aria-selected', reiter === 'archiv');

    $('suche-zeile').hidden = alle.length < SUCHE_AB;
    const woerter = $('suche-zeile').hidden ? [] : ohneAkzente($('suche').value.toLowerCase()).split(/\s+/).filter(Boolean);
    aktive.sort((a, b) => (a.gueltigBis || '9999').localeCompare(b.gueltigBis || '9999') || a.laden.localeCompare(b.laden, 'de'));
    archiv.sort((a, b) => (b.geaendert || '').localeCompare(a.geaendert || ''));
    // Beim Suchen beide Reiter: zuerst die aktiven, dann das Archiv (die Karte sagt «Eingelöst», «Im Archiv» …)
    const liste = woerter.length ? aktive.concat(archiv).filter(g => passt(g, woerter)) : reiter === 'aktiv' ? aktive : archiv;

    const box = $('karten');
    box.textContent = '';
    for (const g of liste) {
      const l = lage(g);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'karte lage-' + l.k;
      b.innerHTML = '<span class="logo"></span><span class="karte-text"><b></b><small></small></span>' +
        '<span class="karte-betrag"><b></b><small></small></span>';
      logo(b.querySelector('.logo'), g.laden);
      b.querySelector('.karte-text b').textContent = g.laden;
      b.querySelector('.karte-text small').textContent = l.text;
      b.querySelector('.karte-betrag b').textContent = g.art === 'rabatt' ? g.rabatt || 'Rabatt'
        : g.rest === null ? 'Gutschein' : chf(g.rest);
      b.querySelector('.karte-betrag small').textContent = g.nurOnline ? 'online'
        : g.betrag !== null && g.rest !== null && g.rest !== g.betrag ? 'von ' + chf(g.betrag) : g.onlineCode ? 'auch online' : '';
      b.addEventListener('click', () => zeige('detail', { id: g.id }));
      box.appendChild(b);
    }
    $('leer').hidden = liste.length > 0;
    $('leer-text').innerHTML = woerter.length ? 'Nichts gefunden – auch nicht im Archiv.'
      : reiter === 'archiv' ? 'Das Archiv ist leer.<br>Hier landen aufgebrauchte Gutscheine.'
        : !D.stand().vomServer && navigator.onLine !== false ? 'Die Gutscheine werden geladen …'
          : 'Noch keine Gutscheine.<br>Tippe auf «Gutschein scannen».';
  }

  // ---------- Kamera ----------
  let zoomStufen = null, zoomAn = false, lichtAn = false;
  let scanArt = '';            // 'code' = Strichcode / QR im Rahmen, liest von selbst · 'foto' = ganzes Bild, runder Auslöser
  let seiten = [];             // «Foto»: fotografierte Seiten (Blobs) des Gutscheins – Vorder-, Rückseite …
  let lesung = null;           // leseSeiten(): liest die ersten n Seiten schon, während man vielleicht weiter fotografiert
  let ohneKi = null;           // beim Warten auf die KI: «Selbst ausfüllen» gedrückt

  // Hinweis: bei «Strichcode / QR» unter dem Rahmen, bei «Foto» und beim Lesen oben neben «Abbrechen» (CSS zeigt den richtigen)
  function setzeHinweis(html) { $('scan-hinweis').innerHTML = $('scan-info').innerHTML = html; }
  function seitenHinweis() {
    if (!seiten.length) {
      return 'Ganzen Gutschein ins Bild nehmen – ' + (K.bereit() ? 'die KI füllt alles aus.' : 'ohne Internet nur Strichcode.');
    }
    return (seiten.length === 1 ? 'Seite 1 ist drin. Rückseite?' : `${seiten.length} Seiten sind drin. Noch eine?`) +
      ' Nochmals auslösen, sonst «Fertig».';
  }

  function zeigeScanArt(art) {
    scanArt = art;
    const foto = art === 'foto';
    $('scanner').classList.toggle('art-foto', foto);
    for (const b of $('scan-art').querySelectorAll('button')) b.setAttribute('aria-selected', b.dataset.art === art);
    setzeHinweis(foto ? seitenHinweis() : CODE_HINWEIS);
    if (foto && zoomAn) zoomUm();
    $('scan-zoom').hidden = foto || !zoomStufen;
    S.suchen(!foto);
  }

  // Die fotografierten Seiten unten links (letzte Seite als Bildchen, Anzahl) und «Fertig»
  function zeigeSeiten() {
    const n = seiten.length, img = $('scan-seiten').querySelector('img');
    if (img.src) URL.revokeObjectURL(img.src);
    if (n) img.src = URL.createObjectURL(seiten[n - 1]); else img.removeAttribute('src');
    $('scan-seiten').querySelector('b').textContent = n || '';
    $('scan-seiten').hidden = $('scan-fertig').hidden = !n;
    if (scanArt === 'foto' && !$('scanner').classList.contains('liest')) setzeHinweis(seitenHinweis());
  }

  function oeffneScanner() {
    $('scanner').hidden = false;
    $('scan-fehler').hidden = true;
    $('scanner').classList.remove('mit-fehler', 'liest', 'blitz');
    $('scan-ohne-ki').hidden = true;
    zeigeBild(null);
    $('scan-hinweis').hidden = false;
    $('scan-licht').hidden = $('scan-zoom').hidden = true;
    $('scan-knipsen').disabled = true;
    $('scan-rahmen').classList.remove('treffer');
    lichtAn = zoomAn = false;
    zoomStufen = null;
    // Zuletzt gewählte Art; beim ersten Mal «Foto» (liest alles), ohne Internet «Strichcode / QR»
    zeigeScanArt(scanArt || lies('scanart') || (K.bereit() ? 'foto' : 'code'));
    zeigeSeiten();   // nach einem App-Wechsel sind schon fotografierte Seiten noch da
    K.vorbereiten();
    S.starte($('video'), $('scan-rahmen'), {
      gefunden: t => {
        $('scan-rahmen').classList.add('treffer');
        if (navigator.vibrate) navigator.vibrate(60);
        setTimeout(() => {
          if (ansichtJetzt !== 'scan') return;
          entwurf = neuerEntwurf({ code: t.text, gelesen: t.format });
          zumFormular();
        }, 250);
      },
      fehler: e => scanFehler('Das Leseprogramm hatte einen Fehler (' + e.message + '). Du kannst ein Foto wählen oder die Nummer eintippen.'),
      faehig: f => {
        $('scan-licht').hidden = !f.licht;
        zoomStufen = f.zoom ? [f.zoom.min || 1, Math.min(2, f.zoom.max)] : null;
        $('scan-zoom').hidden = !zoomStufen || scanArt === 'foto';
      },
    }).then(() => { $('scan-knipsen').disabled = false; })
      .catch(e => scanFehler(kameraFehler(e)));
  }

  function schliesseScanner() {
    S.stop();
    $('scanner').hidden = true;
    zeigeBild(null);
    seiten = [];
    if (lesung) lesung.halt.abort();
    lesung = null;
    zeigeSeiten();
  }

  // Beim Lesen das Foto statt der Kamera zeigen
  function zeigeBild(blob) {
    const img = $('scan-bild');
    if (img.src) URL.revokeObjectURL(img.src);
    if (blob) img.src = URL.createObjectURL(blob); else img.removeAttribute('src');
    img.hidden = !blob;
  }

  function kameraFehler(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return 'Die Kamera ist nicht erlaubt. iPhone: Einstellungen → Apps → Safari → Kamera → «Erlauben». ' +
        'Android: in Chrome auf das Schloss neben der Adresse → Kamera erlauben. Oder: Foto wählen bzw. Nummer eintippen.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Keine Kamera gefunden. Du kannst ein Foto wählen oder die Nummer eintippen.';
    if (n === 'NotReadableError') return 'Die Kamera wird gerade von einer anderen App gebraucht. Diese schliessen und nochmals versuchen.';
    return 'Die Kamera startet nicht' + (e && e.message ? ' (' + e.message + ')' : '') + '. Du kannst ein Foto wählen oder die Nummer eintippen.';
  }

  function scanFehler(text) {
    S.stop();
    $('scan-fehler-text').textContent = text;
    $('scan-fehler').hidden = false;
    $('scanner').classList.add('mit-fehler');
    $('scan-hinweis').hidden = true;
  }

  $('scan-zu').addEventListener('click', zurueck);
  for (const b of $('scan-art').querySelectorAll('button')) {
    b.addEventListener('click', () => { merke('scanart', b.dataset.art); zeigeScanArt(b.dataset.art); });
  }
  $('scan-hand').addEventListener('click', () => { entwurf = neuerEntwurf({}); zeige('formular', {}, true); });
  $('scan-licht').addEventListener('click', () => {
    lichtAn = !lichtAn;
    S.licht(lichtAn).catch(() => { lichtAn = false; });
    $('scan-licht').classList.toggle('an', lichtAn);
  });
  function zoomUm() {
    zoomAn = !zoomAn;
    S.zoom(zoomStufen[zoomAn ? 1 : 0]).catch(() => {});
    $('scan-zoom').classList.toggle('an', zoomAn);
  }
  $('scan-zoom').addEventListener('click', zoomUm);
  // Gewählte Fotos (auch mehrere = mehrere Seiten): gleich lesen
  $('scan-foto').addEventListener('change', e => {
    const dateien = [...e.target.files];
    e.target.value = '';
    if (!dateien.length) return;
    seiten.push(...dateien);
    seitenFertig();
  });
  // Runder Auslöser: eine Seite mehr; lesen schon im Hintergrund – bei nur einer Seite ist «Fertig» dann gleich fertig
  $('scan-knipsen').addEventListener('click', async () => {
    let bild;
    try { bild = await S.standbild(); } catch (e) { return melde(e.message); }
    $('scanner').classList.remove('blitz');
    void $('scanner').offsetWidth;   // Blitz nochmals abspielen
    $('scanner').classList.add('blitz');
    seiten.push(bild);
    zeigeSeiten();
    if (lesung) lesung.halt.abort();   // die KI-Anfrage mit weniger Seiten braucht es nicht mehr
    lesung = leseSeiten(seiten.slice());
  });
  $('scan-fertig').addEventListener('click', seitenFertig);
  $('scan-ohne-ki').addEventListener('click', () => { if (ohneKi) ohneKi(); });

  // Jede Seite nur einmal verkleinern und nach Strichcodes durchsuchen
  const kleinVon = new WeakMap(), strichcodeVon = new WeakMap();
  const einmal = (karte, b, fn) => { if (!karte.has(b)) karte.set(b, fn(b)); return karte.get(b); };

  // Seiten lesen: Strichcode (erste Seite mit einem) und – falls eingerichtet – die KI mit allen Seiten zusammen
  function leseSeiten(liste) {
    const halt = new AbortController();
    const klein = Promise.all(liste.map(b => einmal(kleinVon, b, x => S.verkleinern(x, FOTO_MAX).catch(() => x))));
    const strich = (async () => {
      for (const b of liste) {
        const t = await einmal(strichcodeVon, b, x => S.fotoLesen(x).catch(() => null));
        if (t) return t;
      }
      return null;
    })();
    // Die KI bekommt die Fotos in voller Grösse (ki.js macht daraus das ganze Bild und vier Ausschnitte)
    const ki = K.bereit() ? K.lesen(liste, halt.signal).then(x => ({ x }), e => ({ fehler: (e && e.message) || String(e) })) : Promise.resolve({});
    return { n: liste.length, halt, strich, klein, ki };
  }

  // «Fertig» oder Fotos gewählt: alle Seiten lesen, dann ins Formular (mit allen Seiten als Fotos)
  async function seitenFertig() {
    if (!seiten.length) return;
    const liste = seiten.slice();
    S.stop();
    $('scanner').classList.add('liest');
    zeigeBild(liste[0]);
    const kiLiest = K.bereit();
    setzeHinweis(kiLiest ? 'Die KI liest den Gutschein …' : 'Foto wird gelesen …');
    if (!lesung || lesung.n !== liste.length) {
      if (lesung) lesung.halt.abort();
      lesung = leseSeiten(liste);
    }
    // Braucht die KI länger als sonst: Sekunden zeigen und «Selbst ausfüllen» anbieten
    const l = lesung, start = Date.now();
    const uhr = setInterval(() => {
      if (!kiLiest || Date.now() - start < K.zeit.geduld) return;
      setzeHinweis(`Die KI braucht länger als sonst … ${Math.round((Date.now() - start) / 1000)}&nbsp;s`);
      $('scan-ohne-ki').hidden = false;
    }, 1000);
    const selbst = new Promise(ok => { ohneKi = () => ok({ selbst: true }); });
    const [t, klein, antwort] = await Promise.all([l.strich, l.klein, Promise.race([l.ki, selbst])]);
    clearInterval(uhr);
    ohneKi = null;
    $('scan-ohne-ki').hidden = true;
    if (antwort.selbst) l.halt.abort();
    const k = antwort.x || null, kiFehler = antwort.fehler || '';
    if (ansichtJetzt !== 'scan') return;
    entwurf = neuerEntwurf(t ? { code: t.text, gelesen: t.format } : {});
    if (k) kiUebernehmen(entwurf, k);
    for (const b of klein) entwurf.fotos.push({ blob: b, url: URL.createObjectURL(b) });
    if (kiFehler) console.warn('KI:', kiFehler);
    if (!await zumFormular()) return;
    if (k && entwurf.code) return;   // das Formular sagt oben schon «Die KI hat das Foto gelesen»
    melde(k ? 'Kein Code gefunden – bitte eintippen'
      : kiFehler ? 'Die KI hat nicht geantwortet – bitte selbst ausfüllen'
        : t ? 'Code auf dem Foto gefunden' : 'Kein Code auf dem Foto gefunden – bitte die Nummer eintippen');
  }

  // Was die KI gelesen hat, ins Formular; ein gescannter Strichcode bleibt (der ist genauer)
  function kiUebernehmen(e, k) {
    e.ki = true;
    // Welches Modell genau gelesen hat (Wunsch 2026-10-31); «Schnellmodus» = die Reserve-Anfrage mit kaum Nachdenken
    e.kiModell = (k.modell || 'Gemini') + (k.reserve ? ', Schnellmodus' : '');
    if (k.laden) e.laden = k.laden;
    e.art = k.art;
    if (k.art === 'wert') {
      const b = betragLesen(k.betrag);
      if (b) e.betrag = e.rest = b;
    } else e.rabatt = k.rabatt;
    e.nurOnline = k.nurOnline;
    e.shop = k.shop;
    if (k.gueltigBis) e.gueltigBis = k.gueltigBis;
    // Neu erfasst und schon abgelaufen? Meist hat die KI die Jahreszahl falsch gelesen (Tchibo, Bergzeit 2026-10-30) → Hinweis
    e.datumPruefen = !!k.gueltigBis && tageBis(k.gueltigBis) < 0;
    if (k.pin) e.pin = k.pin;
    if (k.bedingungen) e.notiz = k.bedingungen;
    if (!e.gelesen && k.code) {
      e.code = k.code;
      e.format = k.nurOnline ? '' : B.vorschlag(k.code);
    }
    // Eigener Code für den Webshop, z. B. Orell Füssli: Strichcode (Ziffern) für die Kasse, gedruckter Code für online.
    // Sieht die KI ihn nicht als eigenen Code, aber ihr Code hat Buchstaben und der gescannte Strichcode nur Ziffern: derselbe Fall.
    let online = k.onlineCode;
    if (!online && e.gelesen && k.code && /^\d+$/.test(e.code) && /[A-Za-z]/.test(k.code)) online = k.code;
    if (online && online !== e.code && !k.nurOnline) {
      e.onlineCode = online;
      e.onlineFeld = true;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (ansichtJetzt !== 'scan' || !$('scan-fehler').hidden) return;
    if (document.hidden) S.stop(); else oeffneScanner();
  });

  // ---------- Schon erfasst? ----------
  // Gleicher Code oder Code für online (ohne Leerzeichen, gross/klein egal, auch im Archiv) → der vorhandene Gutschein
  const codeSchluessel = c => (c || '').replace(/\s+/g, '').toUpperCase();
  function gleicherGutschein(code, onlineCode, ausserId) {
    const neu = [code, onlineCode].map(codeSchluessel).filter(c => c.length >= 4);
    if (!neu.length) return null;
    return alle.find(g => g.id !== ausserId && [g.code, g.onlineCode].map(codeSchluessel).some(c => neu.includes(c))) || null;
  }
  const schonText = g => `«${g.laden}» mit diesem Code ist schon ${g.status === 'archiv' ? 'im Archiv' : 'in der Liste'} ` +
    `(${lage(g).text}).`;

  // Nach dem Scannen ins Formular – ist der Gutschein schon erfasst, zuerst fragen (Wunsch 2026-10-30);
  // «Zum vorhandenen» zeigt diesen statt des Formulars. false = nicht ins Formular.
  async function zumFormular() {
    const da = gleicherGutschein(entwurf.code, entwurf.onlineCode);
    if (da) {
      const nochmals = await frage('Schon erfasst', schonText(da) + ' Nochmals erfassen?', 'Nochmals erfassen', false, 'Zum vorhandenen');
      if (ansichtJetzt !== 'scan') return false;
      if (!nochmals) {
        entwurf = null;
        zeige('detail', { id: da.id }, true);
        return false;
      }
      entwurf.nochmals = da.id;   // beim Speichern nicht nochmals fragen
    }
    zeige('formular', {}, true);
    return true;
  }

  // ---------- Formular ----------
  function neuerEntwurf(von) {
    const code = (von.code || '').trim();
    return {
      id: null, laden: '', art: 'wert', betrag: null, rest: null, rabatt: '', gueltigBis: '', pin: '', notiz: '', fotos: [],
      nurOnline: false, shop: '', onlineCode: '', onlineFeld: false, ki: false,
      code, gelesen: von.gelesen || '', format: von.gelesen ? B.zeichenbar(von.gelesen) : B.vorschlag(code), formatGewaehlt: false,
    };
  }
  function entwurfVon(g) {
    return {
      id: g.id, laden: g.laden, art: g.art || 'wert', betrag: g.betrag, rest: g.rest, rabatt: g.rabatt || '', gueltigBis: g.gueltigBis,
      pin: g.pin, notiz: g.notiz, code: g.code, nurOnline: !!g.nurOnline, shop: g.shop || '', ki: false,
      onlineCode: g.onlineCode || '', onlineFeld: !!g.onlineCode,
      format: g.format, gelesen: '', formatGewaehlt: true, fotos: (g.fotos || []).map(id => ({ id })),
    };
  }

  const zahlText = n => (n === null || n === undefined ? '' : n.toFixed(2).replace(/\.00$/, ''));

  function fuelleFormular() {
    const e = entwurf;
    $('f-laden').value = e.laden;
    $('f-betrag').value = zahlText(e.betrag);
    $('f-rest').value = e.rest !== null && e.rest !== e.betrag ? zahlText(e.rest) : '';
    $('f-rabatt').value = e.rabatt;
    $('f-bis').value = e.gueltigBis;
    $('f-bis').classList.toggle('pruefen', !!e.datumPruefen);
    $('f-bis-hinweis').hidden = !e.datumPruefen;
    $('f-code').value = e.code;
    $('f-pin').value = e.pin;
    $('f-notiz').value = e.notiz;
    $('f-online').checked = e.nurOnline;
    $('f-shop').value = e.shop;
    $('f-online-code').value = e.onlineCode;
    $('f-ki').hidden = !e.ki;
    $('f-ki').textContent = `Die KI (Google ${e.kiModell || 'Gemini'}) hat das Foto gelesen. Bitte prüfen.`;
    zeigeArt(e.art);
    zeigeOnlineFelder();
    const sel = $('f-format');
    sel.textContent = '';
    sel.add(new Option('Kein Strichcode (nur Nummer)', ''));
    for (const [k, name] of Object.entries(B.ARTEN)) sel.add(new Option(name, k));
    sel.value = e.format;
    $('f-gelesen').textContent = !e.gelesen ? ''
      : B.genau(e.gelesen) ? 'Gescannt: ' + (B.ARTEN[B.zeichenbar(e.gelesen)] || e.gelesen)
        : `Gescannt als ${e.gelesen}. Gezeigt wird er als Code 128 – liest die Kasse ihn nicht, die Nummer eintippen lassen.`;
    $('f-fehler').hidden = true;
    $('f-speichern').disabled = false;
    zeigeFormFotos();
    vorschauBald(0);
  }

  let vorschauTimer = 0;
  function vorschauBald(ms) {
    clearTimeout(vorschauTimer);
    vorschauTimer = setTimeout(async () => {
      const code = $('f-code').value.trim(), art = $('f-format').value;
      const box = $('f-vorschau');
      box.hidden = !code || !art;
      if (box.hidden) return;
      const s = await strichcodeSvg(code, art);
      if (code !== $('f-code').value.trim() || art !== $('f-format').value) return;
      $('f-strichcode').classList.toggle('flaechig', B.flaechig(art));
      if (s) $('f-strichcode').innerHTML = s;
      else $('f-strichcode').innerHTML = '<p class="fehler">Diese Nummer lässt sich so nicht zeichnen – eine andere Art wählen.</p>';
    }, ms);
  }
  $('f-code').addEventListener('input', () => {
    if (!entwurf.formatGewaehlt && !entwurf.gelesen) $('f-format').value = $('f-online').checked ? '' : B.vorschlag($('f-code').value);
    vorschauBald(250);
  });
  $('f-format').addEventListener('change', () => { entwurf.formatGewaehlt = true; vorschauBald(0); });
  // Datum angepasst (oder bewusst so gelassen und geändert): kein Hinweis mehr
  for (const ereignis of ['input', 'change']) {   // Safari meldet beim Datum nicht immer beides
    $('f-bis').addEventListener(ereignis, () => {
      entwurf.datumPruefen = false;
      $('f-bis').classList.remove('pruefen');
      $('f-bis-hinweis').hidden = true;
    });
  }

  // Guthaben in Franken oder Rabatt (Prozent, «CHF 10 ab 50» …): andere Felder
  function zeigeArt(art) {
    entwurf.art = art;
    for (const b of $('f-art').querySelectorAll('button')) b.setAttribute('aria-selected', b.dataset.art === art);
    $('f-wert').hidden = art !== 'wert';
    $('f-rabatt-feld').hidden = art !== 'rabatt';
  }
  for (const b of $('f-art').querySelectorAll('button')) b.addEventListener('click', () => zeigeArt(b.dataset.art));
  // «Code für online» nur, wenn es einen gibt oder man ihn hinzufügt – bei «Nur online» ist der Code selbst der Online-Code.
  // Die Webseite zum Einlösen braucht es in beiden Fällen.
  function zeigeOnlineFelder() {
    const nur = $('f-online').checked;
    $('f-online-code-feld').hidden = nur || !entwurf.onlineFeld;
    $('f-online-code-neu').hidden = nur || entwurf.onlineFeld;
    $('f-shop-feld').hidden = !nur && !entwurf.onlineFeld;
  }
  $('f-online-code-neu').addEventListener('click', () => {
    entwurf.onlineFeld = true;
    zeigeOnlineFelder();
    $('f-online-code').focus();
  });
  // Nur online: Webseite statt Strichcode an der Kasse
  $('f-online').addEventListener('change', () => {
    const on = $('f-online').checked;
    zeigeOnlineFelder();
    if (!entwurf.formatGewaehlt && !entwurf.gelesen) {
      $('f-format').value = on ? '' : B.vorschlag($('f-code').value);
      vorschauBald(0);
    }
  });

  async function zeigeFormFotos() {
    const box = $('f-fotos');
    box.textContent = '';
    for (const f of entwurf.fotos) {
      const d = document.createElement('div');
      d.className = 'foto';
      d.innerHTML = '<img alt="Foto vom Gutschein"><button type="button" class="foto-weg" aria-label="Foto entfernen">×</button>';
      d.querySelector('img').src = f.url || await fotoUrl(f.id);
      d.querySelector('img').addEventListener('click', () => fotoGross(d.querySelector('img').src));
      d.querySelector('.foto-weg').addEventListener('click', () => {
        entwurf.fotos.splice(entwurf.fotos.indexOf(f), 1);
        zeigeFormFotos();
      });
      box.appendChild(d);
    }
  }
  $('f-foto-neu').addEventListener('change', async e => {
    const datei = e.target.files[0];
    e.target.value = '';
    if (!datei) return;
    const klein = await S.verkleinern(datei, FOTO_MAX).catch(() => null);
    if (!klein) return melde('Das Foto lässt sich nicht öffnen');
    entwurf.fotos.push({ blob: klein, url: URL.createObjectURL(klein) });
    zeigeFormFotos();
  });

  function formFehler(text, feld) {
    $('f-fehler').textContent = text;
    $('f-fehler').hidden = false;
    if (feld) $(feld).focus();
  }

  $('form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const laden = $('f-laden').value.trim();
    const art = entwurf.art;
    const betrag = art === 'wert' ? betragLesen($('f-betrag').value) : null;
    const restEin = art === 'wert' ? betragLesen($('f-rest').value) : null;
    const nurOnline = $('f-online').checked;
    const onlineCode = nurOnline ? '' : $('f-online-code').value.trim();
    let shop = nurOnline || onlineCode ? $('f-shop').value.trim() : '';
    if (shop && !/^https?:\/\//i.test(shop)) shop = 'https://' + shop;
    if (!laden) return formFehler('Bitte den Laden oder Anbieter eintragen.', 'f-laden');
    if (betrag === false) return formFehler('Den Wert bitte als Zahl eintragen, z. B. 50 oder 25.50.', 'f-betrag');
    if (restEin === false) return formFehler('«Noch übrig» bitte als Zahl eintragen, z. B. 30 oder 12.50.', 'f-rest');
    const rest = restEin === null ? betrag : restEin;
    if (betrag !== null && rest > betrag) return formFehler('«Noch übrig» ist grösser als der Wert.', 'f-rest');
    if (shop && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(shop)) return formFehler('Die Webseite bitte so eintragen: www.laden.ch', 'f-shop');
    // Neu und von Hand eingetippt (oder Code geändert): schon erfasst? «Abbrechen» bleibt im Formular
    if (!entwurf.id) {
      const da = gleicherGutschein($('f-code').value, onlineCode);
      if (da && entwurf.nochmals !== da.id && !await frage('Schon erfasst', schonText(da) + ' Trotzdem speichern?', 'Trotzdem speichern')) return;
    }

    $('f-speichern').disabled = true;
    try {
      const jetzt = new Date().toISOString();
      const alt = entwurf.id ? alle.find(x => x.id === entwurf.id) : null;
      const g = alt ? Object.assign({}, alt, { verlauf: alt.verlauf.slice() })
        : { id: D.neueId(), status: 'aktiv', erstellt: jetzt,
          verlauf: [Object.assign({ datum: jetzt, art: 'erfasst', betrag, rest }, entwurf.ki ? { ki: entwurf.kiModell } : {})] };
      if (alt && alt.rest !== rest) g.verlauf.push({ datum: jetzt, art: 'korrigiert', rest });
      Object.assign(g, {
        laden, art, betrag, rest, rabatt: art === 'rabatt' ? $('f-rabatt').value.trim() : '', nurOnline, shop, onlineCode,
        gueltigBis: $('f-bis').value || '', code: $('f-code').value.trim(), format: $('f-format').value,
        pin: $('f-pin').value.trim(), notiz: $('f-notiz').value.trim(), geaendert: jetzt,
      });
      const ids = [];
      for (const f of entwurf.fotos) ids.push(f.id || await D.fotoSpeichern(f.blob));
      if (alt) for (const id of alt.fotos || []) if (!ids.includes(id)) await D.fotoLoeschen(id);
      g.fotos = ids;
      await D.speichern(g);
      await neuLaden();
      const warNeu = !alt;
      entwurf = null;
      if (warNeu) zeige('detail', { id: g.id }, true); else zurueck();
      melde('Gespeichert');
    } catch (e) {
      $('f-speichern').disabled = false;
      formFehler('Speichern ging nicht: ' + ((e && e.message) || e));
    }
  });
  $('f-abbrechen').addEventListener('click', zurueck);

  // ---------- Ein Gutschein ----------
  async function zeigeDetail(g) {
    detailStand = g.geaendert;
    const l = lage(g);
    logo($('d-logo'), g.laden);
    $('d-laden').textContent = g.laden;
    $('d-lage').textContent = l.text;
    $('d-lage').className = 'lage lage-' + l.k;
    const rabatt = g.art === 'rabatt';
    $('d-rest').textContent = rabatt ? g.rabatt || 'Rabatt' : g.rest === null ? 'Gutschein' : chf(g.rest);
    $('d-von').textContent = (rabatt ? 'Rabatt' : g.betrag === null ? 'ohne Betrag'
      : g.rest !== g.betrag ? 'noch übrig von ' + chf(g.betrag) : 'noch übrig') + (g.nurOnline ? ' · nur online einlösbar' : '');

    $('d-code-karte').hidden = !g.code;
    $('d-code').textContent = codeZeigen(g.code || '');
    $('d-strichcode').textContent = '';
    $('d-strichcode').classList.toggle('flaechig', B.flaechig(g.format));
    $('d-code-tipp').textContent = g.format ? 'Antippen: gross zeigen für die Kasse'
      : g.nurOnline ? 'Antippen: Code kopieren' : 'Antippen: Nummer gross zeigen';
    if (g.code && g.format) {
      strichcodeSvg(g.code, g.format).then(s => {
        if (s && ansichtJetzt !== 'liste' && $('d-laden').textContent === g.laden) $('d-strichcode').innerHTML = s;
      });
    }
    // Eigener Code für den Webshop: eigene Karte (antippen = kopieren), der Knopf kopiert dann ausdrücklich die Kassen-Nummer
    $('d-online-karte').hidden = !g.onlineCode;
    $('d-online-code').textContent = g.onlineCode || '';
    $('d-kopieren').hidden = !g.code;
    $('d-kopieren').textContent = g.onlineCode ? 'Kassen-Nummer kopieren' : 'Code kopieren';
    $('d-pin').hidden = !g.pin;
    $('d-pin').textContent = 'PIN zeigen';
    const link = /^https?:\/\//i.test(g.code || '');
    $('d-link').hidden = !link;
    if (link) $('d-link').href = g.code; else $('d-link').removeAttribute('href');
    $('d-shop').hidden = !g.shop;
    if (g.shop) $('d-shop').href = g.shop; else $('d-shop').removeAttribute('href');

    const archiv = g.status === 'archiv';
    $('d-einloesen').hidden = archiv;
    $('d-einloesen').textContent = g.rest === null ? 'Eingelöst' : 'Betrag eingelöst';
    $('d-archiv').textContent = archiv ? 'Wieder aktiv' : 'Ins Archiv';

    $('d-notiz').textContent = g.notiz || '';
    $('d-notiz').hidden = !g.notiz;

    const v = $('d-verlauf');
    v.textContent = '';
    for (const e of g.verlauf.slice().reverse()) {
      const li = document.createElement('li');
      const wann = new Date(e.datum).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const was = e.art === 'erfasst' ? 'Erfasst' + (e.betrag !== null && e.betrag !== undefined ? ', Wert ' + chf(e.betrag)
        : g.art === 'rabatt' && g.rabatt ? ', ' + g.rabatt : '') + (e.ki ? ' · gelesen von ' + e.ki : '')
        : e.art === 'eingeloest' ? (e.betrag ? `${chf(e.betrag)} eingelöst, noch ${chf(e.rest)}` : 'Eingelöst')
          : e.art === 'korrigiert' ? 'Restguthaben geändert' + (e.rest !== null ? ' auf ' + chf(e.rest) : '')
            : e.art === 'archiv' ? 'Ins Archiv gelegt' : 'Wieder aktiv';
      li.innerHTML = '<small></small><span></span>';
      li.querySelector('small').textContent = wann;
      li.querySelector('span').textContent = was;
      v.appendChild(li);
    }

    const box = $('d-fotos');
    box.textContent = '';
    for (const id of g.fotos || []) {
      const url = await fotoUrl(id);
      if (!url) continue;
      const img = document.createElement('img');
      img.className = 'foto';
      img.alt = 'Foto vom Gutschein';
      img.src = url;
      img.addEventListener('click', () => fotoGross(url));
      box.appendChild(img);
    }
  }

  const jetztG = () => alle.find(x => x.id === (history.state && history.state.id));

  async function kopiere(text, meldung) {
    try {
      await navigator.clipboard.writeText(text);
      melde(meldung);
    } catch {
      melde('Kopieren geht hier nicht');
    }
  }
  // Online-Code ohne Strichcode: an der Kasse braucht ihn niemand – antippen kopiert ihn
  $('d-code-karte').addEventListener('click', () => {
    const g = jetztG();
    if (g.nurOnline && !g.format) kopiere(g.code, 'Code kopiert'); else zeige('kasse', { id: g.id });
  });
  $('d-kopieren').addEventListener('click', () => {
    const g = jetztG();
    kopiere(g.code, g.onlineCode ? 'Kassen-Nummer kopiert' : 'Code kopiert');
  });
  $('d-online-karte').addEventListener('click', () => kopiere(jetztG().onlineCode, 'Code für online kopiert'));
  $('d-pin').addEventListener('click', () => {
    const b = $('d-pin');
    b.textContent = b.textContent === 'PIN zeigen' ? 'PIN: ' + jetztG().pin : 'PIN zeigen';
  });
  $('d-bearbeiten').addEventListener('click', () => { entwurf = entwurfVon(jetztG()); zeige('formular', { id: jetztG().id }); });

  async function aendern(g, eintrag, meldung) {
    g.verlauf = g.verlauf.concat(Object.assign({ datum: new Date().toISOString() }, eintrag));
    g.geaendert = new Date().toISOString();
    await D.speichern(g);
    await neuLaden();
    zeigeDetail(alle.find(x => x.id === g.id));
    if (meldung) melde(meldung);
  }

  $('d-archiv').addEventListener('click', async () => {
    const g = Object.assign({}, jetztG());
    g.status = g.status === 'archiv' ? 'aktiv' : 'archiv';
    await aendern(g, { art: g.status }, g.status === 'archiv' ? 'Ins Archiv gelegt' : 'Wieder aktiv');
  });

  $('d-loeschen').addEventListener('click', async () => {
    const g = jetztG();
    if (!await frage(`«${g.laden}» löschen?`, 'Der Gutschein und seine Fotos sind dann weg. Das lässt sich nicht rückgängig machen.', 'Löschen', true)) return;
    for (const id of g.fotos || []) await D.fotoLoeschen(id);
    await D.loeschen(g.id);
    await neuLaden();
    zurueck();
    melde('Gelöscht');
  });

  // Eingelöst: Betrag abziehen; bei 0 ins Archiv
  $('d-einloesen').addEventListener('click', async () => {
    const g = Object.assign({}, jetztG());
    if (g.rest === null) {
      if (!await frage('Gutschein eingelöst?', 'Er kommt dann ins Archiv.', 'Eingelöst')) return;
      g.status = 'archiv';
      return aendern(g, { art: 'eingeloest' }, 'Eingelöst – liegt jetzt im Archiv');
    }
    $('e-info').textContent = 'Noch übrig: ' + chf(g.rest);
    $('e-betrag').value = '';
    $('e-alles').textContent = 'Alles (' + chf(g.rest) + ')';
    $('e-fehler').hidden = true;
    $('dlg-einloesen').showModal();
    $('e-betrag').focus();
  });
  $('e-alles').addEventListener('click', () => { $('e-betrag').value = zahlText(jetztG().rest); });
  $('e-abbrechen').addEventListener('click', () => $('dlg-einloesen').close());
  $('e-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const g = Object.assign({}, jetztG());
    const x = betragLesen($('e-betrag').value);
    const fehler = !x ? 'Bitte den Betrag eintragen, z. B. 20 oder 12.50.'
      : x > g.rest + 0.001 ? `Das ist mehr, als noch übrig ist (${chf(g.rest)}).` : '';
    if (fehler) {
      $('e-fehler').textContent = fehler;
      $('e-fehler').hidden = false;
      return;
    }
    $('dlg-einloesen').close();
    g.rest = gerundet(Math.max(0, g.rest - x));
    if (g.rest === 0) g.status = 'archiv';
    await aendern(g, { art: 'eingeloest', betrag: x, rest: g.rest },
      g.rest === 0 ? 'Aufgebraucht – liegt jetzt im Archiv' : 'Noch übrig: ' + chf(g.rest));
  });

  // Frage mit zwei Knöpfen → true bei «ja»
  function frage(titel, text, ja, gefahr, nein) {
    const d = $('dlg-frage');
    $('q-titel').textContent = titel;
    $('q-text').textContent = text;
    $('q-ja').textContent = ja;
    $('q-nein').textContent = nein || 'Abbrechen';
    $('q-ja').className = 'knopf' + (gefahr ? ' gefahr' : '');
    d.returnValue = '';
    d.showModal();
    return new Promise(ok => d.addEventListener('close', () => ok(d.returnValue === 'ja'), { once: true }));
  }

  // ---------- An der Kasse ----------
  async function oeffneKasse(g) {
    $('kasse').hidden = false;
    $('k-laden').textContent = g.laden;
    $('k-code').textContent = codeZeigen(g.code || '');
    $('k-code').classList.toggle('allein', !g.format);
    $('k-pin').hidden = !g.pin;
    $('k-pin').textContent = 'PIN ' + (g.pin || '');
    $('k-rest').textContent = g.art === 'rabatt' ? g.rabatt || '' : g.rest === null ? '' : 'Noch übrig: ' + chf(g.rest);
    const box = $('k-strichcode');
    box.textContent = '';
    box.className = 'kasse-code' + (B.flaechig(g.format) ? ' flaechig' : '');
    box.hidden = !g.format;
    if (g.format) {
      const s = await strichcodeSvg(g.code, g.format);
      if (ansichtJetzt === 'kasse') box.innerHTML = s || '<p class="fehler">Der Strichcode lässt sich nicht zeichnen – die Nummer zeigen.</p>';
    }
    try {
      if ('wakeLock' in navigator && !sperre) sperre = await navigator.wakeLock.request('screen');
    } catch { sperre = null; }
  }
  function schliesseKasse() {
    $('kasse').hidden = true;
    if (sperre) { sperre.release().catch(() => {}); sperre = null; }
  }
  $('k-zu').addEventListener('click', zurueck);
  $('kasse').addEventListener('click', e => { if (e.target === $('kasse')) zurueck(); });

  // ---------- Liste: Knöpfe ----------
  $('neu-scannen').addEventListener('click', () => zeige('scan'));
  $('neu-hand').addEventListener('click', () => { entwurf = neuerEntwurf({}); zeige('formular'); });
  $('reiter-aktiv').addEventListener('click', () => { reiter = 'aktiv'; zeigeListe(); });
  $('reiter-archiv').addEventListener('click', () => { reiter = 'archiv'; zeigeListe(); });
  $('suche').addEventListener('input', zeigeListe);
  // Suchmodus, solange das Feld angetippt ist oder Text drin hat (CSS blendet Guthaben, Reiter und Knöpfe unten aus, das Feld steht
  // oben). «Abbrechen» und Esc leeren die Suche und schliessen die Tastatur; Enter schliesst nur die Tastatur, die Treffer bleiben.
  const suchModus = () => document.body.classList.toggle('sucht', document.activeElement === $('suche') || !!$('suche').value);
  function sucheZu() {
    $('suche').value = '';
    $('suche').blur();
    suchModus();
    zeigeListe();
  }
  $('suche').addEventListener('focus', () => { suchModus(); window.scrollTo(0, 0); });
  $('suche').addEventListener('blur', suchModus);
  $('suche').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('suche').blur();
    else if (e.key === 'Escape') sucheZu();
  });
  // Den Knopf antippen soll das Feld nicht vorher verlassen (sonst verschwindet er, bevor er gedrückt ist)
  for (const ereignis of ['pointerdown', 'mousedown']) $('suche-zu').addEventListener(ereignis, e => e.preventDefault());
  $('suche-zu').addEventListener('click', sucheZu);
  $('zurueck').addEventListener('click', zurueck);
  // Foto gross: «‹ Zurück» oder irgendwo antippen schliesst es
  $('foto-gross').addEventListener('click', () => { $('foto-gross').hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('foto-gross').hidden) $('foto-gross').hidden = true;
    else if (e.key === 'Escape' && (ansichtJetzt === 'scan' || ansichtJetzt === 'kasse')) zurueck();
  });

  // ---------- Als App auf den Home-Bildschirm ----------
  const istIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const alsApp = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function zeigeTipp() {
    if (alsApp || lies('tipp-weg')) return;
    if (istIOS) {
      $('tipp-text').textContent = 'Tipp: In Safari auf «Teilen» und dann «Zum Home-Bildschirm». So ist die App wie eine richtige App da – ' +
        'und Safari räumt die Gutscheine nicht weg, wenn du sie länger nicht öffnest.';
    } else if (installEvent) {
      $('tipp-text').textContent = 'Tipp: Als App installieren – dann ist sie wie eine richtige App auf dem Handy.';
      $('tipp-installieren').hidden = false;
    } else return;
    $('tipp').hidden = false;
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; zeigeTipp(); });
  $('tipp-installieren').addEventListener('click', () => { installEvent.prompt(); $('tipp').hidden = true; });
  $('tipp-zu').addEventListener('click', () => { merke('tipp-weg', '1'); $('tipp').hidden = true; });

  // ---------- Offline und neue Versionen ----------
  if ('serviceWorker' in navigator && window.BUILD !== 'dev') {
    const hatteSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hatteSW) return;
      // Neue Version: neu laden, aber nicht mitten im Erfassen oder an der Kasse
      if (ansichtJetzt === 'liste') location.reload();
      else window.addEventListener('popstate', () => { if (ansichtJetzt === 'liste') location.reload(); });
    });
  }

  // ---------- Anmelden ----------
  let neuesKonto = false;
  const KONTO_FEHLER = {
    'auth/invalid-email': 'Diese E-Mail-Adresse stimmt so nicht.',
    'auth/invalid-credential': 'E-Mail oder Passwort stimmt nicht.',
    'auth/wrong-password': 'E-Mail oder Passwort stimmt nicht.',
    'auth/user-not-found': 'E-Mail oder Passwort stimmt nicht.',
    'auth/email-already-in-use': 'Für diese E-Mail gibt es schon ein Konto – bitte anmelden.',
    'auth/weak-password': 'Das Passwort braucht mindestens 8 Zeichen.',
    'auth/missing-password': 'Bitte das Passwort eintragen.',
    'auth/network-request-failed': 'Keine Verbindung. Zum Anmelden braucht es Internet.',
    'auth/too-many-requests': 'Zu viele Versuche. Bitte in ein paar Minuten nochmals.',
    'auth/user-disabled': 'Dieses Konto ist gesperrt.',
  };
  const kontoFehler = e => KONTO_FEHLER[e && e.code] || 'Das ging nicht (' + ((e && (e.code || e.message)) || e) + ').';

  function anmeldeArt(neu) {
    neuesKonto = neu;
    $('a-titel').textContent = neu ? 'Neues Konto' : 'Anmelden';
    $('a-text').textContent = neu ? 'Jede Person bekommt ein eigenes Konto – beide sehen dieselbe Liste.'
      : 'Eure gemeinsame Gutschein-Liste. Einmal anmelden – danach bleibt dieses Handy angemeldet.';
    $('a-pw-titel').textContent = neu ? 'Passwort (mindestens 8 Zeichen)' : 'Passwort';
    $('a-passwort').autocomplete = neu ? 'new-password' : 'current-password';
    $('a-los').textContent = neu ? 'Konto erstellen' : 'Anmelden';
    $('a-wechsel').textContent = neu ? 'Ich habe schon ein Konto' : 'Neues Konto erstellen';
    $('a-vergessen').hidden = neu;
    $('a-fehler').hidden = $('a-info').hidden = true;
  }
  function anmeldeFehler(text) {
    $('a-fehler').textContent = text;
    $('a-fehler').hidden = false;
    $('a-info').hidden = true;
  }
  $('a-wechsel').addEventListener('click', () => anmeldeArt(!neuesKonto));
  $('a-zeigen').addEventListener('change', () => { $('a-passwort').type = $('a-zeigen').checked ? 'text' : 'password'; });
  $('a-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const email = $('a-email').value.trim(), passwort = $('a-passwort').value;
    if (!email) return anmeldeFehler('Bitte die E-Mail-Adresse eintragen.');
    if (!passwort) return anmeldeFehler('Bitte das Passwort eintragen.');
    if (neuesKonto && passwort.length < 8) return anmeldeFehler('Das Passwort braucht mindestens 8 Zeichen.');
    $('a-los').disabled = true;
    $('a-fehler').hidden = $('a-info').hidden = true;
    try {
      await (neuesKonto ? D.registrieren(email, passwort) : D.anmelden(email, passwort));
      $('a-passwort').value = '';   // weiter geht es in D.konto (unten)
    } catch (e) {
      anmeldeFehler(kontoFehler(e));
    } finally {
      $('a-los').disabled = false;
    }
  });
  $('a-vergessen').addEventListener('click', async () => {
    const email = $('a-email').value.trim();
    if (!email) return anmeldeFehler('Zuerst oben die E-Mail-Adresse eintragen.');
    try {
      await D.passwortVergessen(email);
      $('a-info').textContent = `Falls es für ${email} ein Konto gibt, kommt gleich eine E-Mail zum Zurücksetzen (auch im Spam nachsehen).`;
      $('a-info').hidden = false;
      $('a-fehler').hidden = true;
    } catch (e) {
      anmeldeFehler(kontoFehler(e));
    }
  });

  // Konto noch nicht freigeschaltet: alle 20 s und auf Knopfdruck nochmals fragen
  let nochmalsTimer = 0;
  function nochmals() {
    clearTimeout(nochmalsTimer);
    if (zugang === 'gesperrt') D.starte(datenNeu);
  }
  $('g-nochmals').addEventListener('click', nochmals);

  async function abmelden() {
    if (D.stand().ausstehend) {
      if (!await frage('Noch nicht alles übertragen', 'Einige Änderungen warten noch auf Internet. Beim Abmelden gehen sie verloren.',
        'Trotzdem abmelden', true)) return;
    } else if (zugang === 'ok' && !await frage('Abmelden?', 'Die Gutscheine bleiben in eurer Liste. Zum Anmelden braucht es wieder ' +
      'E-Mail, Passwort und Internet.', 'Abmelden')) return;
    clearTimeout(nochmalsTimer);
    await D.abmelden();   // → D.konto meldet «niemand» → Anmelden
  }
  $('abmelden').addEventListener('click', abmelden);
  $('g-abmelden').addEventListener('click', abmelden);

  // ---------- Gemeinsame Liste: Änderungen (auch vom anderen Handy) ----------
  let uebernommen = false;     // alte Gutscheine des Prototyps schon hochgeladen (pro Anmeldung einmal versuchen)
  function fussText() {
    $('fuss').textContent = `Angemeldet als ${D.email()}` + (D.stand().ausstehend ? ' · wartet auf Internet' : '') +
      ` · Version ${window.BUILD}`;
  }
  async function datenNeu(art, info) {
    if (art === 'gesperrt') {
      zugang = 'gesperrt';
      $('g-email').textContent = D.email();
      zeige('gesperrt', {}, true);
      clearTimeout(nochmalsTimer);
      nochmalsTimer = setTimeout(nochmals, 20000);
      return fertig();
    }
    if (art === 'fehler') {
      console.warn('Gemeinsame Liste:', info);
      return melde('Die gemeinsame Liste meldet einen Fehler: ' + ((info && (info.code || info.message)) || info));
    }
    if (zugang === 'gesperrt' && !info.vomServer) return;   // erst glauben, wenn der Server die Liste schickt
    zugang = 'ok';
    clearTimeout(nochmalsTimer);
    await neuLaden();
    fussText();
    const v = ansichtJetzt;
    if (v === 'anmelden' || v === 'gesperrt') zeige('liste', {}, true);
    else if (v === 'liste') zeigeListe();
    else if (v === 'detail' || v === 'kasse') {
      const g = jetztG();
      if (!g) zeige('liste', {}, true);   // auf dem anderen Handy gelöscht
      else if (v === 'detail' && g.geaendert !== detailStand) zeigeDetail(g);
    }
    fertig();
    if (info.vomServer && !uebernommen) {
      uebernommen = true;
      D.altesUebernehmen().then(n => {
        if (n) melde(n === 1 ? '1 Gutschein von diesem Handy übernommen' : `${n} Gutscheine von diesem Handy übernommen`);
      }, e => { uebernommen = false; console.warn('Übernehmen:', e); });
    }
  }

  let istFertig = false;
  function fertig() {
    if (istFertig) return;
    istFertig = true;
    zeigeTipp();
    document.body.dataset.bereit = '1';
  }

  // ---------- Start ----------
  history.replaceState({ v: 'liste' }, '');
  if (window.Wolke.fehler) {
    $('leer-text').textContent = window.Wolke.fehler + ' Bitte die App neu laden.';
    $('leer').hidden = false;
  } else {
    D.konto(benutzer => {
      clearTimeout(nochmalsTimer);
      uebernommen = false;
      alle = [];
      if (!benutzer) {
        zugang = 'abgemeldet';
        anmeldeArt(false);
        zeige('anmelden', {}, true);
        return fertig();
      }
      zugang = 'ok';            // bis Firestore etwas anderes sagt
      fussText();
      D.starte(datenNeu);
      zeige(ansichtJetzt === 'anmelden' || ansichtJetzt === 'gesperrt' ? 'liste' : ansichtJetzt, history.state || {}, true);
    });
  }
})();
