// Delft Browser side panel. Everything runs inside the extension: no helper, no keys.
//   article  -> content script (Readability) via chrome.scripting
//   phrases  -> lib/splitter.js (rules)
//   voice    -> lib/edgetts.js (Microsoft Edge neural voices), fallback chrome.tts
//   glosses  -> lib/dictionary.js then Chrome's on-device Translator API (lib/glosses.js)
const REPS_TARGET = 3;
const $ = (id) => document.getElementById(id);
const inExtension = typeof chrome !== "undefined" && !!(chrome.scripting && chrome.tabs);

const state = { title: "", url: "", sentences: [], stream: null, recorder: null, voiceMode: "edge" };

function setStatus(text, bad = false) { const el = $("status"); el.textContent = text; el.className = "status " + (bad ? "bad" : "ok"); el.hidden = !text; }

// ---------- article loading ----------
function newItem(text) { return { text, native: {}, mine: null, flags: { listened: false, recorded: false, played: false }, reps: 0 }; }

async function loadArticle() {
  $("load").disabled = true;
  setStatus("");
  Glosses.translator(); // synchronously inside the click: a first-time model download needs a user gesture
  try {
    const data = await extractFromTab();
    if (!data || !data.sentences || !data.sentences.length) throw new Error("No sentences found on this page.");
    state.title = data.title; state.url = data.url;
    state.sentences = data.sentences.map((text) => ({ text, phrases: Splitter.split(text), items: Splitter.split(text).map(newItem) }));
    render();
    preloadAudio();
    prefetchGlosses();
  } catch (e) {
    $("empty").hidden = false;
    $("empty").innerHTML = "Could not load: " + escapeHtml(e.message || String(e));
  } finally { $("load").disabled = false; }
}

async function extractFromTab() {
  if (!inExtension) throw new Error("Open this panel from the extension toolbar button.");
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((t) => /^https?:/.test(t.url || ""));
  if (!candidates.length) throw new Error("No web page tab found.");
  let tab = candidates.find((t) => t.active && t.lastFocusedWindow) || candidates.find((t) => t.active);
  if (!tab) tab = candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["vendor/Readability.js", "content/extract.js"] });
  return results && results[0] && results[0].result;
}

// ---------- glosses ----------
const tokenize = (text) => text.split(/(\s+)/).filter((t) => t.length).map((t) => ({ raw: t, key: Glosses.normKey(t), isWord: /[\p{L}\p{N}]/u.test(t) }));

async function prefetchGlosses() {
  // Warm the gloss cache in reading order. Dictionary words are free; the rest go through the translator.
  await Glosses.translator();
  for (const s of state.sentences) {
    for (const it of s.items) for (const t of tokenize(it.text)) if (t.isWord) { try { await Glosses.wordGloss(t.raw, s.text); } catch (e) { /* ignore */ } }
  }
}

// ---------- rendering ----------
function render() {
  $("empty").hidden = true;
  $("article-title").textContent = state.title;
  const ol = $("sentences"); ol.innerHTML = "";
  state.sentences.forEach((s, i) => {
    const li = document.createElement("li"); li.className = "sentence"; li.dataset.i = i;
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
    ol.appendChild(li);
  });
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
function stopCurrent() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (inExtension && chrome.tts) chrome.tts.stop();
  document.querySelectorAll(".playing").forEach((b) => b.classList.remove("playing"));
}

// Clip for one item: memory -> IndexedDB -> Edge TTS. One in-flight promise per item+voice, so a click on an
// item that the preloader is already fetching just waits for that same request.
const inflight = new Map();
function getNative(it, voice) {
  if (it.native[voice]) return Promise.resolve(it.native[voice]);
  const k = voice + "|" + it.text;
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    let blob = await AudioCache.get(voice, it.text);
    if (!blob) { blob = await EdgeTTS.synthesize(it.text, voice); AudioCache.put(voice, it.text, blob); }
    it.native[voice] = URL.createObjectURL(blob);
    return it.native[voice];
  })();
  inflight.set(k, p);
  p.finally(() => inflight.delete(k));
  return p;
}

// Preload every phrase in reading order as soon as the article is loaded, two connections at a time.
let preloadGen = 0;
async function preloadAudio() {
  const gen = ++preloadGen; const voice = $("voice").value;
  const queue = state.sentences.flatMap((s) => s.items);
  const worker = async () => {
    while (queue.length && gen === preloadGen) {
      const it = queue.shift();
      try { await getNative(it, voice); } catch (e) { console.warn("preload failed", e); }
    }
  };
  await Promise.all([worker(), worker()]);
}
$("voice").addEventListener("change", () => { if (state.sentences.length) preloadAudio(); });

async function playNative(i, j) {
  const it = state.sentences[i].items[j]; const voice = $("voice").value;
  const btn = rowEl(i, j).querySelector(".native");
  stopCurrent(); btn.classList.add("playing"); updateRow(i, j);
  const finish = () => { btn.classList.remove("playing"); completeStep(i, j, "listened"); };
  try {
    if (!it.native[voice]) btn.classList.add("loading");
    const url = await getNative(it, voice);
    btn.classList.remove("loading");
    const a = new Audio(url); currentAudio = a;
    a.onended = finish;
    await a.play();
    state.voiceMode = "edge";
    return;
  } catch (e) {
    console.warn("Edge voice failed, using Chrome's built-in voice", e);
    btn.classList.remove("loading");
  }
  // Fallback: Chrome's OS voice. Quality depends on the Dutch voice installed on the machine.
  state.voiceMode = "chrome";
  setStatus("online voice unavailable, using this computer's Dutch voice", true);
  if (inExtension && chrome.tts) {
    chrome.tts.speak(it.text, { lang: "nl-NL", onEvent: (ev) => { if (ev.type === "end") finish(); if (ev.type === "error") btn.classList.remove("playing"); } });
  } else {
    const u = new SpeechSynthesisUtterance(it.text); u.lang = "nl-NL"; u.onend = finish;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
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
      setStatus("allow the microphone in the tab that just opened, then press Record again", true);
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
let tipSeq = 0;
document.addEventListener("mouseover", async (ev) => {
  const w = ev.target.closest && ev.target.closest(".w"); if (!w) return;
  const card = w.closest(".card"); const s = state.sentences[+card.dataset.i];
  const seq = ++tipSeq;
  const show = (g, pending) => {
    tip.innerHTML = `<span class="src">${escapeHtml(w.textContent)}</span>${escapeHtml(g)}`;
    tip.classList.toggle("pending", pending); tip.hidden = false; positionTip(ev);
  };
  show("…", true);
  let g = null;
  try { g = await Glosses.wordGloss(w.textContent, s.text); } catch (e) { /* ignore */ }
  if (seq !== tipSeq) return;
  show(g || (Glosses.status === "downloading" ? "downloading translator…" : "(no gloss)"), !g);
});
document.addEventListener("mousemove", (ev) => { if (!tip.hidden) positionTip(ev); });
document.addEventListener("mouseout", (ev) => { if (ev.target.closest && ev.target.closest(".w")) { tip.hidden = true; tipSeq++; } });
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
// Any click in the panel is a user gesture: retry a pending translator download.
document.addEventListener("click", () => { if (!["ready", "missing", "downloading"].includes(Glosses.status)) Glosses.translator(); }, true);
Glosses.onStatus((st, progress) => {
  if (st === "downloading") setStatus(`downloading Dutch-English translator… ${Math.round(progress * 100)}%`);
  else if (st === "needs-gesture") setStatus("click anywhere to download the Dutch-English translator (one time)", true);
  else if (st === "missing" || st === "failed") setStatus("on-device translator unavailable, using online translation");
  else setStatus("");
});
setStatus("");
window.__delft = state;
