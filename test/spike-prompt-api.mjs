// Spike: can Chrome's built-in Prompt API (Gemini Nano, on-device, no key) gloss words in context?
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SENTENCES = [
  "De Fiod heeft beslag gelegd op twee panden van cardiologen van het OLVG-ziekenhuis in Amsterdam.",
  "Donderdag werd duidelijk dat de Fiod, de opsporingsdienst van de Belastingdienst, acht woningen en bedrijfspanden van cardiologen in Gelderland en Noord-Holland heeft doorzocht.",
  "In ruil daarvoor zouden ze expres de producten van die leveranciers hebben voorgeschreven.",
];
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delft-pa-"));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, userDataDir, args: ["--window-size=900,600", "--enable-features=PromptAPIForGeminiNano,OptimizationGuideOnDeviceModel"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("  page:", m.text()));
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
const t0 = Date.now();
const out = await page.evaluate(async (sentences) => {
  if (!("LanguageModel" in self)) return { error: "LanguageModel (Prompt API) not present" };
  const avail = await LanguageModel.availability();
  if (avail === "unavailable") return { error: "Prompt API unavailable on this device", avail };
  const params = await LanguageModel.params();
  const session = await LanguageModel.create({
    initialPrompts: [{ role: "system", content: "You are a Dutch-to-English glossing engine for a language learner. Output only JSON." }],
    monitor(m) { m.addEventListener("downloadprogress", (e) => console.log("download " + Math.round(e.loaded * 100) + "%")); },
  });
  const res = [];
  for (const s of sentences) {
    const t1 = performance.now();
    const prompt = `For this Dutch sentence give a natural English translation and, for every word in order, a short English gloss (1-5 words) of its meaning IN THIS CONTEXT; for inflected verbs add the infinitive in parentheses.\nSentence: ${s}\nOutput JSON: {"translation":"...","words":[["word","gloss"],...]}`;
    let text = await session.prompt(prompt);
    res.push({ raw: text, ms: Math.round(performance.now() - t1) });
  }
  return { avail, params, res };
}, SENTENCES);
await browser.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
console.log("availability:", out.avail, "| total", Date.now() - t0, "ms");
if (out.error) { console.log(out.error); process.exit(1); }
console.log("params:", JSON.stringify(out.params));
out.res.forEach((r, i) => { console.log(`\n=== ${SENTENCES[i]}\n[${r.ms} ms]\n${r.raw}`); });
fs.writeFileSync("test/out/spike-prompt-api.json", JSON.stringify(out, null, 2));
