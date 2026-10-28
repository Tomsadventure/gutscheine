/* Liest Strichcodes im Hintergrund (zxing-wasm, Lesefassung). Bekommt { nr, bild: ImageData, gruendlich }, antwortet
   { nr, treffer: [{ text, format }] } oder { nr, fehler }. gruendlich = Foto (langsamer, findet mehr), sonst Kamerabild. */
importScripts('lib/zxing/reader.js');

const FORMATE = ['Code128', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'ITF', 'Code39', 'Code93', 'Codabar', 'DataBar', 'DataBarExp',
  'QRCode', 'MicroQRCode', 'PDF417', 'DataMatrix', 'Aztec'];

ZXingWASM.prepareZXingModule({
  overrides: {
    locateFile: (pfad, vorne) => (pfad.endsWith('.wasm') ? new URL('lib/zxing/' + pfad, self.location.href).href : vorne + pfad),
  },
});

self.onmessage = async e => {
  const { nr, bild, gruendlich } = e.data;
  try {
    const r = await ZXingWASM.readBarcodes(bild, {
      formats: FORMATE,
      tryHarder: true,
      tryRotate: true,
      tryInvert: gruendlich,
      tryDownscale: true,
      tryDenoise: gruendlich,
      maxNumberOfSymbols: gruendlich ? 4 : 1,
    });
    self.postMessage({ nr, treffer: r.filter(x => x.isValid && x.text).map(x => ({ text: x.text, format: x.format })) });
  } catch (err) {
    self.postMessage({ nr, fehler: String((err && err.message) || err) });
  }
};
