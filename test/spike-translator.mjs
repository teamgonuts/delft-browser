// Spike: can Chrome's built-in Translator API (on-device, no key) produce usable nl->en glosses?
// Compares against the Claude glosses cached by the helper for the same sentences.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SENTENCES = [
  "De Fiod heeft beslag gelegd op twee panden van cardiologen van het OLVG-ziekenhuis in Amsterdam.",
  "Donderdag werd duidelijk dat de Fiod, de opsporingsdienst van de Belastingdienst, acht woningen en bedrijfspanden van cardiologen in Gelderland en Noord-Holland heeft doorzocht.",
  "In ruil daarvoor zouden ze expres de producten van die leveranciers hebben voorgeschreven.",
];
const sha = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");
const claude = SENTENCES.map((s) => { const p = path.resolve("helper/cache/gloss", sha(s) + ".json"); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delft-tr-"));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, userDataDir, args: ["--window-size=900,600"] });
const page = await browser.newPage();
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
const t0 = Date.now();
const out = await page.evaluate(async (sentences) => {
  if (!("Translator" in self)) return { error: "Translator API not present" };
  const opts = { sourceLanguage: "nl", targetLanguage: "en" };
  const avail = await Translator.availability(opts);
  const tr = await Translator.create({ ...opts, monitor(m) { m.addEventListener("downloadprogress", (e) => console.log("download", e.loaded)); } });
  const res = [];
  for (const s of sentences) {
    const t1 = performance.now();
    const translation = await tr.translate(s);
    const words = s.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
    const glosses = [];
    for (const w of words) glosses.push([w, await tr.translate(w)]);
    res.push({ translation, glosses, ms: Math.round(performance.now() - t1) });
  }
  return { avail, res };
}, SENTENCES);
await browser.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
console.log("availability before create:", out.avail, "| total", Date.now() - t0, "ms");
if (out.error) { console.log(out.error); process.exit(1); }
out.res.forEach((r, i) => {
  console.log(`\n=== ${SENTENCES[i]}\n[${r.ms} ms]`);
  console.log("Translator:", r.translation);
  console.log("Claude:    ", claude[i]?.translation);
  const cmap = new Map((claude[i]?.words || []).map(([w, g]) => [w.toLowerCase(), g]));
  console.log("\nword | Translator | Claude");
  for (const [w, g] of r.glosses) console.log(`${w} | ${g} | ${cmap.get(w.toLowerCase()) ?? ""}`);
});
fs.writeFileSync("test/out/spike-translator.json", JSON.stringify({ sentences: SENTENCES, translator: out.res, claude }, null, 2));
