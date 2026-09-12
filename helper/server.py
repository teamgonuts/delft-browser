"""Delft Browser local helper.

Runs on http://127.0.0.1:8765 and gives the extension two things it cannot do alone:

  GET  /tts?text=...&voice=nl-NL-FennaNeural   -> audio/mpeg, Microsoft Edge neural voice (free, via edge-tts)
  POST /gloss {"sentences": [...]}              -> per-sentence English translation + word glosses,
                                                   produced by the local `claude` CLI (uses your Claude subscription)
  GET  /health                                  -> {"ok": true, "claude": "<path or null>"}
  POST /articles {title,url,sentences} / GET /articles/<id>   -> standalone-mode article store
  GET  /<file>                                  -> serves ../extension so the panel can run outside the extension

No API keys. Everything is cached on disk under helper/cache/.

Run:  python helper/server.py
Deps: pip install edge-tts
"""
import asyncio
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import edge_tts
except ImportError:  # pragma: no cover
    print("Missing dependency: pip install edge-tts", file=sys.stderr)
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXT_DIR = os.path.join(ROOT, "extension")
CACHE = os.path.join(HERE, "cache")
TTS_CACHE = os.path.join(CACHE, "tts")
GLOSS_CACHE = os.path.join(CACHE, "gloss")
ARTICLES = os.path.join(CACHE, "articles")
for d in (TTS_CACHE, GLOSS_CACHE, ARTICLES):
    os.makedirs(d, exist_ok=True)

PORT = int(os.environ.get("DELFT_PORT", "8765"))
CLAUDE_MODEL = os.environ.get("DELFT_CLAUDE_MODEL", "sonnet")
DEFAULT_VOICE = "nl-NL-FennaNeural"
ALLOWED_VOICES = {"nl-NL-FennaNeural", "nl-NL-MaartenNeural", "nl-NL-ColetteNeural", "nl-BE-DenaNeural", "nl-BE-ArnaudNeural"}
CLAUDE_SEM = threading.Semaphore(2)


def find_claude():
    """Locate a Claude Code CLI: env override, PATH, then the copy bundled with the Claude desktop app."""
    env = os.environ.get("DELFT_CLAUDE_BIN")
    if env and os.path.exists(env):
        return env
    # Prefer the native binary bundled with the Claude desktop app: a .CMD shim on Windows
    # mangles long multi-line arguments and is noticeably slower to start.
    appdata = os.environ.get("APPDATA", "")
    bundled = sorted(glob.glob(os.path.join(appdata, "Claude", "claude-code", "*", "claude.exe")))
    if bundled:
        return bundled[-1]
    for name in ("claude", "claude.exe", "claude.cmd"):
        p = shutil.which(name)
        if p:
            return p
    return None


CLAUDE_BIN = find_claude()


def sha(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


# ---------------- TTS ----------------
def synthesize(text: str, voice: str) -> bytes:
    path = os.path.join(TTS_CACHE, f"{sha(voice + '|' + text)}.mp3")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()

    async def run():
        comm = edge_tts.Communicate(text, voice)
        buf = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    data = asyncio.run(run())
    with open(path, "wb") as f:
        f.write(data)
    return data


# ---------------- Glosses via Claude CLI ----------------
GLOSS_SYSTEM = "You are a Dutch-to-English glossing engine for a language learner. You output only JSON, never prose, never markdown fences."

GLOSS_PROMPT = """You are a Dutch-to-English glossing engine for a language learner using the Delft method.
For each numbered Dutch sentence below, produce:
  - "translation": a natural English translation of the whole sentence
  - "words": every word token of the sentence, in order, each as [token, gloss]. The token must be the word exactly
    as written (without surrounding punctuation). The gloss is 1-5 English words giving the meaning IN THIS CONTEXT.
    For inflected forms also give the base, e.g. ["gelegd", "laid (leggen = to lay)"]. For a separable verb note the
    full verb, e.g. ["beslag", "seizure (beslag leggen op = to seize)"]. Names and numbers get a short note like "name".
  - "phrases": the sentence cut into speakable pieces for a learner to repeat aloud, as a list of strings that
    concatenate (with single spaces) back to the exact original sentence. Rules:
      * A sentence of about 13 words or fewer stays whole: one phrase.
      * Longer sentences split first at commas (the comma stays at the end of the piece), then at clause
        boundaries before "dat", "die", "zodra", "omdat", "terwijl" and similar. Only if a piece would still be
        longer than about 14 words, split it before a prepositional phrase.
      * Aim for pieces of 6 to 12 words. Never split a verb cluster from its object ("beslag heeft gelegd" stays
        together). Never make a piece shorter than 3 words unless it is a comma-delimited tail like
        "schrijft het ziekenhuis."
      * Headings and quotes follow the same rules.

Output ONLY a JSON array, no prose, no markdown fences:
[{"i": 0, "translation": "...", "words": [["Onderzoek", "investigation"], ...], "phrases": ["...", "..."]}, ...]

Sentences:
"""


def extract_json_array(text: str):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start = text.find("[")
    if start < 0:
        raise ValueError("no JSON array in claude output")
    depth = 0
    in_str = False
    esc = False
    for idx in range(start, len(text)):
        ch = text[idx]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:idx + 1])
    raise ValueError("unterminated JSON array")


def claude_gloss(sentences):
    """Ask the local claude CLI to gloss a batch. Returns list aligned with `sentences` (None on failure)."""
    if not CLAUDE_BIN:
        return [None] * len(sentences)
    prompt = GLOSS_PROMPT + "\n".join(f"{i}. {s}" for i, s in enumerate(sentences))
    # Prompt goes over stdin (robust for long multi-line text); a minimal system prompt replaces the
    # coding-assistant default and all tools are disabled so the call is cheap and returns pure JSON.
    cmd = [CLAUDE_BIN, "-p", "--output-format", "json", "--model", CLAUDE_MODEL, "--tools", "",
           "--system-prompt", GLOSS_SYSTEM, "--setting-sources", ""]
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)  # allow running from inside another Claude Code session
    with CLAUDE_SEM:
        try:
            proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                  timeout=240, cwd=tempfile.gettempdir(), env=env)
        except subprocess.TimeoutExpired:
            print("[gloss] claude timed out", file=sys.stderr)
            return [None] * len(sentences)
    if proc.returncode != 0:
        print("[gloss] claude failed:", proc.stderr[-500:], file=sys.stderr)
        return [None] * len(sentences)
    try:
        outer = json.loads(proc.stdout)
        result_text = outer.get("result", "") if isinstance(outer, dict) else proc.stdout
        arr = extract_json_array(result_text)
    except Exception as e:  # noqa: BLE001
        print("[gloss] could not parse claude output:", e, proc.stdout[:300], file=sys.stderr)
        return [None] * len(sentences)
    out = [None] * len(sentences)
    for item in arr:
        try:
            i = int(item.get("i"))
            if 0 <= i < len(sentences):
                phrases = [str(x).strip() for x in item.get("phrases", []) if str(x).strip()]
                if " ".join(phrases).replace("  ", " ") != sentences[i].strip():
                    phrases = [sentences[i]]  # model drifted from the original text: keep the sentence whole
                out[i] = {"translation": item.get("translation", ""), "words": item.get("words", []), "phrases": phrases}
        except Exception:  # noqa: BLE001
            continue
    return out


def gloss_sentences(sentences):
    results = [None] * len(sentences)
    todo = []
    for i, s in enumerate(sentences):
        p = os.path.join(GLOSS_CACHE, f"{sha(s)}.json")
        cached = None
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                cached = json.load(f)
        if cached and cached.get("phrases"):
            results[i] = cached
        else:
            todo.append(i)
    if todo:
        fresh = claude_gloss([sentences[i] for i in todo])
        for k, i in enumerate(todo):
            if fresh[k]:
                results[i] = fresh[k]
                with open(os.path.join(GLOSS_CACHE, f"{sha(sentences[i])}.json"), "w", encoding="utf-8") as f:
                    json.dump(fresh[k], f, ensure_ascii=False)
    return results


# ---------------- HTTP ----------------
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json", ".png": "image/png"}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data, ctype, status=200):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            return self._json({"ok": True, "tts": "edge-tts", "claude": CLAUDE_BIN, "model": CLAUDE_MODEL})
        if u.path == "/tts":
            text = (q.get("text") or [""])[0].strip()
            voice = (q.get("voice") or [DEFAULT_VOICE])[0]
            if voice not in ALLOWED_VOICES:
                voice = DEFAULT_VOICE
            if not text:
                return self._json({"error": "text required"}, 400)
            try:
                return self._bytes(synthesize(text[:1000], voice), "audio/mpeg")
            except Exception as e:  # noqa: BLE001
                return self._json({"error": f"tts failed: {e}"}, 502)
        if u.path.startswith("/articles/"):
            aid = re.sub(r"[^a-f0-9]", "", u.path.split("/")[-1])
            p = os.path.join(ARTICLES, f"{aid}.json")
            if not os.path.exists(p):
                return self._json({"error": "not found"}, 404)
            with open(p, "rb") as f:
                return self._bytes(f.read(), "application/json; charset=utf-8")
        # static: serve the extension folder so the panel can run standalone
        rel = "sidepanel.html" if u.path in ("/", "/panel.html") else u.path.lstrip("/")
        full = os.path.normpath(os.path.join(EXT_DIR, rel))
        if not full.startswith(EXT_DIR) or not os.path.isfile(full):
            return self._json({"error": "not found"}, 404)
        with open(full, "rb") as f:
            return self._bytes(f.read(), MIME.get(os.path.splitext(full)[1], "application/octet-stream"))

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        if u.path == "/gloss":
            sents = [str(s) for s in body.get("sentences", [])][:20]
            return self._json({"results": gloss_sentences(sents)})
        if u.path == "/articles":
            aid = sha(json.dumps(body, sort_keys=True))[:12]
            with open(os.path.join(ARTICLES, f"{aid}.json"), "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False)
            return self._json({"id": aid, "url": f"http://127.0.0.1:{PORT}/sidepanel.html?article={aid}"})
        return self._json({"error": "not found"}, 404)

    def log_message(self, fmt, *args):  # quieter log
        sys.stderr.write("[helper] %s\n" % (fmt % args))


if __name__ == "__main__":
    print(f"Delft helper on http://127.0.0.1:{PORT}  voice=edge-tts  claude={CLAUDE_BIN or 'NOT FOUND'} model={CLAUDE_MODEL}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
