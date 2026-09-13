# Delft Browser

Learn Dutch the Delft way on any web page. Open a Dutch news article, click the extension, and the side panel turns it into short phrases you can practise one at a time:

1. **▶ Native** plays the phrase in a natural Dutch voice
2. **● Record** records you saying it
3. **▶ Me** plays your take back so you can compare

Three full rounds fill the dots. Hover any word for its English meaning.

No account, no API keys, no server. Everything runs inside Chrome.

## Install (Chrome)

1. Download the latest `delft-browser-<version>.zip` from [Releases](https://github.com/teamgonuts/delft-browser/releases) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, pick the unzipped folder.
3. Click the puzzle-piece icon in the toolbar and pin **Delft Browser**.

Chrome 138 or newer. The first hover downloads Chrome's Dutch-English translation model once (a few seconds).

## Use

- Open a Dutch article, click the Delft Browser icon, press **Load article from this tab**.
- The first time you press **Record**, a tab opens asking for microphone access. Allow it once.
- Pick a voice at the top (Maarten by default; also Fenna, Colette, Dena). Clips for the whole article preload in the background, so playback is instant once the top of the list has loaded.

## How it works

| Piece | Where it runs |
|---|---|
| Article extraction | Mozilla Readability in a content script |
| Phrase splitting | `extension/lib/splitter.js`, deterministic rules: short sentences stay whole, long ones cut at commas, then before *dat/die/zodra…*, then before a preposition |
| Native voice | Microsoft Edge "Read Aloud" neural voices, called over WebSocket from the extension (`extension/lib/edgetts.js`). Falls back to Chrome's built-in Dutch voice if that endpoint is unreachable. |
| Word glosses | A bundled mini-dictionary for function words, pronoun-adverbs and separable verbs, then Chrome's on-device Translator API (`extension/lib/glosses.js`) |
| Recording | MediaRecorder in the side panel |

## Development

```bash
node test/splitter.test.mjs        # phrase splitter against the 18 approved Parool splits
cd test && npm install && cd ..
node test/e2e.mjs [articleUrl]     # loads the extension into a throw-away Chrome and runs the full loop
node build.mjs                     # dist/delft-browser-<version>.zip
```

`helper/` is the Milestone 1 proof-of-concept server (Claude-generated glosses). The extension no longer uses it; it is kept only for comparing gloss quality.

Project notes (plans, results, decisions) live in the wiki, see [NOTES.md](NOTES.md).
