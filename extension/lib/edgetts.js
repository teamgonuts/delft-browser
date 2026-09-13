// Microsoft Edge "Read Aloud" neural text-to-speech, called directly from the browser.
// Same voices as the edge-tts Python library; protocol ported from it (rany2/edge-tts, MIT).
// Works in extension pages and the MV3 service worker (WebSocket + WebCrypto only).
//
//   const mp3 = await EdgeTTS.synthesize("Ik kom uit Frankrijk.", "nl-NL-FennaNeural"); // -> Blob audio/mpeg
//
// Unofficial endpoint: keep everything about it in this file so it can be swapped for another provider.
const EdgeTTS = (() => {
  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const CHROMIUM_FULL_VERSION = "143.0.3650.75";
  const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
  const WIN_EPOCH = 11644473600;
  let clockSkewSeconds = 0;

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  const uuid = () => crypto.randomUUID().replace(/-/g, "");

  // Sec-MS-GEC: sha256 of (Windows file time rounded down to 5 min + trusted token), upper-case hex.
  async function secMsGec() {
    let ticks = Date.now() / 1000 + clockSkewSeconds + WIN_EPOCH;
    ticks -= ticks % 300;
    const str = `${Math.round(ticks * 1e7)}${TRUSTED_CLIENT_TOKEN}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return hex(digest).toUpperCase();
  }

  const jsDate = () => new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
  const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function ssml(text, voice, rate = "+0%", pitch = "+0Hz", volume = "+0%") {
    return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody></voice></speak>`;
  }

  function parseBinary(buf) {
    const view = new DataView(buf);
    const headerLen = view.getUint16(0);
    const headerText = new TextDecoder().decode(buf.slice(2, 2 + headerLen));
    const headers = {};
    for (const line of headerText.split("\r\n")) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1); }
    return { headers, data: buf.slice(2 + headerLen) };
  }

  async function synthesizeOnce(text, voice, opts = {}) {
    const url = `${WSS_URL}&ConnectionId=${uuid()}&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      const chunks = [];
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; ws.close(); reject(new Error("edge-tts timeout")); } }, opts.timeoutMs || 20000);
      ws.onopen = () => {
        ws.send(`X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
        ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${ssml(text, voice, opts.rate, opts.pitch, opts.volume)}`);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          if (ev.data.includes("Path:turn.end")) { done = true; clearTimeout(timer); ws.close(); resolve(new Blob(chunks, { type: "audio/mpeg" })); }
          return;
        }
        const { headers, data } = parseBinary(ev.data);
        if (headers.Path === "audio" && data.byteLength) chunks.push(data);
      };
      ws.onerror = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error("edge-tts websocket error")); } };
      ws.onclose = (ev) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`edge-tts closed (${ev.code}) before turn.end`)); } };
    });
  }

  // One retry with a fresh token, in case the 5-minute window rolled over mid-request or the clock is skewed.
  async function synthesize(text, voice = "nl-NL-FennaNeural", opts = {}) {
    try { return await synthesizeOnce(text, voice, opts); }
    catch (e) { clockSkewSeconds -= 300; try { return await synthesizeOnce(text, voice, opts); } finally { clockSkewSeconds += 300; } }
  }

  return { synthesize, VOICES: ["nl-NL-FennaNeural", "nl-NL-MaartenNeural", "nl-NL-ColetteNeural", "nl-BE-DenaNeural", "nl-BE-ArnaudNeural"] };
})();
if (typeof self !== "undefined") self.EdgeTTS = EdgeTTS;
