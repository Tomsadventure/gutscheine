/* Die gemeinsame Liste: Anmeldung und Gutscheine in Firestore (Firebase, Zürich), über wolke.js.
   Firestore hält alles auch auf dem Gerät → die App geht ohne Internet; Änderungen gehen weiter, sobald es wieder Netz hat.
   Lesen und schreiben dürfen nur freigeschaltete Konten (firestore.rules). Ein Gutschein (Sammlung «gutscheine», Id = id):
   { id, laden, art: 'wert' | 'rabatt' (fehlt bei alten = 'wert'), betrag, rest (CHF, bei Rabatt null), rabatt: '20 %',
     nurOnline, shop: 'https://…', code, format, onlineCode (eigener Code für den Webshop, sonst leer/fehlt), pin,
     gueltigBis: 'JJJJ-MM-TT', notiz, fotos: [Foto-Id], status: 'aktiv' | 'archiv',
     verlauf: [{ datum, art: 'erfasst' | 'eingeloest' | 'korrigiert' | 'archiv' | 'aktiv', betrag, rest }], erstellt, geaendert }
   Ein Foto (Sammlung «fotos»): { typ: 'image/jpeg', daten: Bytes } – ein Dokument darf höchstens 1 MiB gross sein. */
window.Daten = (function () {
  'use strict';
  const W = window.Wolke, F = W.F;
  const FOTO_MAX_BYTES = 900 * 1024;
  const ALT = 'gutscheine';      // IndexedDB des Prototyps (nur dieses Gerät, bis 2026-10-28)
  const karte = new Map();       // id → Gutschein, wie zuletzt von Firestore gemeldet oder eben gespeichert
  const fotos = new Map();       // id → Blob
  let aufhoeren = null;          // beendet das Zuhören
  let melden = () => {};
  let stand = { vomServer: false, ausstehend: false };

  const neueId = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  // Der Browser soll die Daten nicht von selbst wegräumen, wenn der Speicher knapp wird.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------- Konto ----------
  const konto = cb => F.onAuthStateChanged(W.auth, cb);
  const anmelden = (email, passwort) => F.signInWithEmailAndPassword(W.auth, email, passwort);
  const registrieren = (email, passwort) => F.createUserWithEmailAndPassword(W.auth, email, passwort);
  const passwortVergessen = email => F.sendPasswordResetEmail(W.auth, email);
  async function abmelden() { stop(); await F.signOut(W.auth); }
  const email = () => (W.auth.currentUser ? W.auth.currentUser.email : '');

  // ---------- Gutscheine ----------
  // Hört auf alle Gutscheine: cb('daten', stand) bei jeder Änderung (auch vom anderen Handy, auch wenn der Server etwas
  // bestätigt), cb('gesperrt'), wenn dieses Konto (noch) nicht freigeschaltet ist, cb('fehler', e) sonst – auch wenn Firestore
  // etwas Gespeichertes ablehnt. stand: { vomServer: Liste kam vom Server (sonst vom Gerät), ausstehend: wartet aufs Senden }
  function starte(cb) {
    stop();
    melden = cb;
    const sammlung = F.collection(W.db, 'gutscheine');
    let geliefert = false;
    const hoeren = F.onSnapshot(sammlung, { includeMetadataChanges: true }, snap => {
      geliefert = true;
      for (const c of snap.docChanges()) {
        if (c.type === 'removed') karte.delete(c.doc.id); else karte.set(c.doc.id, c.doc.data());
      }
      stand = { vomServer: !snap.metadata.fromCache, ausstehend: snap.metadata.hasPendingWrites };
      cb('daten', stand);
    }, e => { stop(); cb(e.code === 'permission-denied' ? 'gesperrt' : 'fehler', e); });
    aufhoeren = hoeren;
    // Bei schlechtem Netz meldet sich onSnapshot erst, wenn Firestore aufgibt (bis 10 s) – an der Kasse zu lange.
    // Darum sofort zeigen, was auf dem Gerät gespeichert ist.
    F.getDocsFromCache(sammlung).then(snap => {
      if (geliefert || aufhoeren !== hoeren || !snap.size) return;
      for (const d of snap.docs) karte.set(d.id, d.data());
      cb('daten', stand);
    }).catch(() => {});
  }
  function stop() {
    if (aufhoeren) aufhoeren();
    aufhoeren = null;
    karte.clear();
    fotos.clear();
    stand = { vomServer: false, ausstehend: false };
  }

  // Firestore schreibt sofort auf das Gerät und schickt es weiter, sobald Internet da ist. Die Bestätigung vom Server kommt
  // ohne Internet erst viel später – darum nicht darauf warten, nur Fehler melden.
  // Bis Firestore den nächsten Stand meldet (ohne Netz bis 10 s), gilt die Änderung als «wartet aufs Senden».
  function schreibe(p) {
    p.catch(e => { console.warn('Firestore:', e); melden('fehler', e); });
    if (!stand.ausstehend) {
      stand = Object.assign({}, stand, { ausstehend: true });
      melden('daten', stand);
    }
  }
  const gDoc = id => F.doc(W.db, 'gutscheine', id), fDoc = id => F.doc(W.db, 'fotos', id);

  function speichern(g) {
    karte.set(g.id, g);
    schreibe(F.setDoc(gDoc(g.id), g));
    return Promise.resolve();
  }
  function loeschen(id) {
    karte.delete(id);
    schreibe(F.deleteDoc(gDoc(id)));
    return Promise.resolve();
  }

  // ---------- Fotos ----------
  async function fotoDaten(blob) {
    if (blob.size > FOTO_MAX_BYTES && window.Scanner) blob = await window.Scanner.verkleinern(blob, 1200);
    if (blob.size > FOTO_MAX_BYTES) throw new Error('Das Foto ist zu gross.');
    return { blob, doc: { typ: blob.type || 'image/jpeg', daten: F.Bytes.fromUint8Array(new Uint8Array(await blob.arrayBuffer())) } };
  }
  async function fotoSpeichern(blob) {
    const f = await fotoDaten(blob);
    const id = neueId();
    fotos.set(id, f.blob);
    schreibe(F.setDoc(fDoc(id), f.doc));
    return id;
  }
  // Blob oder null (gelöscht, oder ohne Internet und noch nie auf diesem Gerät geladen)
  async function foto(id) {
    if (fotos.has(id)) return fotos.get(id);
    try {
      const s = await F.getDoc(fDoc(id));
      if (!s.exists()) return null;
      const f = s.data();
      const blob = new Blob([f.daten.toUint8Array()], { type: f.typ });
      fotos.set(id, blob);
      return blob;
    } catch { return null; }
  }
  function fotoLoeschen(id) {
    fotos.delete(id);
    schreibe(F.deleteDoc(fDoc(id)));
    return Promise.resolve();
  }

  // ---------- Vom Prototyp übernehmen ----------
  // Der Prototyp speicherte nur auf dem Gerät. Nach dem ersten Anmelden kommt das in die gemeinsame Liste; die alte Ablage wird
  // erst gelöscht, wenn Firestore alles bestätigt hat (sonst beim nächsten Start nochmals). → Anzahl übernommener Gutscheine
  async function altesUebernehmen() {
    if (indexedDB.databases && !(await indexedDB.databases()).some(d => d.name === ALT)) return 0;
    const alt = await new Promise(ok => {
      const r = indexedDB.open(ALT);
      r.onupgradeneeded = () => r.transaction.abort();   // gab es nicht → nichts anlegen
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
    });
    if (!alt) return 0;
    const lies = (speicher, fn) => new Promise((ok, nein) => {
      const t = alt.transaction(speicher, 'readonly');
      const r = fn(t.objectStore(speicher));
      t.oncomplete = () => ok(r.result);
      t.onerror = () => nein(t.error);
    });
    let liste = [];
    try {
      if (alt.objectStoreNames.contains('gutscheine')) liste = await lies('gutscheine', s => s.getAll());
      const warte = [];
      for (const g of liste) {
        for (const id of g.fotos || []) {
          const f = await lies('fotos', s => s.get(id));
          if (f) warte.push(fotoDaten(new Blob([f.daten], { type: f.typ })).then(d => F.setDoc(fDoc(id), d.doc)));
        }
        warte.push(F.setDoc(gDoc(g.id), g));
      }
      await Promise.all(warte);
    } finally { alt.close(); }
    await new Promise(ok => { const r = indexedDB.deleteDatabase(ALT); r.onsuccess = r.onerror = r.onblocked = () => ok(); });
    return liste.length;
  }

  return {
    neueId, konto, anmelden, registrieren, passwortVergessen, abmelden, email,
    starte, stand: () => stand, alle: () => Promise.resolve([...karte.values()]),
    speichern, loeschen, foto, fotoSpeichern, fotoLoeschen, altesUebernehmen,
  };
})();
