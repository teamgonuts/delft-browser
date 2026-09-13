// Spike: does Edge neural TTS work from inside the extension (chrome-extension:// origin), no helper?
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "..", "extension");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delft-tts-"));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: process.env.HEADFUL ? false : "new", userDataDir, enableExtensions: true, pipe: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const extId = await browser.installExtension(EXT);
  const page = await browser.newPage();
  page.on("console", (m) => console.log("  page:", m.text()));
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: "load" });
  await page.addScriptTag({ url: `chrome-extension://${extId}/lib/edgetts.js` });
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    const blob = await EdgeTTS.synthesize("De Fiod heeft beslag gelegd op twee panden van cardiologen van het OLVG-ziekenhuis in Amsterdam.", "nl-NL-FennaNeural");
    const ms = Math.round(performance.now() - t0);
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    const dur = await new Promise((res) => { a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(-1); });
    const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(blob); });
    return { bytes: blob.size, ms, durationSec: dur, b64 };
  });
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", "spike-edgetts.mp3"), Buffer.from(r.b64, "base64"));
  console.log(JSON.stringify({ bytes: r.bytes, ms: r.ms, durationSec: r.durationSec }));
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
