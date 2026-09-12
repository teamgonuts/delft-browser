# Delft Browser

Delft-method language practice on any web page. Open a Dutch article, and the extension's side panel
breaks it into sentences. For each sentence you can:

1. **Listen** to a native-sounding Dutch voice
2. **Record** yourself saying it
3. **Play back** your own take and compare

Three full rounds per sentence fills its ring. Hover any word for an English gloss in context, and see a
full-sentence translation under each line.

No API keys. Voices come from Microsoft's free Edge neural voices (via `edge-tts`), glosses come from
your Claude subscription through the local `claude` CLI.

**Status: Milestone 1, proof of concept.** Verified end to end on a real Parool article, see
[NOTES.md](NOTES.md) for the wiki links with plan and results.

## Layout

```
extension/   Chrome extension (Manifest V3, no build step)
  manifest.json, background.js        side panel wiring
  content/extract.js                  Readability + Intl.Segmenter -> sentences
  sidepanel.html/.css/.js             the practice UI
  vendor/Readability.js               Mozilla Readability 0.6.0
helper/      local helper, python stdlib + edge-tts
  server.py                           /tts, /gloss, /health, /articles, static
test/        puppeteer end-to-end proof (loads the real extension into Chrome)
```

## Run it

1. Helper (once per session):

```bash
pip install -r helper/requirements.txt
python helper/server.py
```

   It listens on `http://127.0.0.1:8765`. It finds the Claude CLI automatically: the copy bundled with the
   Claude desktop app (`%APPDATA%\Claude\claude-code\<version>\claude.exe`), or `claude` on your PATH.
   Override with `DELFT_CLAUDE_BIN`. Model defaults to `sonnet`, override with `DELFT_CLAUDE_MODEL`.

2. Extension: open `chrome://extensions`, enable Developer mode, **Load unpacked**, pick the `extension/`
   folder. Pin the icon.

3. Open a Dutch article, click the icon to open the side panel, press **Load article from this tab**.
   Allow the microphone the first time you press Record.

Without the helper the panel still works: it falls back to the browser's built-in Dutch voice
(quality depends on what Windows has installed) and shows no glosses.

## Standalone mode

The helper also serves the panel outside the extension, useful for debugging:
`POST /articles` with `{title, url, sentences}` returns a URL like
`http://127.0.0.1:8765/sidepanel.html?article=<id>`.

## End-to-end test

```bash
cd test && npm install && node test/e2e.mjs
```

Launches Chrome with the extension loaded (headless, fake microphone), opens the Parool test article,
extracts sentences, plays the native voice, records, plays back, waits for glosses and hovers words.
Writes screenshots and `report.json` to `test/out/`. Set `HEADFUL=1` to watch it; in headful mode the
DPG Media consent gate appears and the test tries the decline route before falling back to accept, in a
throw-away profile that is deleted afterwards.

## How it works

- **Extraction** runs in the page: Readability finds the article, block elements keep paragraph
  boundaries, `Intl.Segmenter('nl')` splits sentences, unpunctuated non-heading fragments (bylines,
  reading time) are dropped.
- **Native audio**: `GET /tts?text=…&voice=nl-NL-FennaNeural` streams an MP3 from Edge's neural voice
  service, cached on disk. Fenna, Maarten, Colette (NL) and Dena (BE) are selectable.
- **Glosses**: `POST /gloss {sentences}` runs `claude -p` with a minimal system prompt, no tools, and the
  sentences on stdin, returning per-sentence translation plus `[token, gloss]` pairs. Cached per
  sentence. The panel requests a small first batch so the top of the article is ready in a few seconds.
- **Recording**: MediaRecorder in the side panel, one blob per sentence, in memory only.
