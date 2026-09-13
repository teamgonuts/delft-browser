// Hover glosses without any server:
//   1. multiword idioms and single words from the bundled Dictionary (context-safe function words, separable verbs)
//   2. Chrome's built-in on-device Translator API (nl -> en). Its one-time model download may only be started
//      from a user gesture, so translator() is called synchronously inside click handlers (see sidepanel.js).
//   3. fallback while/if the on-device model is not available: Google Translate's public web endpoint.
// Results are cached in chrome.storage.local.
const Glosses = (() => {
  const normKey = (t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  const OPTS = { sourceLanguage: "nl", targetLanguage: "en" };
  let instance = null;
  let creating = null;
  let status = "unknown"; // unknown | ready | downloading | needs-gesture | missing | failed
  let progress = 0;
  const listeners = new Set();
  const setStatus = (s) => { status = s; for (const fn of listeners) fn(status, progress); };

  // Call from inside a click handler (synchronously, before any await) so a pending download is allowed.
  function translator() {
    if (instance) return Promise.resolve(instance);
    if (creating) return creating;
    if (typeof Translator === "undefined") { setStatus("missing"); return Promise.resolve(null); }
    creating = (async () => {
      try {
        const avail = await Translator.availability(OPTS);
        if (avail === "unavailable") { setStatus("missing"); return null; }
        setStatus(avail === "available" ? "ready" : "downloading");
        instance = await Translator.create({ ...OPTS, monitor(m) { m.addEventListener("downloadprogress", (e) => { progress = e.loaded; setStatus("downloading"); }); } });
        setStatus("ready");
        return instance;
      } catch (e) {
        // NotAllowedError: download needs a user gesture. Not fatal: the next click retries.
        setStatus(e && e.name === "NotAllowedError" ? "needs-gesture" : "failed");
        console.warn("Translator not ready:", e);
        return null;
      } finally { creating = null; }
    })();
    return creating;
  }

  async function storageGet(key) { try { const got = await chrome.storage.local.get(key); return got[key] || null; } catch (e) { return null; } }
  async function storageSet(key, val) { try { await chrome.storage.local.set({ [key]: val }); } catch (e) { /* ignore */ } }

  // Google Translate public endpoint (no key). Used only when the on-device translator is not available.
  async function onlineTranslate(text) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=nl&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("online translate " + r.status);
    const j = await r.json();
    return (j[0] || []).map((seg) => seg[0]).join("").trim();
  }

  const memo = new Map();
  function translate(text) {
    if (memo.has(text)) return memo.get(text);
    const p = (async () => {
      const key = "tr:" + text;
      const cached = await storageGet(key);
      if (cached) return cached;
      let out = null;
      const t = instance || (status === "ready" ? await translator() : null);
      if (t) { try { out = (await t.translate(text)).trim(); } catch (e) { console.warn("on-device translate failed", e); } }
      if (!out) { try { out = await onlineTranslate(text); } catch (e) { console.warn("online translate failed", e); } }
      if (out) await storageSet(key, out); else memo.delete(text);
      return out;
    })();
    memo.set(text, p);
    return p;
  }

  // Gloss for one word as it appears in `sentence`. Idioms in the sentence win, then the dictionary, then translation.
  async function wordGloss(word, sentence) {
    const key = normKey(word);
    if (!key) return null;
    const lower = " " + sentence.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ") + " ";
    for (const idiom of Dictionary.MULTI) {
      if (idiom.split(" ").includes(key) && lower.includes(" " + idiom + " ")) return `${Dictionary.W[idiom]} (${idiom})`;
    }
    const d = Dictionary.get(key);
    if (d) return d;
    const t = await translate(key);
    if (!t) return null;
    return t.charAt(0).toLowerCase() + t.slice(1);
  }

  return { translate, wordGloss, translator, normKey, onStatus: (fn) => listeners.add(fn), get status() { return status; }, get progress() { return progress; } };
})();
if (typeof self !== "undefined") self.Glosses = Glosses;
