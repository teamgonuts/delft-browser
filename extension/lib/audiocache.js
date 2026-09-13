// Persistent cache for synthesized clips (IndexedDB), keyed by voice + text. Survives panel reloads.
const AudioCache = (() => {
  const DB = "delft-audio", STORE = "clips";
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const key = (voice, text) => voice + "|" + text;
  async function get(voice, text) {
    try {
      const db = await open();
      return await new Promise((resolve) => {
        const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key(voice, text));
        r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  }
  async function put(voice, text, blob) {
    try {
      const db = await open();
      db.transaction(STORE, "readwrite").objectStore(STORE).put(blob, key(voice, text));
    } catch (e) { /* cache is best-effort */ }
  }
  return { get, put };
})();
if (typeof self !== "undefined") self.AudioCache = AudioCache;
