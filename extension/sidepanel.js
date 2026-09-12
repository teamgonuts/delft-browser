// Delft Browser side panel. Works in two modes:
//  - extension mode: extracts the article from the current tab via chrome.scripting
//  - standalone mode: served by the helper at http://127.0.0.1:8765/sidepanel.html?article=<id>
const HELPER = "http://127.0.0.1:8765";
const REPS_TARGET = 3;

const $ = (id) => document.getElementById(id);
const inExtension = typeof chrome !== "undefined" && !!(chrome.scripting && chrome.tabs);

const state = { title: "", url: "", sentences: [], helperOk: false, stream: null, recorder: null };

// ---------- helper status ----------
async function checkHelper() {
  try {
    const r = await fetch(HELPER + "/health", { cache: "no-store" });
    const j = await r.json();
    state.helperOk = !!j.ok;
    $("status").textContent = "";
    $("status").className = "status ok";
    $("status").hidden = true;
  } catch (e) {
    state.helperOk = false;
    $("status").textContent = "helper offline (run: python helper/server.py) · falling back to browser voice, no glosses";
    $("status").className = "status bad";
    $("status").hidden = false;
  }
}

// ---------- article loading ----------
function newItem(text) { return { text, native: {}, mine: null, flags: { listened: false, recorded: false, played: false }, reps: 0 }; }

async function loadArticle() {
  $("load").disabled = true;
  try {
    let data;
    if (inExtension) data = await extractFromTab();
    else data = await loadStandalone();
    if (!data || !data.sentences || !data.sentences.length) throw new Error("No sentences found on this page.");
    state.title = data.title; state.url = data.url;
    // Each sentence starts as one practice item (the whole sentence). When the helper returns phrases, the
    // card is rebuilt with one item per phrase plus a whole-sentence item.
    state.sentences = data.sentences.map((text) => ({ text, words: tokenize(text), gloss: null, translation: "", phrases: null, items: [newItem(text)] }));
    render();
    fetchGlosses();
  } catch (e) {
    $("empty").hidden = false;
    $("empty").innerHTML = "Could not load: " + escapeHtml(e.message || String(e));
  } finally { $("load").disabled = false; }
}

async function extractFromTab() {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((t) => /^https?:/.test(t.url || ""));
  if (!candidates.length) throw new Error("No web page tab found.");
  let tab = candidates.find((t) => t.active && t.lastFocusedWindow) || candidates.find((t) => t.active);
  if (!tab) tab = candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["vendor/Readability.js", "content/extract.js"] });
  return results && results[0] && results[0].result;
}

async function loadStandalone() {
  const id = new URLSearchParams(location.search).get("article");
  if (!id) throw new Error("Standalone mode needs ?article=<id> (see helper/server.py).");
  const r = await fetch(`${HELPER}/articles/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error("Article not found in helper.");
  return r.json();
}

// ---------- words, glosses, phrases ----------
function tokenize(text) {
  return text.split(/(\s+)/).filter((t) => t.length).map((t) => ({ raw: t, key: normKey(t), isWord: /[\p{L}\p{N}]/u.test(t) }));
}
function normKey(t) { return t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase(); }

async function fetchGlosses() {
  if (!state.helperOk) return;
  const chunks = []; let i = 0;
  while (i < state.sentences.length) { const n = chunks.length === 0 ? 3 : 8; chunks.push(Array.from({ length: Math.min(n, state.sentences.length - i) }, (_, k) => i + k)); i += n; }
  const worker = async () => { while (chunks.length) await glossChunk(chunks.shift()); };
  await Promise.all([worker(), worker()]);
}

async function glossChunk(idxs) {
  try {
    const r = await fetch(HELPER + "/gloss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sentences: idxs.map((i) => state.sentences[i].text) }) });
    const j = await r.json();
    (j.results || []).forEach((res, k) => {
      const i = idxs[k]; const s = state.sentences[i];
      if (!s || !res) return;
      s.translation = res.translation || "";
      const map = new Map();
      for (const [w, g] of res.words || []) {
        const key = normKey(w); if (key && !map.has(key)) map.set(key, g);
        if (/\s/.test(key)) for (const part of key.split(/\s+/)) if (part && !map.has(part)) map.set(part, g);
      }
      s.gloss = map;
      const phrases = Array.isArray(res.phrases) && res.phrases.length ? res.phrases : [s.text];
      const untouched = s.items.every((it) => !it.mine && it.reps === 0 && !it.flags.listened);
      if (phrases.length > 1 && untouched) {
        s.phrases = phrases;
        s.items = phrases.map(newItem);
      }
      renderCard(i);
    });
  } catch (e) { console.warn("gloss failed", e); }
}

// ---------- rendering ----------
// One box per practice item (a phrase, or a whole short sentence). Boxes are grouped per sentence in a <li>
// so a sentence can be re-rendered when its phrases arrive.
function render() {
  $("empty").hidden = true;
  $("article-title").textContent = state.title;
  const ol = $("sentences"); ol.innerHTML = "";
  state.sentences.forEach((s, i) => {
    const li = document.createElement("li"); li.className = "sentence"; li.dataset.i = i;
    ol.appendChild(li);
    renderCard(i);
  });
}

function renderCard(i) {
  const s = state.sentences[i];
  const li = document.querySelector(`.sentence[data-i="${i}"]`); if (!li) return;
  li.innerHTML = s.items.map((it, j) => `
    <div class="card" data-i="${i}" data-j="${j}">
      <div class="text">${tokenize(it.text).map((t) => t.isWord ? `<span class="w" data-key="${escapeHtml(t.key)}">${escapeHtml(t.raw)}</span>` : escapeHtml(t.raw)).join("")}</div>
      <div class="controls">
        <button class="native" title="Play native speaker">▶ Native</button>
        <button class="rec" title="Record yourself">● Record</button>
        <button class="mine" title="Play your recording" disabled>▶ Me</button>
        <div class="ring" title="Completed rounds"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
      </div>
    </div>`).join("");
  li.querySelectorAll(".card").forEach((card) => {
    const j = +card.dataset.j;
    card.querySelector(".native").addEventListener("click", () => playNative(i, j));
    card.querySelector(".rec").addEventListener("click", () => toggleRecord(i, j));
    card.querySelector(".mine").addEventListener("click", () => playMine(i, j));
  });
  s.items.forEach((_, j) => updateRow(i, j, false));
}

function rowEl(i, j) { return document.querySelector(`.card[data-i="${i}"][data-j="${j}"]`); }

function updateRow(i, j, activate = true) {
  const it = state.sentences[i].items[j];
  const card = rowEl(i, j); if (!card) return;
  card.querySelectorAll(".dot").forEach((d, k) => d.classList.toggle("full", k < it.reps));
  card.querySelector(".mine").disabled = !it.mine;
  card.classList.toggle("done", it.reps >= REPS_TARGET);
  if (activate) {
    document.querySelectorAll(".card.active").forEach((c) => c.classList.remove("active"));
    card.classList.add("active");
  }
}

function completeStep(i, j, flag) {
  const it = state.sentences[i].items[j];
  it.flags[flag] = true;
  if (it.flags.listened && it.flags.recorded && it.flags.played) {
    it.reps = Math.min(REPS_TARGET, it.reps + 1);
    it.flags = { listened: false, recorded: false, played: false };
  }
  updateRow(i, j);
}

// ---------- audio: native ----------
let currentAudio = null;
function stopCurrent() { if (currentAudio) { currentAudio.pause(); currentAudio = null; } document.querySelectorAll(".playing").forEach((b) => b.classList.remove("playing")); }

async function playNative(i, j) {
  const it = state.sentences[i].items[j]; const voice = $("voice").value;
  const btn = rowEl(i, j).querySelector(".native");
  stopCurrent(); btn.classList.add("playing"); updateRow(i, j);
  if (state.helperOk) {
    try {
      if (!it.native[voice]) {
        const r = await fetch(`${HELPER}/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(it.text)}`);
        if (!r.ok) throw new Error("tts " + r.status);
        it.native[voice] = URL.createObjectURL(await r.blob());
      }
      const a = new Audio(it.native[voice]); currentAudio = a;
      a.onended = () => { btn.classList.remove("playing"); completeStep(i, j, "listened"); };
      await a.play();
      return;
    } catch (e) { console.warn("helper tts failed, using browser voice", e); }
  }
  const u = new SpeechSynthesisUtterance(it.text); u.lang = "nl-NL";
  const v = speechSynthesis.getVoices().find((v) => /^nl/i.test(v.lang) && /natural|online/i.test(v.name)) || speechSynthesis.getVoices().find((v) => /^nl/i.test(v.lang));
  if (v) u.voice = v;
  u.onend = () => { btn.classList.remove("playing"); completeStep(i, j, "listened"); };
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

// ---------- audio: record & play back ----------
async function toggleRecord(i, j) {
  const btn = rowEl(i, j).querySelector(".rec");
  if (state.recorder && state.recorder.state === "recording") { state.recorder.stop(); return; }
  try {
    if (!state.stream) state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // Chrome cannot show the mic prompt inside a side panel ("Permission dismissed"), so ask once from a
    // regular extension tab; the grant applies to the whole extension origin.
    if (inExtension && chrome.tabs && chrome.runtime) {
      chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
      $("status").textContent = "allow the microphone in the tab that just opened, then press Record again";
      $("status").className = "status bad";
    } else alert("Microphone access is needed to record: " + e.message);
    return;
  }
  stopCurrent();
  const chunks = [];
  const rec = new MediaRecorder(state.stream);
  state.recorder = rec;
  rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  rec.onstop = () => {
    const it = state.sentences[i].items[j];
    if (it.mine) URL.revokeObjectURL(it.mine);
    it.mine = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    btn.classList.remove("on"); btn.textContent = "● Record";
    state.recorder = null;
    completeStep(i, j, "recorded");
  };
  rec.start();
  btn.classList.add("on"); btn.textContent = "■ Stop";
  updateRow(i, j);
}

async function playMine(i, j) {
  const it = state.sentences[i].items[j]; if (!it.mine) return;
  const btn = rowEl(i, j).querySelector(".mine");
  stopCurrent(); btn.classList.add("playing"); updateRow(i, j);
  const a = new Audio(it.mine); currentAudio = a;
  a.onended = () => { btn.classList.remove("playing"); completeStep(i, j, "played"); };
  await a.play();
}

// ---------- tooltip ----------
const tip = $("tooltip");
document.addEventListener("mouseover", (ev) => {
  const w = ev.target.closest && ev.target.closest(".w"); if (!w) return;
  const card = w.closest(".card"); const s = state.sentences[+card.dataset.i];
  const g = s.gloss ? s.gloss.get(w.dataset.key) : null;
  tip.innerHTML = `<span class="src">${escapeHtml(w.textContent)}</span>${escapeHtml(g || (s.gloss ? "(no gloss)" : state.helperOk ? "translating…" : "helper offline"))}`;
  tip.classList.toggle("pending", !g);
  tip.hidden = false;
  positionTip(ev);
});
document.addEventListener("mousemove", (ev) => { if (!tip.hidden) positionTip(ev); });
document.addEventListener("mouseout", (ev) => { if (ev.target.closest && ev.target.closest(".w")) tip.hidden = true; });
function positionTip(ev) {
  const pad = 12; let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- boot ----------
$("load").addEventListener("click", loadArticle);
if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices();
checkHelper().then(() => { if (!inExtension && new URLSearchParams(location.search).get("article")) loadArticle(); });
window.__delft = state;
