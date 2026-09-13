// End-to-end proof: load the real extension into Chrome, open a Dutch article, and drive the side panel
// through the full Delft loop on the first phrase (listen -> record -> play back -> hover gloss).
// No helper process, no keys: this is exactly what a fresh install does.
//
//   node test/e2e.mjs [articleUrl]
//
// Requires: Chrome installed, `npm install` in test/.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "..", "extension");
const OUT = path.resolve(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const URL_ = process.argv[2] || "https://www.parool.nl/amsterdam/onderzoek-naar-corruptie-beslag-gelegd-op-twee-panden-van-cardiologen-olvg~ba3d9c94/";
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH || "",
].find((p) => p && fs.existsSync(p));
if (!CHROME) throw new Error("Chrome not found; set CHROME_PATH");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { url: URL_, steps: {} };

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delft-e2e-"));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : "new",
  userDataDir,
  enableExtensions: true,
  pipe: true,
  args: [
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required", "--lang=nl-NL", "--window-size=1400,1000",
  ],
});

try {
  // ---- 1. article page + consent wall ----
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
  await sleep(1000);
  log("landed on", page.url());
  // DPG Media privacy gate (parool.nl, volkskrant.nl, ad.nl, ...). This runs in a throw-away profile that is
  // deleted at the end of the test. We try the "Instellen" -> decline route first and only fall back to "Akkoord".
  const clickButton = async (res) => page.evaluate((srcs) => {
    const btns = [];
    const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) walk(el.shadowRoot); if (el.matches("button, a[role=button], input[type=submit]")) btns.push(el); } };
    walk(document);
    for (const src of srcs) {
      const re = new RegExp(src, "i");
      const b = btns.find((b) => re.test((b.innerText || b.value || "").trim()));
      if (b) { b.click(); return (b.innerText || b.value || "").trim(); }
    }
    return null;
  }, res);
  if (/consent|privacy/i.test(page.url())) {
    await page.waitForSelector("pierce/button", { timeout: 20000 }).catch(() => {});
    const trail = [];
    let c = await clickButton(["weiger", "alleen noodzakelijk", "^instellen$"]);
    if (c) { trail.push(c); await sleep(2500); c = await clickButton(["weiger alles", "alles weigeren", "weiger", "opslaan", "bevestig"]); if (c) trail.push(c); }
    await sleep(2500);
    if (/consent|privacy/i.test(page.url())) { c = await clickButton(["^akkoord$", "accepteer", "^accept", "agree"]); if (c) trail.push(c); }
    report.steps.consentClicked = trail;
    log("consent buttons clicked:", trail);
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(2000);
  }
  for (let i = 0; i < 2 && /consent|privacy/i.test(page.url()); i++) {
    await sleep(2000);
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  }
  log("article page:", page.url());
  report.steps.articleUrl = page.url();
  await page.screenshot({ path: path.join(OUT, "article.png") });

  // ---- 2. the extension's side panel, opened as a tab ----
  const extId = await browser.installExtension(EXT);
  report.extensionId = extId;
  log("extension id", extId);
  const panel = await browser.newPage();
  await panel.setViewport({ width: 420, height: 900 });
  panel.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") log("panel console:", m.text()); });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: "load" });
  await sleep(500);

  // ---- 3. extract article, split into phrases (synchronous, rule-based) ----
  await panel.click("#load");
  await panel.waitForFunction(() => document.querySelectorAll(".card").length > 0 || (!document.getElementById("empty").hidden && /Could not/.test(document.getElementById("empty").textContent)), { timeout: 30000 });
  const sentences = await panel.evaluate(() => window.__delft.sentences.map((s) => s.text));
  if (!sentences.length) throw new Error("extraction failed: " + (await panel.$eval("#empty", (e) => e.textContent)));
  report.steps.title = await panel.$eval("#article-title", (e) => e.textContent);
  report.steps.sentenceCount = sentences.length;
  report.steps.firstSentences = sentences.slice(0, 5);
  log(`extracted ${sentences.length} sentences from "${report.steps.title}"`);
  fs.writeFileSync(path.join(OUT, "article.json"), JSON.stringify({ title: report.steps.title, url: page.url(), sentences }, null, 2));
  report.steps.phrases = await panel.evaluate(() => window.__delft.sentences.map((s) => s.phrases));
  const split = report.steps.phrases.filter((p) => p.length > 1).length;
  report.steps.cards = await panel.evaluate(() => document.querySelectorAll(".card").length);
  log(`phrases: ${split} of ${sentences.length} sentences split, ${report.steps.cards} practice boxes`);
  await panel.screenshot({ path: path.join(OUT, "panel-loaded.png") });

  // ---- 4. listen (Edge neural voice, straight from the extension) ----
  // Preload should already have the first clips; measure click -> playback start.
  await panel.waitForFunction(() => !!window.__delft.sentences[0].items[0].native[document.getElementById("voice").value], { timeout: 30000 }).catch(() => {});
  report.steps.preloadedAtClick = await panel.evaluate(() => window.__delft.sentences.flatMap((s) => s.items).filter((it) => Object.keys(it.native).length).length);
  const t0 = Date.now();
  await panel.click('.card[data-i="0"][data-j="0"] .native');
  await panel.waitForFunction(() => document.querySelector('.card[data-i="0"][data-j="0"] .native').classList.contains("playing") && !document.querySelector('.card[data-i="0"][data-j="0"] .native').classList.contains("loading"), { timeout: 30000 });
  report.steps.clickToPlayMs = Date.now() - t0;
  log(`click -> playing in ${report.steps.clickToPlayMs} ms (${report.steps.preloadedAtClick} clips preloaded at click time)`);
  await panel.waitForFunction(() => window.__delft.sentences[0].items[0].flags.listened === true, { timeout: 40000 });
  report.steps.listenedMs = Date.now() - t0;
  report.steps.voiceMode = await panel.evaluate(() => window.__delft.voiceMode);
  log(`native playback finished after ${report.steps.listenedMs} ms via ${report.steps.voiceMode}`);
  if (report.steps.voiceMode !== "edge") throw new Error("Edge voice did not work; fell back to " + report.steps.voiceMode);

  const tp = Date.now();
  await panel.waitForFunction(() => window.__delft.sentences.flatMap((s) => s.items).every((it) => Object.keys(it.native).length), { timeout: 120000 }).catch(() => {});
  report.steps.allPreloadedMs = Date.now() - tp + report.steps.listenedMs;
  log(`all ${report.steps.cards} clips preloaded ~${report.steps.allPreloadedMs} ms after load`);

  // ---- 5. record (fake mic) ----
  await panel.click('.card[data-i="0"][data-j="0"] .rec');
  await panel.waitForFunction(() => document.querySelector('.card[data-i="0"][data-j="0"] .rec').classList.contains("on"), { timeout: 10000 });
  await sleep(1800);
  await panel.click('.card[data-i="0"][data-j="0"] .rec');
  await panel.waitForFunction(() => !!window.__delft.sentences[0].items[0].mine, { timeout: 10000 });
  report.steps.recorded = true;
  log("recorded a take; blob url present");

  // ---- 6. play back own recording -> completes round 1 ----
  await panel.click('.card[data-i="0"][data-j="0"] .mine');
  await panel.waitForFunction(() => window.__delft.sentences[0].items[0].reps === 1, { timeout: 15000 });
  report.steps.repsAfterOneRound = 1;
  log("round 1 complete (ring dot filled)");

  // ---- 7. word hover gloss (dictionary + on-device Translator) ----
  const glossStart = Date.now();
  const words = await panel.$$('.card[data-i="0"][data-j="0"] .w');
  const hovered = [];
  for (const w of words.slice(0, 6)) {
    await w.hover();
    await panel.waitForFunction(() => { const t = document.getElementById("tooltip"); return !t.hidden && !t.classList.contains("pending"); }, { timeout: 60000 }).catch(() => {});
    hovered.push(await panel.$eval("#tooltip", (e) => e.textContent));
  }
  report.steps.glossWaitMs = Date.now() - glossStart;
  report.steps.hoverGlosses = hovered;
  report.steps.translatorStatus = await panel.evaluate(() => Glosses.status);
  log("hover glosses:", hovered, "| translator:", report.steps.translatorStatus);
  await words[3].hover();
  await sleep(300);
  await panel.screenshot({ path: path.join(OUT, "panel-hover.png") });
  await panel.evaluate(() => document.querySelector('.card[data-i="2"][data-j="0"]').scrollIntoView());
  await panel.screenshot({ path: path.join(OUT, "panel-phrases.png") });
  await panel.screenshot({ path: path.join(OUT, "panel-full.png"), fullPage: true });

  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = String(e && e.stack || e);
  log("FAILED:", report.error);
} finally {
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: report.ok, ...report.steps, error: report.error }, null, 2));
process.exit(report.ok ? 0 : 1);
