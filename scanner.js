/* Kamera und Strichcodes lesen. Das Lesen macht scan-worker.js (zxing-wasm) im Hintergrund, damit das Kamerabild flüssig bleibt.
   Safari auf dem iPhone kann Strichcodes nicht selbst lesen – darum überall dieselbe Bibliothek. */
window.Scanner = (function () {
  'use strict';
  const MAX_LIVE = 1280;     // Kamerabild für das Lesen höchstens so breit
  const MAX_FOTO = 2400;     // Foto für das Lesen höchstens so breit
  const PAUSE_MS = 70;       // zwischen zwei Leseversuchen
  // Diese Arten haben keine Prüfziffer: erst glauben, wenn zweimal hintereinander dasselbe gelesen wurde.
  const UNSICHER = new Set(['ITF', 'ITF14', 'Code39', 'Code39Std', 'Code39Ext', 'Code32', 'Codabar']);

  let worker = null, nr = 0;
  const wartet = new Map();
  let strom = null, spur = null, video = null, rahmen = null, cb = null, laeuft = false;
  let sucht = true;          // false = die Kamera läuft, sucht aber keine Strichcodes (Art «Foto»)
  const leinwand = document.createElement('canvas');
  const ctx = leinwand.getContext('2d', { willReadFrequently: true });

  function arbeiter() {
    if (!worker) {
      worker = new Worker('scan-worker.js?v=' + window.BUILD);
      worker.onmessage = e => {
        const w = wartet.get(e.data.nr);
        if (!w) return;
        wartet.delete(e.data.nr);
        if (e.data.fehler) w.nein(new Error(e.data.fehler)); else w.ok(e.data.treffer);
      };
      worker.onerror = e => {
        for (const w of wartet.values()) w.nein(new Error(e.message || 'Leseprogramm lädt nicht'));
        wartet.clear();
      };
    }
    return worker;
  }

  function lies(bild, gruendlich) {
    return new Promise((ok, nein) => {
      const n = ++nr;
      wartet.set(n, { ok, nein });
      arbeiter().postMessage({ nr: n, bild, gruendlich }, [bild.data.buffer]);
    });
  }

  // ---------- Kamera ----------
  async function starte(videoEl, rahmenEl, callbacks) {
    stop();
    video = videoEl; rahmen = rahmenEl; cb = callbacks; laeuft = true;
    arbeiter();   // Leseprogramm schon laden, während die Kamera startet
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('Dieser Browser gibt die Kamera nicht frei.');
      e.name = 'KeineKamera';
      throw e;
    }
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if (!laeuft) { s.getTracks().forEach(t => t.stop()); return; }
    strom = s;
    spur = s.getVideoTracks()[0];
    video.srcObject = s;
    await video.play().catch(() => {});
    const caps = spur && spur.getCapabilities ? spur.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      spur.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    if (cb.faehig) cb.faehig({ licht: !!caps.torch, zoom: caps.zoom && caps.zoom.max >= 1.5 ? caps.zoom : null });
    schleife();
  }

  function stop() {
    laeuft = false;
    if (strom) strom.getTracks().forEach(t => t.stop());
    strom = spur = null;
    if (video) video.srcObject = null;
  }

  const licht = an => spur ? spur.applyConstraints({ advanced: [{ torch: an }] }) : Promise.resolve();
  const zoom = stufe => spur ? spur.applyConstraints({ advanced: [{ zoom: stufe }] }) : Promise.resolve();
  const suchen = an => { sucht = an; };

  async function schleife() {
    let runde = 0, letzter = '';
    while (laeuft) {
      if (sucht && video.readyState >= 2 && video.videoWidth) {
        let treffer = [];
        try {
          treffer = await lies(kamerabild(runde++ % 2 === 1), false);
        } catch (e) {
          if (cb.fehler) cb.fehler(e);
          return;
        }
        if (!laeuft) return;
        const t = treffer[0];
        if (t) {
          const schluessel = t.format + '|' + t.text;
          if (!UNSICHER.has(t.format) || schluessel === letzter) {
            laeuft = false;
            cb.gefunden(t);
            return;
          }
          letzter = schluessel;
        }
      }
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
  }

  // Abwechselnd das ganze Bild (verkleinert) und nur das Feld im Rahmen (scharf) lesen.
  function kamerabild(nurRahmen) {
    const vw = video.videoWidth, vh = video.videoHeight;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (nurRahmen && rahmen) {
      // Das Video füllt seinen Kasten (object-fit: cover): Bildschirm-Punkte in Video-Punkte umrechnen.
      const v = video.getBoundingClientRect(), r = rahmen.getBoundingClientRect();
      const s = Math.max(v.width / vw, v.height / vh);
      const ox = (v.width - vw * s) / 2, oy = (v.height - vh * s) / 2;
      sx = Math.max(0, (r.left - v.left - ox) / s);
      sy = Math.max(0, (r.top - v.top - oy) / s);
      sw = Math.min(vw - sx, r.width / s);
      sh = Math.min(vh - sy, r.height / s);
      if (sw < 50 || sh < 50) { sx = 0; sy = 0; sw = vw; sh = vh; }
    }
    const f = Math.min(1, MAX_LIVE / Math.max(sw, sh));
    leinwand.width = Math.round(sw * f);
    leinwand.height = Math.round(sh * f);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, leinwand.width, leinwand.height);
    return ctx.getImageData(0, 0, leinwand.width, leinwand.height);
  }

  // ---------- Fotos ----------
  // Lädt ein Bild (Blob) und zeichnet es höchstens max Punkte breit/hoch auf eine Leinwand.
  function aufLeinwand(blob, max, c) {
    return new Promise((ok, nein) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const f = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        c.width = Math.max(1, Math.round(img.naturalWidth * f));
        c.height = Math.max(1, Math.round(img.naturalHeight * f));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); nein(new Error('Das Bild lässt sich nicht öffnen.')); };
      img.src = url;
    });
  }

  // Sucht einen Strichcode auf einem Foto oder Bildschirmfoto. Ergebnis: { text, format } oder null.
  async function fotoLesen(blob) {
    const c = await aufLeinwand(blob, MAX_FOTO, leinwand);
    const treffer = await lies(ctx.getImageData(0, 0, c.width, c.height), true);
    return treffer[0] || null;
  }

  // Runder Auslöser (Art «Foto»): das aktuelle Kamerabild in voller Grösse (JPEG).
  function standbild() {
    if (!video || !video.videoWidth) return Promise.reject(new Error('Die Kamera zeigt noch nichts.'));
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return new Promise((ok, nein) => c.toBlob(b => (b ? ok(b) : nein(new Error('Foto ging nicht'))), 'image/jpeg', 0.9));
  }

  // Foto für die Ablage verkleinern (JPEG).
  async function verkleinern(blob, max) {
    const c = await aufLeinwand(blob, max, document.createElement('canvas'));
    return new Promise(ok => c.toBlob(b => ok(b || blob), 'image/jpeg', 0.82));
  }

  return { starte, stop, licht, zoom, suchen, fotoLesen, standbild, verkleinern };
})();
