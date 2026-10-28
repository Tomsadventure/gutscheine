/* Zeichnet den Strichcode eines Gutscheins neu (zxing-wasm, Schreibfassung), damit die Kasse ihn vom Bildschirm lesen kann.
   Die Bibliothek lädt erst, wenn der erste Strichcode gebraucht wird. */
window.Strichcode = (function () {
  'use strict';
  // Was sich zeichnen lässt (Name für die Auswahl im Formular)
  const ARTEN = {
    Code128: 'Code 128 (Strichcode)', EAN13: 'EAN-13 (Strichcode)', EAN8: 'EAN-8 (Strichcode)', UPCA: 'UPC-A (Strichcode)',
    UPCE: 'UPC-E (Strichcode)', ITF: 'ITF (Strichcode)', Code39: 'Code 39 (Strichcode)', Code93: 'Code 93 (Strichcode)',
    Codabar: 'Codabar (Strichcode)', QRCode: 'QR-Code', DataMatrix: 'Data Matrix', AztecCode: 'Aztec-Code', PDF417: 'PDF417',
  };
  // Gelesene Arten, die sich nicht genau so zeichnen lassen → nächstverwandte Art
  const ERSATZ = {
    Aztec: 'AztecCode', AztecRune: 'AztecCode', ITF14: 'ITF', Code39Std: 'Code39', CompactPDF417: 'PDF417', MicroPDF417: 'PDF417',
    QRCodeModel1: 'QRCode', QRCodeModel2: 'QRCode', MicroQRCode: 'QRCode', RMQRCode: 'QRCode',
  };
  const FLAECHIG = new Set(['QRCode', 'DataMatrix', 'AztecCode']);

  const zeichenbar = gelesen => ARTEN[gelesen] ? gelesen : ERSATZ[gelesen] || (gelesen ? 'Code128' : '');
  const genau = gelesen => !!ARTEN[gelesen] || !!ERSATZ[gelesen];

  function eanOk(ziffern) {
    let s = 0;
    const n = ziffern.length;
    for (let i = 0; i < n - 1; i++) s += +ziffern[n - 2 - i] * (i % 2 === 0 ? 3 : 1);
    return (10 - (s % 10)) % 10 === +ziffern[n - 1];
  }

  // Vorschlag für von Hand eingetippte Nummern
  function vorschlag(code) {
    const c = (code || '').trim();
    if (!c) return '';
    if (/^\d{13}$/.test(c) && eanOk(c)) return 'EAN13';
    if (/^\d{8}$/.test(c) && eanOk(c)) return 'EAN8';
    if (/^https?:\/\//i.test(c) || c.length > 48) return 'QRCode';
    return 'Code128';
  }

  let bereit = null;
  function lade() {
    if (!bereit) {
      bereit = new Promise((ok, nein) => {
        const s = document.createElement('script');
        s.src = 'lib/zxing/writer.js?v=' + window.BUILD;
        s.onload = () => {
          window.ZXingWASM.prepareZXingModule({
            overrides: { locateFile: (pfad, vorne) => (pfad.endsWith('.wasm') ? 'lib/zxing/' + pfad : vorne + pfad) },
          });
          ok(window.ZXingWASM);
        };
        s.onerror = () => { bereit = null; nein(new Error('Strichcode-Programm lädt nicht')); };
        document.head.appendChild(s);
      });
    }
    return bereit;
  }

  // SVG-Text des Strichcodes (frei skalierbar) oder null, wenn es sich so nicht zeichnen lässt.
  async function svg(text, art) {
    if (!text || !art) return null;
    const Z = await lade();
    const r = await Z.writeBarcode(text, { format: art, withQuietZones: true });
    if (r.error || !r.svg) return null;
    return r.svg
      .replace(/^[\s\S]*?<svg/, '<svg')
      .replace(/width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)"/,
        'viewBox="0 0 $1 $2" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" role="img" aria-label="Strichcode"')
      .replace(/<desc>[\s\S]*?<\/desc>/, '');
  }

  return { ARTEN, zeichenbar, genau, vorschlag, svg, flaechig: art => FLAECHIG.has(art) };
})();
