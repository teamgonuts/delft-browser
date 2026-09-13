// Hover glosses and sentence translations without any server:
//   1. multiword idioms and single words from the bundled Dictionary (context-safe function words, separable verbs)
//   2. otherwise Chrome's built-in on-device Translator API (nl -> en), cached in chrome.storage.local
// Requires lib/dictionary.js. Translator API: Chrome 138+.
const Glosses = (() => {
  const normKey = (t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  let translatorPromise = null;
  let status = "unknown"; // unknown | ready | downloading | unavailable

  async function translator() {
    if (translatorPromise) return translatorPromise;
    translatorPromise = (async () => {
      if (typeof Translator === "undefined") { status = "unavailable"; return null; }
      const opts = { sourceLanguage: "nl", targetLanguage: "en" };
      try {
        const avail = await Translator.availability(opts);
        if (avail === "unavailable") { status = "unavailable"; return null; }
        status = avail === "available" ? "ready" : "downloading";
        const t = await Translator.create(opts);
        status = "ready";
        return t;
      } catch (e) { console.warn("Translator unavailable", e); status = "unavailable"; return null; }
    })();
    return translatorPromise;
  }

  const memo = new Map();
  async function translate(text) {
    if (memo.has(text)) return memo.get(text);
    const p = (async () => {
      const key = "tr:" + text;
      try { const got = await chrome.storage.local.get(key); if (got[key]) return got[key]; } catch (e) { /* no storage outside extension */ }
      const t = await translator();
      if (!t) return null;
      const out = (await t.translate(text)).trim();
      try { await chrome.storage.local.set({ [key]: out }); } catch (e) { /* ignore */ }
      return out;
    })();
    memo.set(text, p);
    return p;
  }

  // Gloss for one word as it appears in `sentence`. Idioms in the sentence win, then the dictionary, then Translator.
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
    // Translator capitalises single words; a gloss identical to the word (names, numbers) is still useful to show.
    return t.charAt(0).toLowerCase() + t.slice(1);
  }

  return { translate, wordGloss, translator, normKey, get status() { return status; } };
})();
if (typeof self !== "undefined") self.Glosses = Glosses;
