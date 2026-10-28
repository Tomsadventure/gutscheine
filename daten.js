/* Speichert Gutscheine und Fotos auf diesem Gerät (IndexedDB).
   Prototyp: nur dieses Gerät. Für die gemeinsame Liste (Firebase) kommt später eine zweite Fassung mit denselben Funktionen –
   app.js bleibt dann gleich. Ein Gutschein:
   { id, laden, betrag, rest, code, format, pin, gueltigBis: 'JJJJ-MM-TT', notiz, fotos: [Foto-Id], status: 'aktiv' | 'archiv',
     verlauf: [{ datum, art: 'erfasst' | 'eingeloest' | 'korrigiert' | 'archiv' | 'aktiv', betrag, rest }], erstellt, geaendert } */
window.Daten = (function () {
  'use strict';
  const NAME = 'gutscheine';
  let db = null;

  function oeffne() {
    if (!db) {
      db = new Promise((ok, nein) => {
        const r = indexedDB.open(NAME, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('gutscheine', { keyPath: 'id' });
          r.result.createObjectStore('fotos');
        };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => nein(r.error);
      });
    }
    return db;
  }

  // Eine Transaktion: fn bekommt den Speicher und gibt (optional) eine Anfrage zurück, deren Ergebnis zurückkommt.
  async function tx(speicher, modus, fn) {
    const d = await oeffne();
    return new Promise((ok, nein) => {
      const t = d.transaction(speicher, modus);
      const anfrage = fn(t.objectStore(speicher));
      t.oncomplete = () => ok(anfrage ? anfrage.result : undefined);
      t.onerror = t.onabort = () => nein(t.error || new Error('Der Speicher des Browsers hat abgelehnt.'));
    });
  }

  const neueId = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  // Der Browser soll die Daten nicht von selbst wegräumen, wenn der Speicher knapp wird.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  return {
    neueId,
    alle: () => tx('gutscheine', 'readonly', s => s.getAll()),
    speichern: g => tx('gutscheine', 'readwrite', s => s.put(g)),
    loeschen: id => tx('gutscheine', 'readwrite', s => s.delete(id)),
    // Fotos als Bytes statt als Blob: Blobs in IndexedDB machen in manchen Safari-Fassungen Ärger.
    async foto(id) {
      const f = await tx('fotos', 'readonly', s => s.get(id));
      return f ? new Blob([f.daten], { type: f.typ }) : null;
    },
    async fotoSpeichern(blob) {
      const id = neueId();
      const f = { typ: blob.type || 'image/jpeg', daten: await blob.arrayBuffer() };
      await tx('fotos', 'readwrite', s => s.put(f, id));
      return id;
    },
    fotoLoeschen: id => tx('fotos', 'readwrite', s => s.delete(id)),
  };
})();
