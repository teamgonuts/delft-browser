// Delft Browser side panel. Works in two modes:
//  - extension mode: extracts the article from the current tab via chrome.scripting
//  - standalone mode: served by the helper at http://127.0.0.1:8765/sidepanel.html?article=<id>
const HELPER = "http://127.0.0.1:8765";
const REPS_TARGET = 3;

const $ = (id) => document.getElementById(id);
const inExtension = typeof chrome !== "undefined" && !!(chrome.scripting && chrome.tabs);

const state = { title: "", url: "", sentences: [], helperOk: false, stream: null, recorder: null, recordingIdx: -1 };

// ---------- helper status ----------
async function checkHelper() {
  try {
    const r = await fetch(HELPER + "/health", { cache: "no-store" });
    const j = await r.json();
    state.helperOk = !!j.ok;
    $("status").textContent = `helper: online · voice: edge neural · glosses: ${j.claude ? "claude cli" : "unavailable"}`;
    $("status").className = "status ok";
  } catch (e) {
    state.helperOk = false;
    $("status").textContent = "helper offline (run: python helper/server.py) · falling back to browser voice, no glosses";
    $("status").className = "status bad";
  }
}

// ---------- article loading ----------
async function loadArticle() {
  $("load").disabled = true;
  try {
    let data;
    if (inExtension) data = await extractFromTab();
    else data = await loadStandalone();
    if (!data || !data.sentences || !data.sentences.length) throw new Error("No sentences found on this page.");
    state.title = data.title; state.url = data.url;
    state.sentences = data.sentences.map((text) => ({ text, words: tokenize(text), gloss: null, translation: "", native: {}, mine: null, flags: { listened: false, recorded: false, played: false }, reps: 0 }));
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
  // Prefer the active tab of the focused window, else the most recently used page.
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

// ---------- words & glosses ----------
function tokenize(text) {
  // Keep tokens as displayed; the lookup key strips punctuation and lowercases.
  return text.split(/(\s+)/).filter((t) => t.length).map((t) => ({ raw: t, key: normKey(t), isWord: /[\p{L}\p{N}]/u.test(t) }));
}
function normKey(t) { return t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase(); }

async function fetchGlosses() {
  if (!state.helperOk) return;
  // Small first chunk so the top of the article gets glosses quickly, then bigger chunks, two in flight.
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
      const s = state.sentences[idxs[k]];
      if (!s || !res) return;
      s.translation = res.translation || "";
      const map = new Map();
      for (const [w, g] of res.words || []) {
        const key = normKey(w); if (key && !map.has(key)) map.set(key, g);
        // Multi-word tokens from the model ("Den Haag") also gloss each displayed word.
        if (/\s/.test(key)) for (const part of key.split(/\s+/)) if (part && !map.has(part)) map.set(part, g);
      }
      s.gloss = map;
      const card = document.querySelector(`.card[data-i="${idxs[k]}"] .translation`);
      if (card) card.textContent = s.translation;
    });
  } catch (e) { console.warn("gloss failed", e); }
  updateProgress();
}

// ---------- rendering ----------
function render() {
  $("empty").hidden = true;
  $("article-title").textContent = state.title;
  const ol = $("sentences"); ol.innerHTML = "";
  state.sentences.forEach((s, i) => {
    const li = document.createElement("li"); li.className = "card"; li.dataset.i = i;
    li.innerHTML = `
      <div class="num">${i + 1} / ${state.sentences.length}</div>
      <div class="text">${s.words.map((t) => t.isWord ? `<span class="w" data-key="${escapeHtml(t.key)}">${escapeHtml(t.raw)}</span>` : escapeHtml(t.raw)).join("")}</div>
      <div class="translation">${escapeHtml(s.translation)}</div>
      <div class="controls">
        <button class="native" title="Play native speaker">▶ Native</button>
        <button class="rec" title="Record yourself">● Record</button>
        <button class="mine" title="Play your recording" disabled>▶ Me</button>
        <div class="ring" title="Completed rounds">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span class="steps"><span class="step" data-f="listened">1</span><span class="step" data-f="recorded">2</span><span class="step" data-f="played">3</span></span>
        </div>
      </div>`;
    li.querySelector(".native").addEventListener("click", () => playNative(i));
    li.querySelector(".rec").addEventListener("click", () => toggleRecord(i));
    li.querySelector(".mine").addEventListener("click", () => playMine(i));
    ol.appendChild(li);
  });
  updateProgress();
}

function updateCard(i) {
  const s = state.sentences[i];
  const li = document.querySelector(`.card[data-i="${i}"]`); if (!li) return;
  li.querySelectorAll(".dot").forEach((d, k) => d.classList.toggle("full", k < s.reps));
  li.querySelectorAll(".step").forEach((el) => el.classList.toggle("done", !!s.flags[el.dataset.f]));
  li.querySelector(".mine").disabled = !s.mine;
  li.classList.toggle("done", s.reps >= REPS_TARGET);
  document.querySelectorAll(".card.active").forEach((c) => c.classList.remove("active"));
  li.classList.add("active");
  updateProgress();
}

function updateProgress() {
  const done = state.sentences.filter((s) => s.reps >= REPS_TARGET).length;
  const glossed = state.sentences.filter((s) => s.gloss).length;
  $("progress").textContent = `${done} / ${state.sentences.length} sentences completed (${REPS_TARGET} rounds each) · glosses ready for ${glossed} / ${state.sentences.length}`;
}

function completeStep(i, flag) {
  const s = state.sentences[i];
  s.flags[flag] = true;
  if (s.flags.listened && s.flags.recorded && s.flags.played) {
    s.reps = Math.min(REPS_TARGET, s.reps + 1);
    s.flags = { listened: false, recorded: false, played: false };
  }
  updateCard(i);
}

// ---------- audio: native ----------
let currentAudio = null;
function stopCurrent() { if (currentAudio) { currentAudio.pause(); currentAudio = null; } document.querySelectorAll(".playing").forEach((b) => b.classList.remove("playing")); }

async function playNative(i) {
  const s = state.sentences[i]; const voice = $("voice").value;
  const btn = document.querySelector(`.card[data-i="${i}"] .native`);
  stopCurrent(); btn.classList.add("playing"); updateCard(i);
  if (state.helperOk) {
    try {
      if (!s.native[voice]) {
        const r = await fetch(`${HELPER}/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(s.text)}`);
        if (!r.ok) throw new Error("tts " + r.status);
        s.native[voice] = URL.createObjectURL(await r.blob());
      }
      const a = new Audio(s.native[voice]); currentAudio = a;
      a.onended = () => { btn.classList.remove("playing"); completeStep(i, "listened"); };
      await a.play();
      return;
    } catch (e) { console.warn("helper tts failed, using browser voice", e); }
  }
  // Fallback: browser speech synthesis (quality depends on installed voices).
  const u = new SpeechSynthesisUtterance(s.text); u.lang = "nl-NL";
  const v = speechSynthesis.getVoices().find((v) => /^nl/i.test(v.lang) && /natural|online/i.test(v.name)) || speechSynthesis.getVoices().find((v) => /^nl/i.test(v.lang));
  if (v) u.voice = v;
  u.onend = () => { btn.classList.remove("playing"); completeStep(i, "listened"); };
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

// ---------- audio: record & play back ----------
async function toggleRecord(i) {
  const btn = document.querySelector(`.card[data-i="${i}"] .rec`);
  if (state.recorder && state.recorder.state === "recording") {
    state.recorder.stop();
    return;
  }
  try {
    if (!state.stream) state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) { alert("Microphone access is needed to record: " + e.message); return; }
  stopCurrent();
  const chunks = [];
  const rec = new MediaRecorder(state.stream);
  state.recorder = rec; state.recordingIdx = i;
  rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  rec.onstop = () => {
    const s = state.sentences[i];
    if (s.mine) URL.revokeObjectURL(s.mine);
    s.mine = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    btn.classList.remove("on"); btn.textContent = "● Record";
    state.recorder = null; state.recordingIdx = -1;
    completeStep(i, "recorded");
  };
  rec.start();
  btn.classList.add("on"); btn.textContent = "■ Stop";
  updateCard(i);
}

async function playMine(i) {
  const s = state.sentences[i]; if (!s.mine) return;
  const btn = document.querySelector(`.card[data-i="${i}"] .mine`);
  stopCurrent(); btn.classList.add("playing"); updateCard(i);
  const a = new Audio(s.mine); currentAudio = a;
  a.onended = () => { btn.classList.remove("playing"); completeStep(i, "played"); };
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
// expose for tests
window.__delft = state;
